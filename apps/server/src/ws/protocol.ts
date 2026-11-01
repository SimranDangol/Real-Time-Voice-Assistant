import { z } from "zod";

// ─── Client → Server ────────────────────────────────────────────────────────

export const StartMessageSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string().uuid(),
});

export const StopMessageSchema = z.object({
  type: z.literal("stop"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  StartMessageSchema,
  StopMessageSchema,
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
    }
  | {
      type: "metrics";
      turnId: string;
      ttfaMs: number | null;
      llmFirstTokenMs: number | null;
      sentence1Ms: number | null;
      totalLlmMs?: number | null;
    }
  | { type: "interrupted"; turnId: string }
  | { type: "error"; code: string; retryable: boolean };
