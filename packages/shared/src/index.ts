import { z } from "zod";

/**
 * WebSocket Protocol & Shared Types for Real-Time Voice Assistant
 */

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

// ── Client Message Schemas ────────────────────────────────────────────────────

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

// ── Server Message Types ──────────────────────────────────────────────────────

export interface ToolCallPayload {
  tool: string;
  args: Record<string, any>;
  result: string;
}

export type ServerMessage =
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "assistant.text"; delta: string }
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
  | {
      type: "audio.turn";
      turnId: string;
    }
  | { type: "interrupted"; turnId: string }
  | { type: "state"; state: AssistantState }
  | { type: "pong" }
  | { type: "error"; code: string; retryable: boolean; message?: string };

// ── Per-Turn Metric Definitions ───────────────────────────────────────────────

export interface TurnLatencyMetrics {
  turnId: string;
  eosMs: number;
  llmFirstTokenMs: number | null;
  sentence1Ms: number | null;
  ttfaMs: number | null;
  totalLlmMs: number | null;
  interrupted?: boolean;
}
