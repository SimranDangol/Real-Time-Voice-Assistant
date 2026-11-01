import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";
import { createDeepgramASR, type ASRHandle } from "../providers/asr.deepgram.js";

type SessionState = "idle" | "listening";

/** Send a typed JSON message to the browser. */
function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/**
 * Manages one WebSocket connection:
 *  - receives binary audio frames → forwards to Deepgram
 *  - receives JSON control messages (start / stop)
 *  - relays transcripts back to the browser
 */
export function handleSession(socket: WebSocket, sessionId: string, ip: string): void {
  const log = logger.child({ sessionId, ip });
  log.info("Session connected");

  let state: SessionState = "idle";
  let asr: ASRHandle | null = null;

  // ── Incoming messages ──────────────────────────────────────────────────────
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    // Binary frames = raw PCM-16 audio
    if (isBinary) {
      if (state === "listening" && asr) {
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
      asr?.close();
      asr = null;
      state = "idle";
    }
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  socket.on("close", (code) => {
    log.info({ code }, "Session disconnected");
    asr?.close();
    asr = null;
  });

  socket.on("error", (err) => {
    log.error({ err }, "Socket error");
    asr?.close();
    asr = null;
  });
}
