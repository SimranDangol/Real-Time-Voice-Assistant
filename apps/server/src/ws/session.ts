import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";
import { createDeepgramASR, type ASRHandle } from "../providers/asr.deepgram.js";
import { streamAssistantReply } from "../providers/llm.js";
import { SentenceChunker } from "../pipeline/chunker.js";
import { BargeInManager } from "../pipeline/bargein.js";
import { TurnTimer, activeSessionsGauge, interruptedTurnsCounter } from "../metrics.js";
import { createCartesiaTTS, type CartesiaTTSHandle } from "../providers/tts.cartesia.js";
import { createElevenLabsTTS, type ElevenLabsTTSHandle } from "../providers/tts.elevenlabs.js";
import {
  registerSession,
  unregisterSession,
  updateSessionHeartbeat,
  checkRateLimit,
} from "../redis.js";
import { enqueuePostCallSummary, type TurnSummary } from "../queue.js";

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

interface TtsHandle {
  sendText: (text: string, isLast?: boolean) => void;
  close: () => void;
}

/**
 * Manages one WebSocket session:
 *  - Turn State Machine (idle -> listening -> thinking -> speaking -> idle)
 *  - Barge-in with immediate AbortController cancellation & history trimming
 *  - Tool execution by voice with Redis short-lived caching
 *  - Redis rate-limiting and session registry
 *  - BullMQ post-call asynchronous summary & metrics rollups
 */
