"use client";

import { useMic } from "@/hooks/useMic";
import { TranscriptView } from "@/components/TranscriptView";
import { AudioVisualizer } from "@/components/AudioVisualizer";

export default function Home() {
  const {
    isListening,
    assistantState,
    transcripts,
    metrics,
    error,
    start,
    stop,
    interrupt,
  } = useMic();

  return (
    <main className="h-screen max-h-screen bg-[#09090b] text-zinc-100 flex flex-col items-center p-3 sm:p-5 lg:p-6 font-sans overflow-hidden">
      {/* ── Top Bar / Header ────────────────────────────────────────────── */}
      <header className="w-full max-w-6xl flex items-center justify-between py-2.5 px-5 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 backdrop-blur-md mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              isListening
                ? assistantState === "listening"
                  ? "bg-emerald-400 animate-ping"
                  : assistantState === "thinking"
                  ? "bg-blue-400 animate-pulse"
                  : "bg-purple-400 animate-pulse"
                : "bg-emerald-500"
            }`}
          />
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm sm:text-base tracking-tight text-zinc-100">
              Voice Assistant
            </span>
            <span className="text-[11px] font-mono font-medium tracking-wide px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 shadow-sm">
              Real-Time
            </span>
          </div>
        </div>

        {/* Telemetry Chips & Quick End Button */}
        <div className="flex items-center gap-3">
          {metrics && (
            <div className="hidden sm:flex items-center gap-3 text-xs font-mono text-zinc-400 px-3 py-1 rounded-lg bg-zinc-800/40 border border-zinc-800">
              <span>
                TTFA:{" "}
                <strong className="text-emerald-400 font-semibold">
                  {metrics.ttfaMs ? `${metrics.ttfaMs}ms` : "—"}
                </strong>
              </span>
              <span className="text-zinc-600">|</span>
              <span>
                TTFT:{" "}
                <strong className="text-zinc-200">
                  {metrics.llmFirstTokenMs ? `${metrics.llmFirstTokenMs}ms` : "—"}
                </strong>
              </span>
            </div>
          )}

          {isListening && (
            <button
              onClick={stop}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-mono transition-colors active:scale-95 cursor-pointer"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              <span>End Call</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Main 2-Column Grid (Locked to screen height, no page scroll) ──── */}
      <div className="w-full max-w-6xl flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch min-h-0 overflow-hidden">
        {/* ── LEFT COLUMN: Session Controller & Start/End Buttons (5 cols) ── */}
        <section className="lg:col-span-5 flex flex-col justify-center items-center p-6 sm:p-8 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 backdrop-blur-md relative text-center h-full">
          {/* Active Status Badge */}
          {isListening && (
            <div className="absolute top-4 right-4">
              <span
                className={`text-[11px] font-mono px-3 py-1 rounded-full border shadow-sm ${
                  assistantState === "listening"
                    ? "bg-emerald-950/70 text-emerald-400 border-emerald-500/40"
                    : assistantState === "thinking"
                    ? "bg-blue-950/70 text-blue-400 border-blue-500/40"
                    : "bg-purple-950/70 text-purple-400 border-purple-500/40"
                }`}
              >
                {assistantState === "listening"
                  ? "● Listening"
                  : assistantState === "thinking"
                  ? "✦ Thinking"
                  : "⚡ Speaking"}
              </span>
            </div>
          )}

          {/* Centered Waveform Area */}
          <div className="w-full max-w-sm flex flex-col items-center justify-center my-2">
            <AudioVisualizer state={assistantState} isActive={isListening} />
            <div className="min-h-[22px] text-xs font-mono text-center text-zinc-400 mt-2">
              {!isListening
                ? "Tap below to begin conversation"
                : assistantState === "listening"
                ? "Listening... speak naturally"
                : assistantState === "thinking"
                ? "Thinking & running tools..."
                : "Speaking... tap Interrupt anytime"}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="w-full max-w-xs flex flex-col items-center gap-3 mt-4">
            {!isListening ? (
              <button
                onClick={start}
                className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-b from-white to-zinc-200 hover:from-white hover:to-zinc-100 text-zinc-950 font-semibold text-sm tracking-wide transition-all shadow-[0_2px_14px_rgba(255,255,255,0.12),inset_0_1px_0_rgba(255,255,255,0.8)] active:scale-[0.98] cursor-pointer flex items-center justify-center border border-white/60"
              >
                <span>Start Session</span>
              </button>
            ) : (
              <div className="w-full flex flex-col gap-2.5">
                {assistantState === "speaking" && (
                  <button
                    onClick={interrupt}
                    className="w-full py-3 px-5 rounded-xl bg-rose-600/25 hover:bg-rose-600/35 text-rose-300 border border-rose-500/50 font-mono text-xs uppercase tracking-wider font-semibold transition-all active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2 shadow-lg"
                  >
                    <span>⚡ Tap to Interrupt (Barge-In)</span>
                  </button>
                )}

                <button
                  onClick={stop}
                  className="w-full py-3 px-5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-mono transition-all active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-rose-500" />
                  <span>End Session</span>
                </button>
              </div>
            )}

            {error && (
              <div className="w-full p-2.5 rounded-lg bg-rose-950/40 border border-rose-900 text-rose-300 text-xs font-mono text-center">
                {error}
              </div>
            )}
          </div>
        </section>

        {/* ── RIGHT COLUMN: Transcript (Independent smooth scroll) ──────── */}
        <section className="lg:col-span-7 flex flex-col rounded-2xl bg-zinc-900/40 border border-zinc-800/80 backdrop-blur-md overflow-hidden min-h-0 h-full">
          {/* Transcript Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/70 text-xs font-mono text-zinc-400 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 font-bold">●</span>
              <span className="text-zinc-200 font-medium tracking-wide">
                Dialogue Stream
              </span>
            </div>

            {transcripts.length > 0 && (
              <button
                onClick={() => window.location.reload()}
                className="text-zinc-400 hover:text-zinc-200 transition-colors text-xs px-2 py-1 rounded hover:bg-zinc-800/60"
              >
                Clear History
              </button>
            )}
          </div>

          {/* Scrollable Conversation Content */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5">
            <TranscriptView transcripts={transcripts} />
          </div>
        </section>
      </div>
    </main>
  );
}
