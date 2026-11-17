"use client";

import { useEffect, useRef } from "react";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  isFinal: boolean;
  toolCall?: { name: string; args: Record<string, any>; result: string };
  interrupted?: boolean;
}

interface Props {
  transcripts: TranscriptEntry[];
  onPromptClick?: (prompt: string) => void;
}

export function TranscriptView({ transcripts, onPromptClick }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  if (transcripts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 px-6 text-center text-slate-400">
        <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-center text-slate-300 text-lg mb-3">
          💬
        </div>
        <p className="text-sm font-medium text-slate-300 mb-1">
          No conversation history yet
        </p>
        <p className="text-xs text-slate-400 max-w-sm mb-6">
          Press the microphone button or try asking one of these prompts:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
          {[
            { tag: "REMINDER", text: "Remind me to drink water in 20 minutes" },
            { tag: "TIME", text: "What time is it in Tokyo right now?" },
            { tag: "WEATHER", text: "Is it raining in London today?" },
            { tag: "KNOWLEDGE", text: "Explain quantum computing in two sentences" },
            { tag: "CREATIVE", text: "Tell me a clever two-sentence joke" },
            { tag: "CAREER", text: "Give me 3 quick coding interview tips" },
          ].map((item) => (
            <div
              key={item.text}
              className="px-3.5 py-2.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/70 hover:border-zinc-700/80 transition-all text-left flex flex-col gap-1 cursor-default"
            >
              <span className="text-[9px] font-mono font-bold tracking-wider text-emerald-400/80 uppercase">
                {item.tag}
              </span>
              <span className="text-xs text-zinc-300 leading-snug">
                &ldquo;{item.text}&rdquo;
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-2 py-2">
      {transcripts.map((entry) => {
        if (entry.role === "tool") {
          return (
            <div key={entry.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs font-mono">
              <span className="text-amber-400 font-bold">⚡ TOOL</span>
              <span className="text-zinc-200 font-semibold">{entry.toolCall?.name}</span>
              <span className="text-zinc-400 truncate">
                {JSON.stringify(entry.toolCall?.args ?? {})}
              </span>
            </div>
          );
        }

        const isUser = entry.role === "user";

        return (
          <div
            key={entry.id}
            className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
          >
            <div className="flex items-center gap-2 mb-1 px-1">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                {isUser ? "You" : "Assistant"}
              </span>
              {!entry.isFinal && (
                <span className="text-[10px] font-mono text-emerald-400 animate-pulse">
                  transcribing...
                </span>
              )}
            </div>

            <div
              className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed transition-all ${
                isUser
                  ? "bg-zinc-800 text-zinc-100 border border-zinc-700/60"
                  : "bg-zinc-900/90 text-zinc-200 border border-zinc-800"
              } ${
                entry.interrupted
                  ? "border-rose-500/40 bg-rose-950/20"
                  : ""
              }`}
            >
              <div className="whitespace-pre-wrap">{entry.text}</div>

              {entry.interrupted && (
                <div className="mt-2 text-[11px] font-mono text-rose-400 flex items-center gap-1.5 pt-1.5 border-t border-rose-500/20">
                  <span>● Interrupted by user</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
