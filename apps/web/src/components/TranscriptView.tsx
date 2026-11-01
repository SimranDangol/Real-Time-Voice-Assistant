export interface TranscriptEntry {
  id: string;
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
    <div className="w-full max-w-2xl space-y-2">
      {transcripts.map((entry) => (
        <p
          key={entry.id}
          className="text-lg leading-relaxed transition-all duration-150"
          style={{
            color: entry.isFinal ? "var(--text)" : "var(--muted)",
            fontStyle: entry.isFinal ? "normal" : "italic",
          }}
        >
          {entry.text}
        </p>
      ))}
    </div>
  );
}

