import WebSocket from "ws";
import type { Logger } from "pino";

export interface CartesiaTTSCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onError: (err: Error) => void;
  onDone: () => void;
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
  const ws = new WebSocket(wsUrl);
  const queue: Array<{ text: string; isLast: boolean }> = [];
  let isReady = false;
  let isClosed = false;

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
        const audioBuffer = Buffer.from(message.data, "base64");
        callbacks.onAudioChunk(audioBuffer);
      }
      if (message.done) {
        callbacks.onDone();
      }
    } catch {
      // In case binary frames are received directly
      if (Buffer.isBuffer(data)) {
        callbacks.onAudioChunk(data);
      }
    }
  });

  ws.on("error", (err) => {
    log.error({ err }, "Cartesia TTS error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("close", () => {
    log.info("Cartesia TTS closed");
    if (!isClosed) {
      callbacks.onDone();
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
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
