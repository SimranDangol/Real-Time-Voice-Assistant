/**
 * Per-Turn Latency Tracking & Metrics
 */

export interface TurnMetrics {
  turnId: string;
  eosMs: number;
  llmFirstTokenMs: number | null;
  sentence1Ms: number | null;
  ttfaMs: number | null;
  totalLlmMs: number | null;
}

export class TurnTimer {
  public readonly turnId: string;
  private readonly eosTime: number;
  private llmFirstTokenTime: number | null = null;
  private sentence1Time: number | null = null;
  private firstAudioTime: number | null = null;
  private llmEndTime: number | null = null;

  constructor(turnId: string) {
    this.turnId = turnId;
    this.eosTime = performance.now();
  }

  public markLlmFirstToken(): void {
    if (this.llmFirstTokenTime === null) {
      this.llmFirstTokenTime = performance.now();
    }
  }

  public markSentence1(): void {
    if (this.sentence1Time === null) {
      this.sentence1Time = performance.now();
    }
  }

  public markFirstAudio(): void {
    if (this.firstAudioTime === null) {
      this.firstAudioTime = performance.now();
    }
  }

  public markLlmEnd(): void {
    if (this.llmEndTime === null) {
      this.llmEndTime = performance.now();
    }
  }

  public getMetrics(): TurnMetrics {
    const calc = (ts: number | null) => (ts !== null ? Math.round(ts - this.eosTime) : null);

    return {
      turnId: this.turnId,
      eosMs: Math.round(this.eosTime),
      llmFirstTokenMs: calc(this.llmFirstTokenTime),
      sentence1Ms: calc(this.sentence1Time),
      ttfaMs: calc(this.firstAudioTime),
      totalLlmMs: calc(this.llmEndTime),
    };
  }
}

