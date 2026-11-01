"use client";

import { useMic } from "@/hooks/useMic";
import { TranscriptView } from "@/components/TranscriptView";

export default function Home() {
  const { isListening, transcripts, error, start, stop } = useMic();

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center gap-10 px-6 py-12"
      style={{ background: "var(--bg)" }}
    >
      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold tracking-tight" style={{ color: "var(--text)" }}>
          🎙️ Voice Assistant
        </h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Real-time streaming transcription — Week 1
        </p>
      </div>

      {/* Mic Button */}
      <button
        onClick={isListening ? stop : start}
        aria-label={isListening ? "Stop listening" : "Start listening"}
        className="relative w-28 h-28 rounded-full font-semibold text-base text-white
                   transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-offset-2"
        style={{
          background: isListening ? "var(--danger)" : "var(--accent)",
          transform: isListening ? "scale(1.1)" : "scale(1)",
          boxShadow: isListening
            ? "0 0 0 0 rgba(239,68,68,0.4)"
            : "0 0 0 0 rgba(59,130,246,0.4)",
          animation: isListening ? "pulse-ring 1.5s ease-out infinite" : "none",
        }}
      >
        {isListening ? "Stop" : "Start"}
      </button>

      {/* Status */}
      {isListening && (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--success)" }}>
          <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Listening — speak now
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="max-w-md rounded-lg px-4 py-3 text-sm"
          style={{ background: "#2a1010", color: "var(--danger)", border: "1px solid #5a1a1a" }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Transcript */}
      <div
        className="w-full max-w-2xl min-h-[160px] rounded-xl p-6"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <TranscriptView transcripts={transcripts} />
      </div>

      {/* Clear button */}
      {transcripts.length > 0 && (
        <button
          onClick={() => window.location.reload()}
          className="text-xs underline"
          style={{ color: "var(--muted)" }}
        >
          Clear transcript
        </button>
      )}

      <style>{`
        @keyframes pulse-ring {
          0%   { box-shadow: 0 0 0 0   rgba(239,68,68,0.5); }
          70%  { box-shadow: 0 0 0 20px rgba(239,68,68,0);   }
          100% { box-shadow: 0 0 0 0   rgba(239,68,68,0);   }
        }
      `}</style>
    </main>
  );
}

