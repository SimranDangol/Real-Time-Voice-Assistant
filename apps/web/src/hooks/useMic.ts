"use client";

import { useCallback, useRef, useState } from "react";
import type { TranscriptEntry } from "@/components/TranscriptView";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";

export interface LatencyMetrics {
  turnId: string;
  ttfaMs: number | null;
  llmFirstTokenMs: number | null;
  sentence1Ms: number | null;
}

type ServerMessage =
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "assistant.partial"; text: string }
  | { type: "assistant.final"; text: string }
  | {
      type: "assistant.sentence";
      turnId: string;
      sentenceIndex: number;
      text: string;
      isLast: boolean;
    }
  | {
      type: "metrics";
      turnId: string;
      ttfaMs: number | null;
      llmFirstTokenMs: number | null;
      sentence1Ms: number | null;
    }
  | { type: "interrupted"; turnId: string }
  | { type: "error"; code: string; retryable: boolean };

export function useMic() {
  const [isListening, setIsListening] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [metrics, setMetrics] = useState<LatencyMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const userPartialIdRef = useRef<string | null>(null);
  const assistantPartialIdRef = useRef<string | null>(null);

  // Audio queue for sequential sentence playback
  const speechQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const nextPlayTimeRef = useRef<number>(0);

  const playPcm16Chunk = useCallback(async (data: ArrayBuffer | Blob) => {
    const ctx = contextRef.current;
    if (!ctx) return;

    const arrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, 16000);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  }, []);

  const playNextSentence = useCallback(() => {
    if (speechQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const nextText = speechQueueRef.current.shift()!;
    const utterance = new SpeechSynthesisUtterance(nextText);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      playNextSentence();
    };

    utterance.onerror = () => {
      playNextSentence();
    };

    window.speechSynthesis.speak(utterance);
  }, []);

  const queueSentence = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      speechQueueRef.current.push(text);
      if (!isPlayingRef.current) {
        playNextSentence();
      }
    },
    [playNextSentence]
  );

  const handleMessage = useCallback(
    (raw: string) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "transcript.partial") {
        const text = msg.text;
        const id = userPartialIdRef.current ?? crypto.randomUUID();
        userPartialIdRef.current = id;
        setTranscripts((prev) => {
          const idx = prev.findIndex((e) => e.id === id && e.role === "user");
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { id, role: "user", text, isFinal: false };
            return next;
          }
          return [...prev, { id, role: "user", text, isFinal: false }];
        });
      }

      if (msg.type === "transcript.final") {
        const text = msg.text;
        const id = userPartialIdRef.current ?? crypto.randomUUID();
        userPartialIdRef.current = null;
        setTranscripts((prev) => {
          const idx = prev.findIndex((e) => e.id === id && e.role === "user");
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { id, role: "user", text, isFinal: true };
            return next;
          }
          return [...prev, { id, role: "user", text, isFinal: true }];
        });
      }

      if (msg.type === "assistant.partial") {
        const text = msg.text;
        const id = assistantPartialIdRef.current ?? crypto.randomUUID();
        assistantPartialIdRef.current = id;
        setTranscripts((prev) => {
          const idx = prev.findIndex((e) => e.id === id && e.role === "assistant");
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { id, role: "assistant", text, isFinal: false };
            return next;
          }
          return [...prev, { id, role: "assistant", text, isFinal: false }];
        });
      }

      if (msg.type === "assistant.final") {
        const text = msg.text;
        const id = assistantPartialIdRef.current ?? crypto.randomUUID();
        assistantPartialIdRef.current = null;
        setTranscripts((prev) => {
          const idx = prev.findIndex((e) => e.id === id && e.role === "assistant");
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { id, role: "assistant", text, isFinal: true };
            return next;
          }
          return [...prev, { id, role: "assistant", text, isFinal: true }];
        });
      }

      // Early sentence streaming for gapless speech
      if (msg.type === "assistant.sentence") {
        queueSentence(msg.text);
      }

      // Latency metrics
      if (msg.type === "metrics") {
        setMetrics({
          turnId: msg.turnId,
          ttfaMs: msg.ttfaMs,
          llmFirstTokenMs: msg.llmFirstTokenMs,
          sentence1Ms: msg.sentence1Ms,
        });
      }

      // Barge-in interruption: cancel speech immediately
      if (msg.type === "interrupted") {
        speechQueueRef.current = [];
        isPlayingRef.current = false;
        nextPlayTimeRef.current = 0;
        window.speechSynthesis.cancel();
      }

      if (msg.type === "error") {
        setError(`Server error: ${msg.code}`);
      }
    },
    [queueSentence]
  );

  // ── Start listening ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setError(null);

    // 1. Request microphone access
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access denied");
      return;
    }
    streamRef.current = stream;

    // 2. Open WebSocket
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: "start", sessionId: crypto.randomUUID() }));

      const ctx = new AudioContext({ sampleRate: 16000 });
      contextRef.current = ctx;

      try {
        await ctx.audioWorklet.addModule("/audio-processor.worklet.js");
      } catch (err) {
        setError("Failed to load audio worklet: " + String(err));
        cleanup();
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, "audio-processor");
      workletRef.current = worklet;

      worklet.port.onmessage = (e: MessageEvent<{ pcm16: ArrayBuffer }>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(e.data.pcm16);
        }
      };

      source.connect(worklet);
      setIsListening(true);
    };

    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        handleMessage(e.data);
      } else if (e.data instanceof ArrayBuffer || e.data instanceof Blob) {
        void playPcm16Chunk(e.data);
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed. Is the server running?");
      cleanup();
    };

    ws.onclose = () => {
      setIsListening(false);
    };
  }, [handleMessage]);

  // ── Stop listening ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    cleanup();
  }, []);

  function cleanup() {
    wsRef.current?.close();
    wsRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    userPartialIdRef.current = null;
    assistantPartialIdRef.current = null;
    speechQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
    window.speechSynthesis.cancel();
    setIsListening(false);
  }

  return { isListening, transcripts, metrics, error, start, stop };
}
