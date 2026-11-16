import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureLogPath = path.join(__dirname, "fixtures", "synthetic-latency.jsonl");

fs.mkdirSync(path.dirname(fixtureLogPath), { recursive: true });

interface TurnEntry {
  level: number;
  time: number;
  pid: number;
  hostname: string;
  sessionId: string;
  turnId: string;
  ttfaMs: number | null;
  llmFirstTokenMs: number | null;
  sentence1Ms: number | null;
  totalLlmMs: number | null;
  interrupted: boolean;
  msg: string;
  synthetic: boolean;
}

// Randomized sample turns for latency-report parser checks only.
const sessions = [
  { id: "sess-9a4f-01", turns: 10, interrupts: [4, 9] },
  { id: "sess-9a4f-02", turns: 8,  interrupts: [3] },
  { id: "sess-9a4f-03", turns: 12, interrupts: [6, 11] },
  { id: "sess-9a4f-04", turns: 7,  interrupts: [] },
  { id: "sess-9a4f-05", turns: 8,  interrupts: [] },
];

const logLines: string[] = [];
let baseTime = Date.now() - 3600000; // 1 hour ago

// Helper for gaussian-ish random numbers
function rand(mean: number, std: number, min: number, max: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 0.001)) * Math.cos(2.0 * Math.PI * u2);
  const val = Math.round(mean + z * std);
  return Math.max(min, Math.min(max, val));
}

for (const sess of sessions) {
  // Session connect log
  logLines.push(
    JSON.stringify({
      level: 30,
      time: baseTime,
      pid: 14220,
      hostname: "synthetic-fixture",
      sessionId: sess.id,
      msg: "Session connected",
      synthetic: true,
    })
  );

  for (let t = 1; t <= sess.turns; t++) {
    const turnId = `t${t}-${sess.id.slice(-4)}`;
    baseTime += rand(15000, 4000, 8000, 30000);

    const isInterrupted = sess.interrupts.includes(t);
    const ttft = rand(285, 45, 195, 520);
    const sent1 = ttft + rand(185, 35, 110, 310);
    const ttfa = sent1 + rand(445, 65, 320, 680);
    const totalLlm = isInterrupted ? sent1 + rand(120, 30, 50, 200) : rand(1420, 240, 950, 2400);

    const entry: TurnEntry = {
      level: 30,
      time: baseTime,
      pid: 14220,
      hostname: "synthetic-fixture",
      sessionId: sess.id,
      turnId,
      ttfaMs: ttfa,
      llmFirstTokenMs: ttft,
      sentence1Ms: sent1,
      totalLlmMs: totalLlm,
      interrupted: isInterrupted,
      msg: isInterrupted ? "Turn metrics (interrupted)" : "Turn metrics",
      synthetic: true,
    };

    logLines.push(JSON.stringify(entry));
  }

  // Session teardown log
  logLines.push(
    JSON.stringify({
      level: 30,
      time: baseTime + 5000,
      pid: 14220,
      hostname: "synthetic-fixture",
      sessionId: sess.id,
      msg: "Session disconnected",
      synthetic: true,
    })
  );
}

fs.writeFileSync(fixtureLogPath, logLines.join("\n") + "\n", { encoding: "utf-8" });
console.log(`Wrote ${logLines.length} synthetic fixture lines to ${fixtureLogPath}`);
