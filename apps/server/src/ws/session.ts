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
import { captureError } from "../sentry.js";

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
  let finalized = false;

  const bargeInManager = new BargeInManager();
  let asr: ASRHandle | null = null;
  let activeTurnId: string | null = null;
  let currentTurn: { turnId: string; timer: TurnTimer; userText: string } | null = null;
  let selectedTtsProvider: "cartesia" | "elevenlabs" | null = null;
  let receivedAudioForTurn = false;
  let turnSentences: Array<{
    turnId: string;
    sentenceIndex: number;
    text: string;
    isLast: boolean;
  }> = [];
  const failedTtsProviders = new Set<"cartesia" | "elevenlabs">();

  // Track session registration in Redis & Prometheus
  activeSessionsGauge.inc();
  void registerSession(sessionId, ip, { userAgent: "voice-assistant-web" });

  const setState = (next: SessionState) => {
    state = next;
    send(socket, { type: "state", state });
  };

  let ttsStream: TtsHandle | null = null;
  let lastAudioTurnId: string | null = null;
  let ensureTts: () => TtsHandle | null = () => null;
  const handleTtsFailure = (provider: "cartesia" | "elevenlabs", err: Error) => {
    if (selectedTtsProvider !== provider) return;
    log.warn({ provider, errorName: err.name }, "Streaming TTS failed; selecting a fallback");
    captureError(err, { component: "tts", provider });
    failedTtsProviders.add(provider);

    const failedStream = ttsStream;
    ttsStream = null;
    selectedTtsProvider = null;
    failedStream?.close();

    const fallback = ensureTts();
    if (!receivedAudioForTurn && turnSentences.length > 0) {
      if (fallback) {
        for (const s of turnSentences) {
          fallback.sendText(s.text, s.isLast);
        }
      } else {
        for (const s of turnSentences) {
          send(socket, {
            type: "assistant.sentence",
            ...s,
            audio: "browser",
          });
        }
      }
    }
  };
  const createTtsCallbacks = (provider: "cartesia" | "elevenlabs") => ({
    onAudioChunk(chunk: Buffer) {
      if (selectedTtsProvider !== provider) return;
      if (activeTurnId && currentTurn?.turnId === activeTurnId) {
        receivedAudioForTurn = true;
        currentTurn.timer.markFirstAudio();
        if (activeTurnId !== lastAudioTurnId) {
          lastAudioTurnId = activeTurnId;
          send(socket, { type: "audio.turn", turnId: activeTurnId });
        }
        sendBinary(socket, chunk);
      }
    },
    onError(err: Error) {
      handleTtsFailure(provider, err);
    },
    onDone() {},
    onDisconnect() {
      handleTtsFailure(provider, new Error("Streaming TTS disconnected"));
    },
  });

  ensureTts = () => {
    if (ttsStream) return ttsStream;

    const provider = (process.env.TTS_PROVIDER ?? "auto").trim().toLowerCase();
    const cartesiaKey = process.env.CARTESIA_API_KEY?.trim();
    const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();
    const preference: Array<"cartesia" | "elevenlabs"> =
      provider === "cartesia"
        ? ["cartesia", "elevenlabs"]
        : provider === "elevenlabs"
          ? ["elevenlabs", "cartesia"]
          : provider === "browser"
            ? []
            : ["cartesia", "elevenlabs"];

    for (const candidate of preference) {
      if (failedTtsProviders.has(candidate)) continue;
      if (candidate === "cartesia" && cartesiaKey) {
        selectedTtsProvider = candidate;
        ttsStream = createCartesiaTTS(cartesiaKey, createTtsCallbacks(candidate), log);
        break;
      }
      if (candidate === "elevenlabs" && elevenKey) {
        selectedTtsProvider = candidate;
        ttsStream = createElevenLabsTTS(elevenKey, createTtsCallbacks(candidate), log);
        break;
      }
    }
    return ttsStream;
  };

  const closeTts = () => {
    ttsStream?.close();
    ttsStream = null;
    selectedTtsProvider = null;
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
        const turnMetrics = currentTurn.timer.getMetrics();
        log.info(
          {
            turnId: interruptedTurnId,
            ttfaMs: turnMetrics.ttfaMs,
            llmFirstTokenMs: turnMetrics.llmFirstTokenMs,
            sentence1Ms: turnMetrics.sentence1Ms,
            totalLlmMs: turnMetrics.totalLlmMs,
            interrupted: true,
          },
          "Turn metrics"
        );
        sessionTurns.push({
          turnId: interruptedTurnId,
          userText: currentTurn.userText,
          assistantText: interruptInfo?.spokenText ?? "",
          ttfaMs: turnMetrics.ttfaMs,
          llmFirstTokenMs: turnMetrics.llmFirstTokenMs,
          sentence1Ms: turnMetrics.sentence1Ms,
          totalLlmMs: turnMetrics.totalLlmMs,
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
    receivedAudioForTurn = false;
    turnSentences = [];
    setState("thinking");

    const timer = new TurnTimer(turnId);
    currentTurn = { turnId, timer, userText: trimmed };
    const chunker = new SentenceChunker();
    const bufferedTts = process.env.TTS_STREAMING_MODE === "buffered";
    let bufferedReply = "";
    let sentenceIndex = 0;

    log.info({ turnId }, "Generating assistant reply");

    const emitSentence = (sentence: string, isLast: boolean) => {
      if (!sentence) return;
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

      turnSentences.push({ turnId, sentenceIndex, text: sentence, isLast });
      ttsStream?.sendText(sentence, isLast);
      send(socket, {
        type: "assistant.sentence",
        turnId,
        sentenceIndex: sentenceIndex++,
        text: sentence,
        isLast,
        audio: ttsStream ? "pcm" : "browser",
      });
    };

    try {
      // Warm the TTS connection during LLM time-to-first-token
      ensureTts();

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
          log.info({ turnId, tool: toolName }, "Notifying client of voice tool call");
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

          if (bufferedTts) {
            bufferedReply += delta;
            return;
          }
          for (const sentence of chunker.push(delta)) emitSentence(sentence, false);
        },

        onPartial(fullText) {
          if (controller.signal.aborted) return;
          send(socket, { type: "assistant.partial", text: fullText });
        },

        onFinal(fullText) {
          if (controller.signal.aborted) return;
          timer.markLlmEnd();

          let sentences: string[];
          if (bufferedTts) {
            const completed = chunker.push(bufferedReply || fullText);
            const remaining = chunker.flush();
            sentences = remaining ? [...completed, remaining] : completed;
          } else {
            const remaining = chunker.flush();
            sentences = remaining ? [remaining] : [];
          }
          sentences.forEach((sentence, index) => emitSentence(sentence, index === sentences.length - 1));

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
            totalLlmMs: finalMetrics.totalLlmMs,
            interrupted: false,
          });

          activeTurnId = null;
          setState("listening");
          log.info(
            {
              turnId,
              ttfaMs: finalMetrics.ttfaMs,
              llmFirstTokenMs: finalMetrics.llmFirstTokenMs,
              sentence1Ms: finalMetrics.sentence1Ms,
              totalLlmMs: finalMetrics.totalLlmMs,
              interrupted: false,
              metrics: finalMetrics,
            },
            "Turn metrics"
          );
        },

        onError(err) {
          log.error({ turnId, errorName: err.name, errorMessage: err.message }, "LLM generation error");
          captureError(err, { component: "llm" });
          if (!controller.signal.aborted) {
            send(socket, { type: "error", code: "llm_error", retryable: true });
          }
          activeTurnId = null;
          setState("listening");
        },
      });
    } catch (err) {
      log.error({ turnId, errorName: err instanceof Error ? err.name : "unknown" }, "LLM generation failed");
      captureError(err, { component: "llm" });
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
              // Real-time barge-in: only interrupt when the assistant is actively
              // speaking aloud to the user and new user speech is detected.
              // Do NOT interrupt during "thinking" as trailing query frames arrive then.
              if (state === "speaking" && text.trim().length >= 4) {
                log.info({ partialText: text }, "Barge-in triggered by user interruption");
                triggerBargeIn();
              }
              send(socket, { type: "transcript.partial", text });
            },
            onFinal(text) {
              send(socket, { type: "transcript.final", text });
              log.info("Final transcript received");
              void handleFinalTranscript(text);
            },
            onError(err) {
              log.error({ errorName: err.name }, "ASR error");
              captureError(err, { component: "asr" });
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
    if (finalized) return;
    finalized = true;

    activeSessionsGauge.dec();
    clearInterval(heartbeatInterval);
    clearTimeout(maxSessionTimeout);

    triggerBargeIn();
    closeTts();
    asr?.close();
    asr = null;
    currentTurn = null;

    void unregisterSession(sessionId);

    const endedAtMs = Date.now();
    const durationMs = endedAtMs - sessionStartTime;
    void enqueuePostCallSummary({
      sessionId,
      ip,
      startedAtMs: sessionStartTime,
      endedAtMs,
      durationMs,
      turnCount: sessionTurns.length,
      turns: sessionTurns,
    }).catch((err) => {
      log.error({ err }, "Failed to persist post-call session data");
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
