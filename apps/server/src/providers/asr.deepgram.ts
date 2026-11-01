import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { Logger } from "pino";

export interface ASRCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface ASRHandle {
  /** Send a raw PCM-16 audio chunk to Deepgram. */
  send: (data: Buffer | ArrayBuffer) => void;
  /** Gracefully close the Deepgram connection. */
  close: () => void;
}

/**
 * Opens a Deepgram live-transcription connection and wires up the callbacks.
 * Audio format expected: mono PCM-16, 16 kHz.
 */
export function createDeepgramASR(
  apiKey: string,
  callbacks: ASRCallbacks,
  log: Logger
): ASRHandle {
  const dg = createClient(apiKey);

  const conn = dg.listen.live({
    model: "nova-3",
    language: "en-US",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: true,   // partial transcripts
    endpointing: 300,         // ms of silence before end-of-utterance
    utterance_end_ms: 1000,  // fire UtteranceEnd after speech silence
  });

  // Buffer audio that arrives before the socket is open
  const queue: Array<Buffer | ArrayBuffer> = [];
  let ready = false;
  let closed = false;

  conn.on(LiveTranscriptionEvents.Open, () => {
    log.info("Deepgram connection open");
    ready = true;
    for (const chunk of queue) {
      conn.send(chunk as any);
    }
    queue.length = 0;
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    const text: string = alt?.transcript ?? "";
    if (!text.trim()) return;

    if (data.is_final) {
      callbacks.onFinal(text);
    } else {
      callbacks.onPartial(text);
    }
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    log.error({ err }, "Deepgram error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    log.info("Deepgram connection closed");
    if (!closed) callbacks.onClose();
  });

  return {
    send(data) {
      if (closed) return;
      if (ready) {
        conn.send(data as any);
      } else {
        queue.push(data);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { conn.finish(); } catch { /* ignore */ }
    },
  };
}