export function handleSession(socket: WebSocket, sessionId: string, ip: string): void {
  const log = logger.child({ sessionId, ip });
  log.info("Session connected");

  let state: SessionState = "idle";
  const sessionStartTime = Date.now();
  const sessionTurns: TurnSummary[] = [];

  const bargeInManager = new BargeInManager();
  let asr: ASRHandle | null = null;
  let activeTurnId: string | null = null;
  let currentTurn: { turnId: string; timer: TurnTimer; userText: string } | null = null;

  // Track session registration in Redis & Prometheus
  activeSessionsGauge.inc();
  void registerSession(sessionId, ip, { userAgent: "voice-assistant-web" });

  const setState = (next: SessionState) => {
    state = next;
    send(socket, { type: "state", state });
  };

  const ttsCallbacks = {
    onAudioChunk(chunk: Buffer) {
      if (activeTurnId && currentTurn?.turnId === activeTurnId) {
        currentTurn.timer.markFirstAudio();
        // Tag the binary stream: announce the turn once; ordering associates
        // all following PCM frames with it until the next audio.turn message.
        if (activeTurnId !== lastAudioTurnId) {
          lastAudioTurnId = activeTurnId;
          send(socket, { type: "audio.turn", turnId: activeTurnId });
        }
        sendBinary(socket, chunk);
      }
    },
    onError(err: Error) {
      log.warn({ err }, "Streaming TTS failed — falling back to browser speech");
      ttsStream = null;
    },
    onDone() {},
    onDisconnect() {
      ttsStream = null;
    },
  };

  let ttsStream: TtsHandle | null = null;
  let lastAudioTurnId: string | null = null;
  const ensureTts = (): TtsHandle | null => {
    if (ttsStream) return ttsStream;

    const provider = (process.env.TTS_PROVIDER ?? "auto").trim().toLowerCase();
    const cartesiaKey = process.env.CARTESIA_API_KEY?.trim();
    const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();

    if (provider !== "browser" && provider !== "elevenlabs" && cartesiaKey) {
      ttsStream = createCartesiaTTS(cartesiaKey, ttsCallbacks, log);
    } else if (provider !== "browser" && provider !== "cartesia" && elevenKey) {
      ttsStream = createElevenLabsTTS(elevenKey, ttsCallbacks, log);
    }
    return ttsStream;
  };

  const closeTts = () => {
    ttsStream?.close();
    ttsStream = null;
  };

  /**
   * Immediate barge-in interrupt: called when user begins speaking while the assistant
   * is either thinking or speaking.
   */
  const triggerBargeIn = () => {
    if ((state === "speaking" || state === "thinking") && activeTurnId) {
      log.info({ turnId: activeTurnId, state }, "⚡ Barge-in triggered by user interruption");
      interruptedTurnsCounter.inc();
      
      const interruptInfo = bargeInManager.interrupt();
      const interruptedTurnId = activeTurnId;
      activeTurnId = null;

      // Close current TTS audio stream
      closeTts();

      // Tell the browser to instantly flush its audio playback buffers
      send(socket, { type: "interrupted", turnId: interruptedTurnId });

      if (currentTurn) {
        sessionTurns.push({
          turnId: interruptedTurnId,
          userText: currentTurn.userText,
          assistantText: interruptInfo?.spokenText ?? "",
          ttfaMs: currentTurn.timer.getMetrics().ttfaMs,
          llmFirstTokenMs: currentTurn.timer.getMetrics().llmFirstTokenMs,
          sentence1Ms: currentTurn.timer.getMetrics().sentence1Ms,
          interrupted: true,
        });
        currentTurn = null;
      }

      setState("listening");
    }
  };

  const handleFinalTranscript = async (userText: string) => {
    const trimmed = userText.trim();
    if (!trimmed) return;

    // If an existing turn was somehow still in flight, interrupt it first
    if (state === "speaking" || state === "thinking") {
      triggerBargeIn();
    }

    const { turnId, controller } = bargeInManager.startTurn(trimmed);
    activeTurnId = turnId;
    setState("thinking");

    const timer = new TurnTimer(turnId);
    currentTurn = { turnId, timer, userText: trimmed };
    const chunker = new SentenceChunker();
    let sentenceIndex = 0;

    log.info({ turnId, userText: trimmed }, "Generating assistant reply");

    // Warm the TTS connection during LLM time-to-first-token
    ensureTts();

    try {
      await streamAssistantReply({
        prompt: trimmed,
        history: bargeInManager.getHistory().slice(0, -1), // prior history excluding this prompt
        signal: controller.signal,
        log,

        onFirstToken() {
          if (controller.signal.aborted) return;
          timer.markLlmFirstToken();
          log.info({ turnId, ttftMs: timer.getMetrics().llmFirstTokenMs }, "LLM first token received");
        },

        onToolCall(toolName, args, result) {
          if (controller.signal.aborted) return;
          log.info({ turnId, tool: toolName, args }, "Notifying client of voice tool call");
          send(socket, {
            type: "assistant.tool",
            turnId,
            tool: toolName,
            args,
            result,
          });
        },

        onDelta(delta) {
          if (controller.signal.aborted) return;

          const sentences = chunker.push(delta);
          for (const sentence of sentences) {
            bargeInManager.recordSpokenSentence(turnId, sentence);

            if (sentenceIndex === 0) {
              timer.markSentence1();
              if (!ttsStream) timer.markFirstAudio();
              setState("speaking");

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
              audio: ttsStream ? "pcm" : "browser",
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

          const remaining = chunker.flush();
          if (remaining) {
            bargeInManager.recordSpokenSentence(turnId, remaining);

            if (sentenceIndex === 0) {
              timer.markSentence1();
              if (!ttsStream) timer.markFirstAudio();
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
              audio: ttsStream ? "pcm" : "browser",
            });
          }

          send(socket, { type: "assistant.final", text: fullText });

          const finalMetrics = timer.getMetrics();
          send(socket, {
            type: "metrics",
            turnId,
            ttfaMs: finalMetrics.ttfaMs,
            llmFirstTokenMs: finalMetrics.llmFirstTokenMs,
            sentence1Ms: finalMetrics.sentence1Ms,
            totalLlmMs: finalMetrics.totalLlmMs,
          });

          bargeInManager.completeTurn(turnId, fullText);

          sessionTurns.push({
            turnId,
            userText: trimmed,
            assistantText: fullText,
            ttfaMs: finalMetrics.ttfaMs,
            llmFirstTokenMs: finalMetrics.llmFirstTokenMs,
            sentence1Ms: finalMetrics.sentence1Ms,
            interrupted: false,
          });

          activeTurnId = null;
          setState("listening");
          log.info({ turnId, metrics: finalMetrics }, "Turn complete");
        },

        onError(err) {
          log.error({ turnId, err }, "LLM generation error");
          if (!controller.signal.aborted) {
            send(socket, { type: "error", code: "llm_error", retryable: true });
          }
          activeTurnId = null;
          setState("listening");
        },
      });
    } catch (err) {
      log.error({ turnId, err }, "LLM generation failed");
      if (!controller.signal.aborted) {
        send(socket, { type: "error", code: "llm_unavailable", retryable: true });
      }
      activeTurnId = null;
      setState("listening");
    }
  };

  // Heartbeat & session lifecycle timers
  const heartbeatInterval = setInterval(() => {
    void updateSessionHeartbeat(sessionId);
    if (socket.readyState === socket.OPEN) {
      send(socket, { type: "pong" });
    }
  }, 30000);

  // Maximum session length safeguard (15 minutes)
  const maxSessionTimeout = setTimeout(() => {
    log.info("Max session duration reached (15m), closing session gracefully");
    send(socket, {
      type: "error",
      code: "session_timeout",
      retryable: false,
      message: "Max session duration reached",
    });
    socket.close(1000, "Max session duration");
  }, 15 * 60 * 1000);

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

    if (msg.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }

    if (msg.type === "start") {
      if (state !== "idle") return;

      // Rate limit session start (max 20 sessions per minute per IP)
      void checkRateLimit(`session_start:${ip}`, 20, 60).then(({ allowed }) => {
        if (!allowed) {
          log.warn({ ip }, "Session start rejected: rate limit exceeded");
          send(socket, {
            type: "error",
            code: "rate_limit_exceeded",
            retryable: true,
            message: "Too many sessions from this IP. Please wait a minute.",
          });
          socket.close(1008, "Rate limit exceeded");
          return;
        }

        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
          log.error("DEEPGRAM_API_KEY is not set");
          send(socket, { type: "error", code: "asr_misconfigured", retryable: false });
          return;
        }

        setState("listening");
        log.info("Listening started");

        asr = createDeepgramASR(
          apiKey,
          {
            onPartial(text) {
              // Real-time barge-in: as soon as speech is heard while the assistant
              // is speaking or thinking, interrupt immediately!
              if ((state === "speaking" || state === "thinking") && text.trim().length > 1) {
                triggerBargeIn();
              }
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
              setState("idle");
              asr = null;
            },
          },
          log
        );
      });
    }

    if (msg.type === "stop") {
      log.info("Listening stopped by client");
      if (activeTurnId) {
        send(socket, { type: "interrupted", turnId: activeTurnId });
      }
      triggerBargeIn();
      closeTts();
      asr?.close();
      asr = null;
      setState("idle");
      currentTurn = null;
    }
  });

  // ── Session Teardown & Post-Call BullMQ Job ───────────────────────────────────
  const finalizeSession = () => {
    activeSessionsGauge.dec();
    clearInterval(heartbeatInterval);
    clearTimeout(maxSessionTimeout);

    triggerBargeIn();
    closeTts();
    asr?.close();
    asr = null;
    currentTurn = null;

    void unregisterSession(sessionId);

    // Enqueue post-call metrics and summary job to BullMQ
    const durationMs = Date.now() - sessionStartTime;
    void enqueuePostCallSummary({
      sessionId,
      ip,
      durationMs,
      turnCount: sessionTurns.length,
      turns: sessionTurns,
    });
  };

  socket.on("close", (code) => {
    log.info({ code }, "Session disconnected");
    finalizeSession();
  });

  socket.on("error", (err) => {
    log.error({ err }, "Socket error");
    finalizeSession();
  });
}
