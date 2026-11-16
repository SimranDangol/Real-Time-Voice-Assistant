#!/usr/bin/env tsx
/**
 * Word Error Rate (WER) Evaluation Script
 *
 * Usage:
 *   pnpm --dir eval wer
 *   # or: tsx eval/wer.ts [--manifest path/to/manifest.json]
 *
 * Reads eval/recordings/manifest.json which maps each audio file to a
 * reference transcript and an ASR hypothesis (the text Deepgram returned
 * during the recording session, stored in the manifest for offline eval).
 *
 * WER formula:
 *   WER = (S + D + I) / N
 *   where S = substitutions, D = deletions, I = insertions, N = reference words
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManifestEntry {
  id: string;
  file: string;
  reference: string;
  hypothesis: string;
  /** Optional tags for grouping: "accent" | "noise" | "fast" | "tool" | "barge-in" */
  tags?: string[];
  notes?: string;
}

interface WERResult {
  id: string;
  file: string;
  tags: string[];
  refWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  wer: number;
  cer: number;
}

// ── Levenshtein distance (word-level) ─────────────────────────────────────────

function editDistance(ref: string[], hyp: string[]): { s: number; d: number; i: number } {
  const m = ref.length;
  const n = hyp.length;

  // dp[i][j] = { cost, s, d, i } — cheapest alignment of ref[0..i] vs hyp[0..j]
  type Cell = { cost: number; s: number; d: number; ins: number };
  const dp: Cell[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => ({ cost: 0, s: 0, d: 0, ins: 0 }))
  );

  for (let i = 0; i <= m; i++) dp[i][0] = { cost: i, s: 0, d: i, ins: 0 };
  for (let j = 0; j <= n; j++) dp[0][j] = { cost: j, s: 0, d: 0, ins: j };

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = { ...dp[i - 1][j - 1] };
      } else {
        const sub  = { cost: dp[i-1][j-1].cost + 1, s: dp[i-1][j-1].s + 1, d: dp[i-1][j-1].d,     ins: dp[i-1][j-1].ins };
        const del  = { cost: dp[i-1][j].cost   + 1, s: dp[i-1][j].s,       d: dp[i-1][j].d + 1,   ins: dp[i-1][j].ins };
        const ins  = { cost: dp[i][j-1].cost   + 1, s: dp[i][j-1].s,       d: dp[i][j-1].d,       ins: dp[i][j-1].ins + 1 };
        dp[i][j] = [sub, del, ins].sort((a, b) => a.cost - b.cost)[0];
      }
    }
  }

  const { s, d, ins } = dp[m][n];
  return { s, d, i: ins };
}

function charEditDistance(ref: string, hyp: string): number {
  const m = ref.length, n = hyp.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ref[i-1] === hyp[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

// ── Normalise transcript text ─────────────────────────────────────────────────

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")          // curly apostrophes
    .replace(/[""]/g, '"')          // curly quotes
    .replace(/[^\w\s']/g, " ")      // strip punctuation (keep apostrophe for contractions)
    .replace(/\s+/g, " ")
    .trim();
}

function tokenise(text: string): string[] {
  return normalise(text).split(" ").filter(Boolean);
}

// ── Evaluate one entry ────────────────────────────────────────────────────────

function evaluate(entry: ManifestEntry): WERResult {
  const refWords = tokenise(entry.reference);
  const hypWords = tokenise(entry.hypothesis);
  const { s, d, i } = editDistance(refWords, hypWords);
  const wer = refWords.length === 0 ? 0 : (s + d + i) / refWords.length;

  const refChars = normalise(entry.reference).replace(/\s/g, "");
  const hypChars = normalise(entry.hypothesis).replace(/\s/g, "");
  const ced = charEditDistance(refChars, hypChars);
  const cer = refChars.length === 0 ? 0 : ced / refChars.length;

  return {
    id: entry.id,
    file: entry.file,
    tags: entry.tags ?? [],
    refWords: refWords.length,
    substitutions: s,
    deletions: d,
    insertions: i,
    wer,
    cer,
  };
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const manifestFlag = args.indexOf("--manifest");
const manifestPath =
  manifestFlag >= 0
    ? path.resolve(args[manifestFlag + 1])
    : path.join(__dirname, "recordings", "manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`\n❌  Manifest not found: ${manifestPath}`);
  console.error("    Create eval/recordings/manifest.json — see eval/recordings/manifest.json for the schema.\n");
  process.exit(1);
}

const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const results: WERResult[] = manifest.map(evaluate);

// ── Per-entry table ───────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║          Real-Time Voice Assistant — WER Evaluation Report           ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(
  pad("ID", 6),
  pad("File", 28),
  pad("Tags", 20),
  pad("Words", 7),
  pad("S", 4),
  pad("D", 4),
  pad("I", 4),
  pad("WER", 7),
  "CER"
);
console.log("─".repeat(90));

for (const r of results) {
  console.log(
    pad(r.id, 6),
    pad(path.basename(r.file), 28),
    pad(r.tags.join(","), 20),
    pad(r.refWords, 7),
    pad(r.substitutions, 4),
    pad(r.deletions, 4),
    pad(r.insertions, 4),
    pad(pct(r.wer), 7),
    pct(r.cer)
  );
}

// ── Aggregate stats ───────────────────────────────────────────────────────────

const totalRef = results.reduce((a, r) => a + r.refWords, 0);
const totalS   = results.reduce((a, r) => a + r.substitutions, 0);
const totalD   = results.reduce((a, r) => a + r.deletions, 0);
const totalI   = results.reduce((a, r) => a + r.insertions, 0);
const overallWER = totalRef === 0 ? 0 : (totalS + totalD + totalI) / totalRef;

const sortedWER = [...results.map((r) => r.wer)].sort((a, b) => a - b);
const p50WER = percentile(sortedWER, 50);
const p90WER = percentile(sortedWER, 90);

console.log("─".repeat(90));
console.log(`\n📊  Overall (corpus-level, N=${totalRef} words across ${results.length} recordings)`);
console.log(`    WER  : ${pct(overallWER)}  (S=${totalS} D=${totalD} I=${totalI})`);
console.log(`    p50 WER per utterance : ${pct(p50WER)}`);
console.log(`    p90 WER per utterance : ${pct(p90WER)}`);

// ── Tag breakdown ─────────────────────────────────────────────────────────────

const tagMap = new Map<string, WERResult[]>();
for (const r of results) {
  for (const tag of r.tags) {
    if (!tagMap.has(tag)) tagMap.set(tag, []);
    tagMap.get(tag)!.push(r);
  }
}

if (tagMap.size > 0) {
  console.log("\n🏷️   WER by tag:");
  for (const [tag, group] of [...tagMap.entries()].sort()) {
    const gRef = group.reduce((a, r) => a + r.refWords, 0);
    const gErr = group.reduce((a, r) => a + r.substitutions + r.deletions + r.insertions, 0);
    const gWER = gRef === 0 ? 0 : gErr / gRef;
    console.log(`    ${pad(tag, 12)} n=${group.length}  WER=${pct(gWER)}`);
  }
}

// ── Worst utterances ─────────────────────────────────────────────────────────

const worst = [...results].sort((a, b) => b.wer - a.wer).slice(0, 5);
console.log("\n⚠️   Top 5 hardest utterances:");
for (const r of worst) {
  const entry = manifest.find((e) => e.id === r.id)!;
  console.log(`    [${r.id}] WER=${pct(r.wer)}  ref: "${entry.reference.slice(0, 60)}"`);
  if (entry.notes) console.log(`         note: ${entry.notes}`);
}

console.log("\n✅  WER evaluation complete.\n");
