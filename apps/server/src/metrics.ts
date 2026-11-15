import client from "prom-client";

/**
 * Prometheus Registry & Observability Histograms (Section 3 & 8)
 */
export const prometheusRegistry = new client.Registry();

// Enable standard Node.js process metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register: prometheusRegistry, prefix: "voice_assistant_" });

export const ttfaHistogram = new client.Histogram({
  name: "voice_assistant_ttfa_ms",
  help: "Time to first audio (TTFA) in milliseconds",
  buckets: [200, 400, 600, 800, 1000, 1250, 1500, 2000, 3000, 5000],
  registers: [prometheusRegistry],
});

export const llmFirstTokenHistogram = new client.Histogram({
  name: "voice_assistant_llm_ttft_ms",
  help: "LLM time to first token (TTFT) in milliseconds",
  buckets: [100, 200, 300, 400, 500, 750, 1000, 1500, 2500],
  registers: [prometheusRegistry],
});

export const sentence1Histogram = new client.Histogram({
  name: "voice_assistant_sentence1_ms",
  help: "Time until first sentence completion in milliseconds",
  buckets: [100, 200, 300, 500, 750, 1000, 1500],
  registers: [prometheusRegistry],
});

export const activeSessionsGauge = new client.Gauge({
  name: "voice_assistant_active_sessions",
  help: "Current number of active voice WebSocket sessions",
  registers: [prometheusRegistry],
});

export const interruptedTurnsCounter = new client.Counter({
  name: "voice_assistant_interrupted_turns_total",
  help: "Total count of turns interrupted by barge-in",
  registers: [prometheusRegistry],
});

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
      const val = Math.round(this.llmFirstTokenTime - this.eosTime);
      llmFirstTokenHistogram.observe(val);
    }
  }

  public markSentence1(): void {
    if (this.sentence1Time === null) {
      this.sentence1Time = performance.now();
      const val = Math.round(this.sentence1Time - this.eosTime);
      sentence1Histogram.observe(val);
    }
  }

  public markFirstAudio(): void {
    if (this.firstAudioTime === null) {
      this.firstAudioTime = performance.now();
      const val = Math.round(this.firstAudioTime - this.eosTime);
      ttfaHistogram.observe(val);
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
