import type { ChatMessage } from "../providers/llm.js";
import { logger } from "../logger.js";

export interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  userPrompt: string;
  spokenSentences: string[];
  fullAssistantText: string;
  startTime: number;
}

export class BargeInManager {
  private activeTurn: ActiveTurn | null = null;
  private conversationHistory: ChatMessage[] = [];
  private turnCounter = 0;

  /** Create a new turn, aborting any existing active turn. */
  startTurn(userPrompt: string): { turnId: string; controller: AbortController } {
    if (this.activeTurn) {
      this.interrupt();
    }

    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}-${Date.now().toString(36)}`;
    const controller = new AbortController();

    this.activeTurn = {
      turnId,
      controller,
      userPrompt,
      spokenSentences: [],
      fullAssistantText: "",
      startTime: Date.now(),
    };

    // Append user message to history
    this.conversationHistory.push({
      role: "user",
      content: userPrompt,
    });

    return { turnId, controller };
  }

  getActiveTurn(): ActiveTurn | null {
    return this.activeTurn;
  }

  recordSpokenSentence(turnId: string, sentence: string): void {
    if (this.activeTurn && this.activeTurn.turnId === turnId) {
      this.activeTurn.spokenSentences.push(sentence);
    }
  }

  setFullAssistantText(turnId: string, text: string): void {
    if (this.activeTurn && this.activeTurn.turnId === turnId) {
      this.activeTurn.fullAssistantText = text;
    }
  }

  /**
   * Triggers barge-in:
   * 1. Aborts the LLM stream and active turn operations via AbortController.
   * 2. Trims conversation history so future turns only remember what the user actually heard.
   */
  interrupt(): { turnId: string; spokenText: string } | null {
    if (!this.activeTurn) return null;

    const { turnId, controller, spokenSentences } = this.activeTurn;
    controller.abort();

    // History trimming: join only the sentences that were actually spoken
    const spokenText = spokenSentences.join(" ").trim();
    if (spokenText) {
      this.conversationHistory.push({
        role: "assistant",
        content: spokenText,
      });
    }

    logger.info(
      { turnId, spokenSentencesCount: spokenSentences.length, spokenText },
      "Turn interrupted by barge-in — history trimmed to spoken text only"
    );

    this.activeTurn = null;
    return { turnId, spokenText };
  }

  /**
   * Finalises a successfully completed turn.
   */
  completeTurn(turnId: string, fullText: string): void {
    if (this.activeTurn && this.activeTurn.turnId === turnId) {
      this.conversationHistory.push({
        role: "assistant",
        content: fullText,
      });
      this.activeTurn = null;
    }
  }

  getHistory(): ChatMessage[] {
    // Keep max recent 10 messages to maintain latency & context
    if (this.conversationHistory.length > 10) {
      return this.conversationHistory.slice(-10);
    }
    return [...this.conversationHistory];
  }

  clear(): void {
    if (this.activeTurn) {
      this.activeTurn.controller.abort();
      this.activeTurn = null;
    }
    this.conversationHistory = [];
  }
}
