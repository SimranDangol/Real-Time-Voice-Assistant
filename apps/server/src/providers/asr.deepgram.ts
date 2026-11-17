import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { Logger } from "pino";
import { getTimeoutMs } from "./request.js";

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

  // Utterance accumulation: Deepgram emits is_final for interim segments;
  // speech_final indicates the user has finished speaking the complete utterance.
  let accumulated = "";
  let fallbackTimer: NodeJS.Timeout | null = null;

  const flushUtterance = () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    const finalUtterance = accumulated.trim();
    if (finalUtterance) {
      accumulated = "";
      callbacks.onFinal(finalUtterance);
    }
  };

  const connectTimeout = setTimeout(() => {
    if (ready || closed) return;
    closed = true;
    const error = new Error("Deepgram connection timed out");
    log.error("Deepgram connection timed out");
    callbacks.onError(error);
    conn.finish();
  }, getTimeoutMs("ASR_CONNECT_TIMEOUT_MS", 10_000));

  conn.on(LiveTranscriptionEvents.Open, () => {
    clearTimeout(connectTimeout);
    log.info("Deepgram connection open");
    ready = true;
    for (const chunk of queue) {
      conn.send(chunk as any);
    }
    queue.length = 0;
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const alt = data?.channel?.alternatives?.[0];
    const text: string = (alt?.transcript ?? "").trim();
    const isFinal = Boolean(data?.is_final);
    const speechFinal = Boolean(data?.speech_final);

    if (isFinal) {
      if (text) {
        accumulated = accumulated ? `${accumulated} ${text}` : text;
      }

      if (speechFinal) {
        // Endpointing detected: complete user turn finished
        flushUtterance();
      } else {
        // Segment finalized but user is still speaking; show live partial
        if (accumulated) {
          callbacks.onPartial(accumulated);
        }
        // Fallback silence timer in case speech_final is dropped
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
          flushUtterance();
        }, 700);
      }
    } else if (text) {
      // Interim delta partial result
      const livePartial = accumulated ? `${accumulated} ${text}` : text;
      callbacks.onPartial(livePartial);
    }
  });

  conn.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    flushUtterance();
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    const error = err instanceof Error ? err : new Error("Deepgram connection failed");
    log.error({ errorName: error.name }, "Deepgram error");
    callbacks.onError(error);
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    clearTimeout(connectTimeout);
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

