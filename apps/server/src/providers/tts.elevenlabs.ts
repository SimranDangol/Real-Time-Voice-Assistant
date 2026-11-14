import WebSocket from "ws";
import type { Logger } from "pino";

export interface ElevenLabsTTSCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onError: (err: Error) => void;
  onDone: () => void;
  /** Fired when the provider socket closes unexpectedly (not via close()). */
  onDisconnect?: () => void;
}

export interface ElevenLabsTTSHandle {
  sendText: (text: string, isLast?: boolean) => void;
  close: () => void;
}

/**
 * ElevenLabs Streaming TTS via WebSocket
 * Uses eleven_turbo_v2_5 for low latency.
 */
export function createElevenLabsTTS(
  apiKey: string,
  callbacks: ElevenLabsTTSCallbacks,
  log: Logger,
  voiceId = "21m00Tcm4TlvDq8ikWAM" // Rachel (standard voice)
): ElevenLabsTTSHandle {
  const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=pcm_16000`;
  const ws = new WebSocket(wsUrl);
  const queue: Array<{ text: string; isLast: boolean }> = [];
  let isReady = false;
  let isClosed = false;

  ws.on("open", () => {
    isReady = true;
    log.info("ElevenLabs TTS WebSocket connected");

    // Initialize with BOS (Beginning of Stream) payload
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        xi_api_key: apiKey,
      })
    );

    for (const item of queue) {
      sendPayload(item.text, item.isLast);
    }
    queue.length = 0;
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.audio) {
        const audioBuffer = Buffer.from(message.audio, "base64");
        callbacks.onAudioChunk(audioBuffer);
      }
      if (message.isFinal) {
        callbacks.onDone();
      }
    } catch {
      if (Buffer.isBuffer(data)) {
        callbacks.onAudioChunk(data);
      }
    }
  });

  ws.on("error", (err) => {
    log.error({ err }, "ElevenLabs TTS error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("close", () => {
    log.info("ElevenLabs TTS closed");
    if (!isClosed) {
      callbacks.onDone();
      callbacks.onDisconnect?.();
    }
  });

  function sendPayload(text: string, isLast: boolean) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        text: `${text} `,
        try_trigger_generation: true,
      })
    );

    if (isLast) {
      // Send EOS (End of Stream)
      ws.send(JSON.stringify({ text: "" }));
    }
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

