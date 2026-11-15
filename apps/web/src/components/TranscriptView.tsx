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
}

export function TranscriptView({ transcripts }: Props) {
  if (transcripts.length === 0) {
    return (
      <p className="text-center text-sm" style={{ color: "var(--muted)" }}>
        Start speaking — your words will appear here in real time. Try asking: &quot;What&apos;s the weather in Pokhara?&quot; or &quot;What time is it in London?&quot;
      </p>
    );
  }

  return (
    <div className="w-full max-w-2xl space-y-3">
      {transcripts.map((entry) => {
        if (entry.role === "tool") {
          return (
            <div key={entry.id} className="flex justify-center my-1">
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono"
                style={{
                  background: "rgba(234, 179, 8, 0.12)",
                  border: "1px solid rgba(234, 179, 8, 0.3)",
                  color: "#facc15",
                }}
              >
                <span>⚡ Voice Tool:</span>
                <span className="font-semibold">{entry.toolCall?.name}</span>
                <span className="opacity-80">({JSON.stringify(entry.toolCall?.args)})</span>
              </div>
            </div>
          );
        }

        return (
          <div
            key={entry.id}
            className="flex flex-col"
            style={{ alignItems: entry.role === "user" ? "flex-end" : "flex-start" }}
          >
            <p
              className="max-w-xl rounded-xl px-3 py-2 text-base leading-relaxed transition-all duration-150"
              style={{
                color: entry.isFinal ? "var(--text)" : "var(--muted)",
                fontStyle: entry.isFinal ? "normal" : "italic",
                background:
                  entry.role === "user" ? "rgba(59, 130, 246, 0.12)" : "rgba(34, 197, 94, 0.12)",
                border: entry.interrupted
                  ? "1px dashed rgba(239, 68, 68, 0.6)"
                  : "1px solid var(--border)",
              }}
            >
              <span className="mr-2 text-xs uppercase tracking-wide font-semibold opacity-75">
                {entry.role === "user" ? "You:" : "Assistant:"}
              </span>
              {entry.text}
              {entry.interrupted && (
                <span
                  className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold"
                  style={{ background: "rgba(239, 68, 68, 0.2)", color: "#ef4444" }}
                >
                  Interrupted
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
