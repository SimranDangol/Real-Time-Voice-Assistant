import WebSocket from "ws";
import type { Logger } from "pino";
import { getTimeoutMs } from "./request.js";

export interface CartesiaTTSCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onError: (err: Error) => void;
  onDone: () => void;
  /** Fired when the provider socket closes unexpectedly (not via close()). */
  onDisconnect?: () => void;
}

export interface CartesiaTTSHandle {
  sendText: (text: string, isLast?: boolean) => void;
  close: () => void;
}

/**
 * Cartesia Streaming TTS via WebSocket
 * Audio format: PCM 16-bit, 24kHz or 16kHz mono.
 */
export function createCartesiaTTS(
  apiKey: string,
  callbacks: CartesiaTTSCallbacks,
  log: Logger,
  voiceId = "a0e99841-438c-4a64-b679-ae501e7d6091" // Standard friendly conversational voice
): CartesiaTTSHandle {
  const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${apiKey}&cartesia_version=2024-06-10`;
  const ws = new WebSocket(wsUrl, {
    handshakeTimeout: getTimeoutMs("TTS_CONNECT_TIMEOUT_MS", 10_000),
  });
  const queue: Array<{ text: string; isLast: boolean }> = [];
  let isReady = false;
  let isClosed = false;
  let responseTimeout: NodeJS.Timeout | null = null;

  const clearResponseTimeout = () => {
    if (responseTimeout) clearTimeout(responseTimeout);
    responseTimeout = null;
  };
  const armResponseTimeout = () => {
    clearResponseTimeout();
    responseTimeout = setTimeout(() => {
      const error = new Error("Cartesia TTS timed out waiting for audio");
      callbacks.onError(error);
      ws.terminate();
    }, getTimeoutMs("TTS_RESPONSE_TIMEOUT_MS", 15_000));
  };

  ws.on("open", () => {
    isReady = true;
    log.info("Cartesia TTS WebSocket connected");
    for (const item of queue) {
      sendPayload(item.text, item.isLast);
    }
    queue.length = 0;
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.data) {
        clearResponseTimeout();
        const audioBuffer = Buffer.from(message.data, "base64");
        callbacks.onAudioChunk(audioBuffer);
        if (!message.done) armResponseTimeout();
      }
      if (message.done) {
        clearResponseTimeout();
        callbacks.onDone();
      }
    } catch {
      // In case binary frames are received directly
      if (Buffer.isBuffer(data)) {
        clearResponseTimeout();
        callbacks.onAudioChunk(data);
        armResponseTimeout();
      }
    }
  });

  ws.on("error", (err) => {
    const error = err instanceof Error ? err : new Error("Cartesia TTS connection failed");
    log.error({ errorName: error.name }, "Cartesia TTS error");
    callbacks.onError(error);
  });

  ws.on("close", () => {
    clearResponseTimeout();
    log.info("Cartesia TTS closed");
    if (!isClosed) {
      callbacks.onDone();
      callbacks.onDisconnect?.();
    }
  });

  function sendPayload(text: string, isLast: boolean) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      model_id: "sonic-english",
      transcript: text,
      voice: {
        mode: "id",
        id: voiceId,
      },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 16000,
      },
      continue: !isLast,
    };
    ws.send(JSON.stringify(payload));
    armResponseTimeout();
  }

  return {
    sendText(text: string, isLast = false) {
      if (isClosed) return;
      if (isReady) {
        sendPayload(text, isLast);
      } else {
        queue.push({ text, isLast });
      }
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      clearResponseTimeout();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

