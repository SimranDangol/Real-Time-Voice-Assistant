import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";
import { createDeepgramASR, type ASRHandle } from "../providers/asr.deepgram.js";
import { streamAssistantReply } from "../providers/llm.js";
import { SentenceChunker } from "../pipeline/chunker.js";
import { TurnTimer } from "../metrics.js";
import { createCartesiaTTS, type CartesiaTTSHandle } from "../providers/tts.cartesia.js";
import { createElevenLabsTTS, type ElevenLabsTTSHandle } from "../providers/tts.elevenlabs.js";

type SessionState = "idle" | "listening" | "thinking" | "speaking";

/** Send a typed JSON message to the browser. */
function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** Send a binary audio chunk to the browser. */
function sendBinary(socket: WebSocket, data: Buffer): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(data, { binary: true });
  }
}

/**
 * Manages one WebSocket connection:
 *  - receives binary audio frames → forwards to Deepgram
 *  - receives JSON control messages (start / stop)
 *  - relays transcripts back to the browser
 *  - streams LLM replies using SentenceChunker for early playback
 *  - calculates and emits latency metrics per turn
 */
export function handleSession(socket: WebSocket, sessionId: string, ip: string): void {
  const log = logger.child({ sessionId, ip });
  log.info("Session connected");

  let state: SessionState = "idle";
  let asr: ASRHandle | null = null;
  let llmAbort: AbortController | null = null;
  let ttsStream: { sendText: (text: string, isLast?: boolean) => void; close: () => void } | null = null;
  let activeTurnId: string | null = null;

  const handleFinalTranscript = async (userText: string) => {
    if (!userText.trim()) return;

    const turnId = `t-${Date.now().toString(36)}`;
    activeTurnId = turnId;
    state = "thinking";

    const timer = new TurnTimer(turnId);
    const chunker = new SentenceChunker();
    let sentenceIndex = 0;

    log.info({ turnId, userText }, "Generating assistant reply");

    // Abort any prior in-flight generation
    llmAbort?.abort();
    ttsStream?.close();
    const controller = new AbortController();
    llmAbort = controller;

    // Optional server-side streaming TTS (Cartesia or ElevenLabs)
    const cartesiaKey = process.env.CARTESIA_API_KEY?.trim();
    const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();

    if (cartesiaKey) {
      ttsStream = createCartesiaTTS(
        cartesiaKey,
        {
          onAudioChunk(chunk) {
            timer.markFirstAudio();
            sendBinary(socket, chunk);
          },
          onError(err) {
            log.warn({ err }, "Cartesia streaming TTS failed, fallback to browser");
          },
          onDone() {},
        },
        log
      );
    } else if (elevenKey) {
      ttsStream = createElevenLabsTTS(
        elevenKey,
        {
          onAudioChunk(chunk) {
            timer.markFirstAudio();
            sendBinary(socket, chunk);
          },
          onError(err) {
            log.warn({ err }, "ElevenLabs streaming TTS failed, fallback to browser");
          },
          onDone() {},
        },
        log
      );
    }

    try {
      await streamAssistantReply({
        prompt: userText,
        log,
        signal: controller.signal,

        onFirstToken() {
          timer.markLlmFirstToken();
          log.info({ turnId, ttftMs: timer.getMetrics().llmFirstTokenMs }, "LLM first token received");
        },

        onDelta(delta) {
          if (controller.signal.aborted) return;

          // Slices token stream at sentence boundaries
          const sentences = chunker.push(delta);
          for (const sentence of sentences) {
            if (sentenceIndex === 0) {
              timer.markSentence1();
              timer.markFirstAudio();
              state = "speaking";

              // Emit early latency metrics (TTFA)
              const metrics = timer.getMetrics();
              log.info({ turnId, metrics }, "First sentence ready (TTFA hit)");
              send(socket, {
                type: "metrics",
                turnId,
                ttfaMs: metrics.ttfaMs,
                llmFirstTokenMs: metrics.llmFirstTokenMs,
                sentence1Ms: metrics.sentence1Ms,
              });
            }

            ttsStream?.sendText(sentence, false);
            send(socket, {
              type: "assistant.sentence",
              turnId,
              sentenceIndex: sentenceIndex++,
              text: sentence,
              isLast: false,
            });
          }
        },

        onPartial(fullText) {
          if (controller.signal.aborted) return;
          send(socket, { type: "assistant.partial", text: fullText });
        },

        onFinal(fullText) {
          if (controller.signal.aborted) return;
          timer.markLlmEnd();

          // Flush any trailing sentence
          const remaining = chunker.flush();
          if (remaining) {
            if (sentenceIndex === 0) {
              timer.markSentence1();
              timer.markFirstAudio();
              const metrics = timer.getMetrics();
              send(socket, {
                type: "metrics",
                turnId,
                ttfaMs: metrics.ttfaMs,
                llmFirstTokenMs: metrics.llmFirstTokenMs,
                sentence1Ms: metrics.sentence1Ms,
              });
            }

            ttsStream?.sendText(remaining, true);
            send(socket, {
              type: "assistant.sentence",
              turnId,
              sentenceIndex: sentenceIndex++,
              text: remaining,
              isLast: true,
            });
          }

          send(socket, { type: "assistant.final", text: fullText });
          state = "listening";
          log.info({ turnId, metrics: timer.getMetrics() }, "Turn complete");
        },

        onError(err) {
          log.error({ turnId, err }, "LLM generation error");
          if (!controller.signal.aborted) {
            send(socket, { type: "error", code: "llm_error", retryable: true });
          }
          state = "listening";
        },
      });
    } catch (err) {
      log.error({ turnId, err }, "LLM generation failed");
      if (!controller.signal.aborted) {
        send(socket, { type: "error", code: "llm_unavailable", retryable: true });
      }
      state = "listening";
    }
  };

  // ── Incoming messages ──────────────────────────────────────────────────────
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    // Binary frames = raw PCM-16 audio
    if (isBinary) {
      if ((state === "listening" || state === "thinking" || state === "speaking") && asr) {
        asr.send(data);
      }
      return;
    }

    // Text frames = JSON control messages
    const result = parseClientMessage(data.toString());
    if (!result.success) {
      send(socket, { type: "error", code: "invalid_message", retryable: false });
      return;
    }

    const msg = result.data;

    if (msg.type === "start") {
      if (state !== "idle") return;

      const apiKey = process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        log.error("DEEPGRAM_API_KEY is not set");
        send(socket, { type: "error", code: "asr_misconfigured", retryable: false });
        return;
      }

      state = "listening";
      log.info("Listening started");

      asr = createDeepgramASR(
        apiKey,
        {
          onPartial(text) {
            send(socket, { type: "transcript.partial", text });
          },
          onFinal(text) {
            send(socket, { type: "transcript.final", text });
            log.info({ text }, "Final transcript");
            void handleFinalTranscript(text);
          },
          onError(err) {
            log.error({ err }, "ASR error");
            send(socket, { type: "error", code: "asr_error", retryable: true });
          },
          onClose() {
            state = "idle";
            asr = null;
          },
        },
        log
      );
    }

    if (msg.type === "stop") {
      log.info("Listening stopped by client");
      if (activeTurnId) {
        send(socket, { type: "interrupted", turnId: activeTurnId });
      }
      llmAbort?.abort();
      ttsStream?.close();
      ttsStream = null;
      asr?.close();
      asr = null;
      state = "idle";
    }
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  socket.on("close", (code) => {
    log.info({ code }, "Session disconnected");
    llmAbort?.abort();
    ttsStream?.close();
    ttsStream = null;
    asr?.close();
    asr = null;
  });

  socket.on("error", (err) => {
    log.error({ err }, "Socket error");
    llmAbort?.abort();
    ttsStream?.close();
    ttsStream = null;
    asr?.close();
    asr = null;
  });
}
