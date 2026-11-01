"use client";

import { useMic } from "@/hooks/useMic";
import { TranscriptView } from "@/components/TranscriptView";

export default function Home() {
  const { isListening, transcripts, metrics, error, start, stop } = useMic();

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 py-10"
      style={{ background: "var(--bg)", minHeight: "100vh" }}
    >
      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-4xl font-bold tracking-tight" style={{ color: "var(--text)" }}>
          🎙️ Voice Assistant
        </h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Low-latency streaming pipeline — Week 2
        </p>
      </div>

      {/* Latency Dashboard */}
      {metrics && (
        <div
          className="flex items-center gap-6 px-5 py-2.5 rounded-full text-xs font-mono"
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
          }}
        >
          <div>
            TTFA (Audio):{" "}
            <span style={{ color: "var(--success)", fontWeight: 600 }}>
              {metrics.ttfaMs ? `${metrics.ttfaMs}ms` : "—"}
            </span>
          </div>
          <div>
            LLM 1st Token:{" "}
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
              {metrics.llmFirstTokenMs ? `${metrics.llmFirstTokenMs}ms` : "—"}
            </span>
          </div>
          <div>
            Sentence 1:{" "}
            <span style={{ color: "var(--text)", fontWeight: 600 }}>
              {metrics.sentence1Ms ? `${metrics.sentence1Ms}ms` : "—"}
            </span>
          </div>
        </div>
      )}

      {/* Mic Button */}
      <button
        onClick={isListening ? stop : start}
        aria-label={isListening ? "Stop listening" : "Start listening"}
        style={{
          width: "100px",
          height: "100px",
          borderRadius: "50%",
          fontWeight: 600,
          fontSize: "1rem",
          color: "#ffffff",
          background: isListening ? "var(--danger)" : "var(--accent)",
          transform: isListening ? "scale(1.05)" : "scale(1)",
          cursor: "pointer",
          border: "none",
          outline: "none",
          transition: "all 0.2s ease-in-out",
          boxShadow: isListening
            ? "0 0 25px rgba(239, 68, 68, 0.6)"
            : "0 0 25px rgba(59, 130, 246, 0.4)",
        }}
      >
        {isListening ? "Stop" : "Start"}
      </button>

      {/* Status indicator */}
      {isListening && (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--success)" }}>
          <span
            style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "var(--success)",
            }}
          />
          Listening — speak now
        </div>
      )}

      {/* Error display */}
      {error && (
        <div
          className="max-w-md rounded-lg px-4 py-3 text-sm"
          style={{ background: "#2a1010", color: "var(--danger)", border: "1px solid #5a1a1a" }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Transcript Box */}
      <div
        className="w-full max-w-2xl min-h-[220px] rounded-xl p-6"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.3)",
        }}
      >
        <TranscriptView transcripts={transcripts} />
      </div>

      {/* Clear button */}
      {transcripts.length > 0 && (
        <button
          onClick={() => window.location.reload()}
          className="text-xs underline"
          style={{ color: "var(--muted)", background: "transparent", border: "none", cursor: "pointer" }}
        >
          Clear transcript
        </button>
      )}
    </main>
  );
}
