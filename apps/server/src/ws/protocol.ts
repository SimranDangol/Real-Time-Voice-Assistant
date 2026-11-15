import { z } from "zod";

// ─── Client → Server ────────────────────────────────────────────────────────

export const StartMessageSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string().uuid(),
  token: z.string().optional(),
});

export const StopMessageSchema = z.object({
  type: z.literal("stop"),
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  StartMessageSchema,
  StopMessageSchema,
  PingMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Parse a raw JSON string into a typed client message. */
export function parseClientMessage(
  raw: string
): { success: true; data: ClientMessage } | { success: false } {
  try {
    const result = ClientMessageSchema.safeParse(JSON.parse(raw));
    return result;
  } catch {
    return { success: false };
  }
}

// ─── Server → Client (type-only, serialised manually) ───────────────────────

export type ServerMessage =
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
      /** "pcm" = server TTS audio arrives as binary frames; "browser" = use speechSynthesis. */
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
  | {
      /** Sent once per turn before its first binary PCM chunk; following binary
       *  frames belong to this turn until the next audio.turn message. */
      type: "audio.turn";
      turnId: string;
    }
  | { type: "interrupted"; turnId: string }
  | { type: "state"; state: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "pong" }
  | { type: "error"; code: string; retryable: boolean; message?: string };
