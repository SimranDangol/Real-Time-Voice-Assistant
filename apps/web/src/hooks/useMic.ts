"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@/components/TranscriptView";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";

export interface LatencyMetrics {
  turnId: string;
  ttfaMs: number | null;
  llmFirstTokenMs: number | null;
  sentence1Ms: number | null;
  totalLlmMs?: number | null;
}

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

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
      audio: "pcm" | "browser";
    }
  | {
      type: "assistant.tool";
      turnId: string;
      tool: string;
      args: Record<string, any>;
      result: string;
    }
  | {
      type: "metrics";
      turnId: string;
      ttfaMs: number | null;
      llmFirstTokenMs: number | null;
      sentence1Ms: number | null;
      totalLlmMs?: number | null;
    }
  | { type: "audio.turn"; turnId: string }
  | { type: "interrupted"; turnId: string }
  | { type: "state"; state: AssistantState }
  | { type: "pong" }
  | { type: "error"; code: string; retryable: boolean; message?: string };

export function useMic() {
  const [isListening, setIsListening] = useState(false);
  const [assistantState, setAssistantState] = useState<AssistantState>("idle");
  const assistantStateRef = useRef<AssistantState>("idle");
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [metrics, setMetrics] = useState<LatencyMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headphonesMode, setHeadphonesMode] = useState<boolean>(false);
  const headphonesModeRef = useRef<boolean>(false);
  headphonesModeRef.current = headphonesMode;

  const wsRef = useRef<WebSocket | null>(null);
  // captureCtx: 16kHz context used only for mic capture worklet
  const captureCtxRef = useRef<AudioContext | null>(null);
  // playbackCtx: native-rate context used for PCM audio playback
  const playbackCtxRef = useRef<AudioContext | null>(null);
  // Legacy alias kept so cleanup() compiles
  const contextRef = captureCtxRef;
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const userPartialIdRef = useRef<string | null>(null);
  const assistantPartialIdRef = useRef<string | null>(null);

  // Audio queue for sequential sentence playback
  const speechQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const nextPlayTimeRef = useRef<number>(0);

  // Server-TTS (PCM) playback: track live sources so barge-in can stop them
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  // Turn id for which we already cancelled speechSynthesis (pcm mode)
  const speechCancelledTurnRef = useRef<string | null>(null);
  // Turn id of the PCM stream currently announced by the server (audio.turn).
  // Binary chunks that arrive while muted or for a superseded turn are dropped.
  const pcmTurnIdRef = useRef<string | null>(null);
  // Drop stale PCM chunks that arrive after an interrupt, until the next turn
  const pcmMutedRef = useRef<boolean>(false);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Auto-detect best natural, high-quality browser voice
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const pickBestVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;

      const priorityKeywords = [
        "Google US English",
        "Natural",
        "Neural",
        "Jenny",
        "Aria",
        "Guy",
        "Samantha",
        "Ava",
        "Serena",
        "Google UK English Female",
      ];

      for (const kw of priorityKeywords) {
        const found = voices.find(
          (v) => v.name.toLowerCase().includes(kw.toLowerCase()) && v.lang.startsWith("en")
        );
        if (found) {
          selectedVoiceRef.current = found;
          return;
        }
      }

      const nonRobotic = voices.find(
        (v) =>
          v.lang.startsWith("en") &&
          !v.name.toLowerCase().includes("desktop") &&
          !v.name.toLowerCase().includes("david")
      );
      selectedVoiceRef.current = nonRobotic ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
    };

    pickBestVoice();
    window.speechSynthesis.onvoiceschanged = pickBestVoice;
  }, []);

  const playPcm16Chunk = useCallback(async (data: ArrayBuffer | Blob) => {
    // Use a dedicated playback AudioContext at the browser's native sample rate.
    // This avoids conflicts with the 16kHz capture context and ensures the browser
    // can actually play audio (native rate = no resampling issues).
    let playCtx = playbackCtxRef.current;
    if (!playCtx || playCtx.state === "closed") {
      playCtx = new AudioContext(); // browser default sample rate (usually 44100 or 48000)
      playbackCtxRef.current = playCtx;
    }
    if (playCtx.state === "suspended") {
      try { await playCtx.resume(); } catch {}
    }

    const arrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    // Audio from Cartesia is 16kHz PCM. Tell the AudioContext the source rate
    // so it resamples correctly to the playback device's native rate.
    const audioBuffer = playCtx.createBuffer(1, float32.length, 16000);
    audioBuffer.getChannelData(0).set(float32);

    const source = playCtx.createBufferSource();
    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
    };
    source.buffer = audioBuffer;
    source.connect(playCtx.destination);

    const startTime = Math.max(playCtx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  }, []);

  const stopAllPcm = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSourcesRef.current.clear();
    nextPlayTimeRef.current = 0;
  }, []);

  const playNextSentence = useCallback(() => {
    if (speechQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    // Chrome bug: speechSynthesis sometimes stalls. Cancel + small delay fixes it.
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
      setTimeout(() => playNextSentence(), 150);
      return;
    }
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    isPlayingRef.current = true;
    const nextText = speechQueueRef.current.shift()!;
    const utterance = new SpeechSynthesisUtterance(nextText);
    if (selectedVoiceRef.current) {
      utterance.voice = selectedVoiceRef.current;
    }
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      isPlayingRef.current = false;
      setTimeout(() => playNextSentence(), 80);
    };

    utterance.onerror = (e) => {
      console.warn("SpeechSynthesis error:", e.error, e);
      isPlayingRef.current = false;
      setTimeout(() => playNextSentence(), 150);
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

      if (msg.type === "state") {
        setAssistantState(msg.state);
        assistantStateRef.current = msg.state;
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

      if (msg.type === "assistant.tool") {
        const toolMsg = msg;
        setTranscripts((prev) => [
          ...prev,
          {
            id: `tool-${Date.now()}`,
            role: "tool",
            text: toolMsg.result,
            isFinal: true,
            toolCall: { name: toolMsg.tool, args: toolMsg.args, result: toolMsg.result },
          },
        ]);
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

      // Early sentence streaming
      if (msg.type === "assistant.sentence") {
        pcmMutedRef.current = false;
        if (msg.audio === "pcm") {
          if (speechCancelledTurnRef.current !== msg.turnId) {
            speechCancelledTurnRef.current = msg.turnId;
            speechQueueRef.current = [];
            isPlayingRef.current = false;
            window.speechSynthesis.cancel();
          }
        } else {
          queueSentence(msg.text);
        }
      }

      // Latency metrics
      if (msg.type === "metrics") {
        setMetrics({
          turnId: msg.turnId,
          ttfaMs: msg.ttfaMs,
          llmFirstTokenMs: msg.llmFirstTokenMs,
          sentence1Ms: msg.sentence1Ms,
          totalLlmMs: msg.totalLlmMs,
        });
      }

      // Server announces which turn the following binary PCM chunks belong to.
      // A new turn id means barge-in is over and playback may resume.
      if (msg.type === "audio.turn") {
        pcmTurnIdRef.current = msg.turnId;
        pcmMutedRef.current = false;
      }

      // Barge-in interruption: cancel ALL playback immediately & mark transcript
      if (msg.type === "interrupted") {
        speechQueueRef.current = [];
        isPlayingRef.current = false;
        nextPlayTimeRef.current = 0;
        window.speechSynthesis.cancel();
        stopAllPcm();
        speechCancelledTurnRef.current = null;
        pcmMutedRef.current = true;

        setTranscripts((prev) => {
          const copy = [...prev];
          const lastAssistant = [...copy].reverse().find((e) => e.role === "assistant");
          if (lastAssistant) {
            lastAssistant.interrupted = true;
          }
          return copy;
        });
      }

      if (msg.type === "error") {
        setError(msg.message ? `Error: ${msg.message}` : `Server error: ${msg.code}`);
      }
    },
    [queueSentence, stopAllPcm]
  );

  // ── Start listening ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setError(null);

    // ── Unlock audio APIs from the user click gesture ────────────────────────
    // Both AudioContext and speechSynthesis require a user gesture to start.
    // We must initialize them here, inside the click handler.
    try {
      // Capture context (16kHz, for mic worklet)
      let capCtx = captureCtxRef.current;
      if (!capCtx || capCtx.state === "closed") {
        capCtx = new AudioContext({ sampleRate: 16000 });
        captureCtxRef.current = capCtx;
      }
      if (capCtx.state === "suspended") await capCtx.resume();

      // Playback context (native rate, for AI voice output)
      let playCtx = playbackCtxRef.current;
      if (!playCtx || playCtx.state === "closed") {
        playCtx = new AudioContext(); // browser default: 44100 or 48000 Hz
        playbackCtxRef.current = playCtx;
      }
      if (playCtx.state === "suspended") await playCtx.resume();
    } catch {}

    // Unlock browser SpeechSynthesis with a silent utterance on click
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        const unlock = new SpeechSynthesisUtterance(" ");
        unlock.volume = 0;
        window.speechSynthesis.speak(unlock);
      } catch {}
    }

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

    // 2. Fetch short-lived JWT auth token
    const serverBase = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
    let tokenParam = "";
    try {
      const res = await fetch(`${serverBase}/api/auth/token`);
      if (res.ok) {
        const data = await res.json();
        if (data?.token) {
          tokenParam = `?token=${encodeURIComponent(data.token)}`;
        }
      }
    } catch {
      // Dev mode fallback
    }

    // 3. Open WebSocket with token
    const ws = new WebSocket(`${WS_URL}${tokenParam}`);
    wsRef.current = ws;

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: "start", sessionId: crypto.randomUUID() }));

      // Reuse the capture AudioContext already created in start() (from user gesture).
      let ctx = captureCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext({ sampleRate: 16000 });
        captureCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }

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
          // Acoustic echo suppression:
          // In speaker mode, mute mic upload while the assistant is speaking so
          // laptop speakers do not bleed back into Deepgram transcription.
          const isAssistantSpeaking =
            isPlayingRef.current ||
            activeSourcesRef.current.size > 0 ||
            assistantStateRef.current === "speaking" ||
            (typeof window !== "undefined" && Boolean(window.speechSynthesis?.speaking));

          if (!headphonesModeRef.current && isAssistantSpeaking) {
            return;
          }

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
        // Drop chunks muted by barge-in; they belong to the interrupted turn
        // until the server announces a new one via audio.turn.
        if (pcmMutedRef.current) return;
        if (isPlayingRef.current || speechQueueRef.current.length > 0) {
          speechQueueRef.current = [];
          isPlayingRef.current = false;
          window.speechSynthesis.cancel();
        }
        void playPcm16Chunk(e.data);
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed. Is the server running?");
      cleanup();
    };

    ws.onclose = () => {
      setIsListening(false);
      setAssistantState("idle");
    };
  }, [handleMessage, playPcm16Chunk]);

  // ── Stop listening ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    cleanup();
  }, []);

  const interrupt = useCallback(() => {
    speechQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    stopAllPcm();
    pcmMutedRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "start", sessionId: crypto.randomUUID() }));
        }
      }, 150);
    }
  }, [stopAllPcm]);

  function cleanup() {
    wsRef.current?.close();
    wsRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    captureCtxRef.current?.close();
    captureCtxRef.current = null;
    playbackCtxRef.current?.close();
    playbackCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    userPartialIdRef.current = null;
    assistantPartialIdRef.current = null;
    speechQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
    window.speechSynthesis.cancel();
    stopAllPcm();
    speechCancelledTurnRef.current = null;
    pcmMutedRef.current = false;
    pcmTurnIdRef.current = null;
    setIsListening(false);
    setAssistantState("idle");
    assistantStateRef.current = "idle";
  }

  return {
    isListening,
    assistantState,
    transcripts,
    metrics,
    error,
    start,
    stop,
    interrupt,
    headphonesMode,
    setHeadphonesMode,
  };
}
