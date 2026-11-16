#!/usr/bin/env tsx
/**
 * Latency Report — p50 / p95 from server turn logs
 *
 * Usage:
 *   pnpm --dir eval latency
 *   # or: tsx eval/latency-report.ts [--log path/to/server.log]
 *
 * Reads newline-delimited JSON (pino format) from the server log file and
 * extracts every "metrics" event to compute per-stage latency percentiles.
 *
 * Log lines emitted by ws/session.ts look like:
 *   {"level":30,"sessionId":"...","turnId":"t1-...","ttfaMs":920,"llmFirstTokenMs":310,"sentence1Ms":480,"totalLlmMs":1240,"msg":"Turn metrics"}
 *
 * Outputs a formatted table suitable for pasting directly into the README.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TurnMetricsLogLine {
  turnId?: string;
  sessionId?: string;
  ttfaMs?: number | null;
  llmFirstTokenMs?: number | null;
  sentence1Ms?: number | null;
  totalLlmMs?: number | null;
  interrupted?: boolean;
  msg?: string;
}

interface StageStats {
  name: string;
  key: keyof TurnMetricsLogLine;
  unit: string;
  values: number[];
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((a, v) => a + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function fmt(n: number, unit: string): string {
  return isNaN(n) ? "  —  " : `${Math.round(n)}${unit}`;
}

// ── Parse log file ────────────────────────────────────────────────────────────

async function parseLogs(logPath: string): Promise<TurnMetricsLogLine[]> {
  const lines: TurnMetricsLogLine[] = [];
  const fileStream = fs.createReadStream(logPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TurnMetricsLogLine;
      // Accept lines that have at least one latency field
      if (
        typeof parsed.ttfaMs === "number" ||
        typeof parsed.llmFirstTokenMs === "number" ||
        typeof parsed.sentence1Ms === "number"
      ) {
        lines.push(parsed);
      }
    } catch {
      // Not JSON — skip (plain text log lines)
    }
  }

  return lines;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const logFlag = args.indexOf("--log");
const defaultLogPath = path.join(__dirname, "..", "apps", "server", "server.log");
const logPath =
  logFlag >= 0
    ? path.resolve(args[logFlag + 1])
    : defaultLogPath;

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║        Real-Time Voice Assistant — Latency Percentile Report          ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

if (!fs.existsSync(logPath)) {
  console.error(`❌  Log file not found: ${logPath}`);
  console.error("    Run the server and have a few conversations, then re-run this script.\n");
  process.exit(1);
}

const turns = await parseLogs(logPath);

if (turns.length === 0) {
  console.error("❌  No turn metric lines found in the log.");
  console.error('    Make sure the server emits lines with ttfaMs / llmFirstTokenMs fields.\n');
  process.exit(1);
}

console.log(`📄  Parsed ${turns.length} turn(s) from: ${logPath}\n`);

// ── Stage definitions ─────────────────────────────────────────────────────────

const stages: StageStats[] = [
  { name: "LLM First Token (TTFT)", key: "llmFirstTokenMs", unit: "ms", values: [] },
  { name: "Sentence 1 Complete",    key: "sentence1Ms",     unit: "ms", values: [] },
  { name: "Time to First Audio",    key: "ttfaMs",          unit: "ms", values: [] },
  { name: "Total LLM Duration",     key: "totalLlmMs",      unit: "ms", values: [] },
];

for (const turn of turns) {
  for (const stage of stages) {
    const v = turn[stage.key];
    if (typeof v === "number" && v > 0 && v < 30_000) {
      stage.values.push(v);
    }
  }
}

// ── Print table ───────────────────────────────────────────────────────────────

const col = (s: string, n: number) => s.padEnd(n);

console.log(
  col("Stage", 28),
  col("n", 6),
  col("p50", 10),
  col("p75", 10),
  col("p95", 10),
  col("Mean", 10),
  col("Min", 10),
  "Max"
);
console.log("─".repeat(96));

for (const stage of stages) {
  const sorted = [...stage.values].sort((a, b) => a - b);
  const n      = sorted.length;
  const avg    = mean(sorted);
  const p50    = percentile(sorted, 50);
  const p75    = percentile(sorted, 75);
  const p95    = percentile(sorted, 95);
  const min    = sorted[0];
  const max    = sorted[sorted.length - 1];

  console.log(
    col(stage.name, 28),
    col(String(n), 6),
    col(fmt(p50, stage.unit), 10),
    col(fmt(p75, stage.unit), 10),
    col(fmt(p95, stage.unit), 10),
    col(fmt(avg, stage.unit), 10),
    col(fmt(min, stage.unit), 10),
    fmt(max, stage.unit)
  );
}

// ── TTFA target check ────────────────────────────────────────────────────────

const ttfa = stages.find((s) => s.key === "ttfaMs")!;
const ttfaSorted = [...ttfa.values].sort((a, b) => a - b);
const ttfaP50 = percentile(ttfaSorted, 50);
const ttfaP95 = percentile(ttfaSorted, 95);

console.log("\n🎯  TTFA target: p50 ≤ 1000ms");
if (!isNaN(ttfaP50)) {
  const icon = ttfaP50 <= 1000 ? "✅" : "⚠️ ";
  console.log(`    ${icon}  p50 = ${Math.round(ttfaP50)}ms  |  p95 = ${Math.round(ttfaP95)}ms`);
}

// ── Interrupted turn stats ───────────────────────────────────────────────────

const interrupted = turns.filter((t) => t.interrupted).length;
const interruptPct = turns.length > 0 ? ((interrupted / turns.length) * 100).toFixed(1) : "0.0";
console.log(`\n⚡  Barge-in: ${interrupted}/${turns.length} turns interrupted (${interruptPct}%)`);

// ── Session breakdown ────────────────────────────────────────────────────────

const sessionMap = new Map<string, number>();
for (const turn of turns) {
  const sid = turn.sessionId ?? "unknown";
  sessionMap.set(sid, (sessionMap.get(sid) ?? 0) + 1);
}
console.log(`📡  Sessions: ${sessionMap.size}  |  Avg turns/session: ${(turns.length / Math.max(1, sessionMap.size)).toFixed(1)}`);

// ── README-ready table ────────────────────────────────────────────────────────

const ttftStage  = stages.find((s) => s.key === "llmFirstTokenMs")!;
const sent1Stage = stages.find((s) => s.key === "sentence1Ms")!;
const totalStage = stages.find((s) => s.key === "totalLlmMs")!;

const p50s = (stage: StageStats, p: number) => {
  const sorted = [...stage.values].sort((a, b) => a - b);
  return isNaN(percentile(sorted, p)) ? "—" : `${Math.round(percentile(sorted, p))}ms`;
};

console.log(`
┌──────────────────────────────────────────────────────────┐
│  README-ready summary (copy into evaluation table)        │
├──────────────────────────────────────────────────────────┤
│  LLM TTFT      p50=${p50s(ttftStage, 50).padEnd(8)} p95=${p50s(ttftStage, 95)}
│  Sentence 1    p50=${p50s(sent1Stage, 50).padEnd(8)} p95=${p50s(sent1Stage, 95)}
│  TTFA          p50=${p50s(ttfa, 50).padEnd(8)} p95=${p50s(ttfa, 95)}
│  Total LLM     p50=${p50s(totalStage, 50).padEnd(8)} p95=${p50s(totalStage, 95)}
│  Sessions: ${sessionMap.size}  Turns: ${turns.length}  Interrupted: ${interrupted} (${interruptPct}%)
└──────────────────────────────────────────────────────────┘
`);

console.log("✅  Latency report complete.\n");
