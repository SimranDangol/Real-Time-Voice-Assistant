export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  isFinal: boolean;
}

interface Props {
  transcripts: TranscriptEntry[];
}

export function TranscriptView({ transcripts }: Props) {
  if (transcripts.length === 0) {
    return (
      <p className="text-center text-sm" style={{ color: "var(--muted)" }}>
        Start speaking — your words will appear here in real time.
      </p>
    );
  }

  return (
    <div className="w-full max-w-2xl space-y-3">
      {transcripts.map((entry) => (
        <div
          key={entry.id}
          className="flex"
          style={{ justifyContent: entry.role === "user" ? "flex-end" : "flex-start" }}
        >
          <p
            className="max-w-xl rounded-xl px-3 py-2 text-lg leading-relaxed transition-all duration-150"
            style={{
              color: entry.isFinal ? "var(--text)" : "var(--muted)",
              fontStyle: entry.isFinal ? "normal" : "italic",
              background:
                entry.role === "user" ? "rgba(59, 130, 246, 0.12)" : "rgba(34, 197, 94, 0.12)",
              border: "1px solid var(--border)",
            }}
          >
            <span className="mr-2 text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              {entry.role === "user" ? "You" : "Assistant"}
            </span>
            {entry.text}
          </p>
        </div>
      ))}
    </div>
  );
}

