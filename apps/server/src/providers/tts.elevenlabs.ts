import WebSocket from "ws";
import type { Logger } from "pino";
import { getTimeoutMs } from "./request.js";

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
      const error = new Error("ElevenLabs TTS timed out waiting for audio");
      callbacks.onError(error);
      ws.terminate();
    }, getTimeoutMs("TTS_RESPONSE_TIMEOUT_MS", 15_000));
  };

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
        clearResponseTimeout();
        const audioBuffer = Buffer.from(message.audio, "base64");
        callbacks.onAudioChunk(audioBuffer);
        if (!message.isFinal) armResponseTimeout();
      }
      if (message.isFinal) {
        clearResponseTimeout();
        callbacks.onDone();
      }
    } catch {
      if (Buffer.isBuffer(data)) {
        clearResponseTimeout();
        callbacks.onAudioChunk(data);
        armResponseTimeout();
      }
    }
  });

  ws.on("error", (err) => {
    const error = err instanceof Error ? err : new Error("ElevenLabs TTS connection failed");
    log.error({ errorName: error.name }, "ElevenLabs TTS error");
    callbacks.onError(error);
  });

  ws.on("close", () => {
    clearResponseTimeout();
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

