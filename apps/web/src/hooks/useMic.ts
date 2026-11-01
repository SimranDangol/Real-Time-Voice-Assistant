"use client";

import { useCallback, useRef, useState } from "react";
import type { TranscriptEntry } from "@/components/TranscriptView";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";

type ServerMessage =
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "error"; code: string; retryable: boolean }
  | { type: string };

export function useMic() {
  const [isListening, setIsListening] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  // ID of the current partial transcript entry so we can update it in place
  const partialIdRef = useRef<string | null>(null);

  // ── Handle a message from the server ────────────────────────────────────────
  const handleMessage = useCallback((raw: string) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (msg.type === "transcript.partial") {
      const text = (msg as { type: string; text: string }).text;
      // Reuse the same ID so the partial updates in place
      const id = partialIdRef.current ?? crypto.randomUUID();
      partialIdRef.current = id;
      setTranscripts((prev) => {
        const idx = prev.findIndex((e) => e.id === id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { id, text, isFinal: false };
          return next;
        }
        return [...prev, { id, text, isFinal: false }];
      });
    }

    if (msg.type === "transcript.final") {
      const text = (msg as { type: string; text: string }).text;
      const id = partialIdRef.current ?? crypto.randomUUID();
      // Clear partial slot so the next utterance gets a fresh entry
      partialIdRef.current = null;
      setTranscripts((prev) => {
        const idx = prev.findIndex((e) => e.id === id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { id, text, isFinal: true };
          return next;
        }
        return [...prev, { id, text, isFinal: true }];
      });
    }

    if (msg.type === "error") {
      const { code } = msg as { type: string; code: string };
      setError(`Server error: ${code}`);
    }
  }, []);

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
      // Tell server to start a new session
      ws.send(JSON.stringify({ type: "start", sessionId: crypto.randomUUID() }));

      // 3. Set up AudioContext at 16 kHz (Chrome honours this)
      const ctx = new AudioContext({ sampleRate: 16000 });
      contextRef.current = ctx;

      try {
        await ctx.audioWorklet.addModule("/audio-processor.worklet.js");
      } catch (err) {
        setError("Failed to load audio worklet: " + String(err));
        cleanup();
        return;
      }

      // 4. Connect mic → worklet → (silent destination to keep graph alive)
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, "audio-processor");
      workletRef.current = worklet;

      // 5. Forward PCM frames from worklet to server over WebSocket
      worklet.port.onmessage = (e: MessageEvent<{ pcm16: ArrayBuffer }>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(e.data.pcm16); // send as binary frame
        }
      };

      source.connect(worklet);
      // Do NOT connect worklet to ctx.destination — we don't want to hear ourselves
      setIsListening(true);
    };

    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") handleMessage(e.data);
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
    setIsListening(false);
  }

  return { isListening, transcripts, error, start, stop };
}

