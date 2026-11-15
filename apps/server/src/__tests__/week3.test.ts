import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { BargeInManager } from "../pipeline/bargein.js";
import { issueToken, verifyToken } from "../auth.js";
import { executeTool } from "../tools/index.js";
import { checkRateLimit, setCachedToolResult, getCachedToolResult, closeRedis } from "../redis.js";
import { prometheusRegistry, TurnTimer } from "../metrics.js";

describe("Week 3: Barge-in & Turn Management", () => {
  it("creates turns and generates unique turn IDs", () => {
    const manager = new BargeInManager();
    const turn1 = manager.startTurn("Hello assistant");
    assert.match(turn1.turnId, /^t1-/);
    assert.equal(manager.getActiveTurn()?.userPrompt, "Hello assistant");

    const turn2 = manager.startTurn("Second query");
    assert.match(turn2.turnId, /^t2-/);
    assert.equal(manager.getActiveTurn()?.userPrompt, "Second query");
  });

  it("trims conversation history to only spoken sentences on barge-in", () => {
    const manager = new BargeInManager();
    const { turnId } = manager.startTurn("Tell me a story");

    manager.recordSpokenSentence(turnId, "Once upon a time there was a traveler.");
    // Assistant was about to say "They walked for three days.", but user interrupted!

    const interrupted = manager.interrupt();
    assert.ok(interrupted);
    assert.equal(interrupted.turnId, turnId);
    assert.equal(interrupted.spokenText, "Once upon a time there was a traveler.");

    const history = manager.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].role, "user");
    assert.equal(history[0].content, "Tell me a story");
    assert.equal(history[1].role, "assistant");
    assert.equal(history[1].content, "Once upon a time there was a traveler.");
  });

  it("stores full text on completed turns", () => {
    const manager = new BargeInManager();
    const { turnId } = manager.startTurn("What is 2 + 2?");
    manager.completeTurn(turnId, "Two plus two equals four.");

    const history = manager.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[1].content, "Two plus two equals four.");
  });
});

describe("Week 3: Short-Lived JWT Authentication", () => {
  it("issues and verifies valid JWT tokens", () => {
    const sessionId = "session-12345";
    const ip = "127.0.0.1";
    const { token, expiresIn } = issueToken(sessionId, ip);

    assert.ok(token);
    assert.equal(expiresIn, 600);

    const verified = verifyToken(token);
    assert.ok(verified);
    assert.equal(verified.sessionId, sessionId);
    assert.equal(verified.ip, ip);
  });

  it("rejects invalid or tampered tokens", () => {
    const verified = verifyToken("invalid.token.payload");
    assert.equal(verified, null);
  });
});

describe("Week 3: Voice Tools", () => {
  it("executes get_current_time tool", async () => {
    const result = await executeTool("get_current_time", { location: "Pokhara" });
    assert.match(result, /time in Nepal is/i);
  });

  it("executes set_reminder tool", async () => {
    const result = await executeTool("set_reminder", { task: "call mom", time: "5 PM" });
    assert.equal(result, "I have set a reminder to call mom for 5 PM.");
  });

  it("executes get_weather with caching", async () => {
    const result = await executeTool("get_weather", { location: "Pokhara" });
    assert.match(result, /Pokhara/i);

    // Verify cache was set
    const cached = await getCachedToolResult("weather:pokhara");
    assert.ok(cached);
    assert.equal(cached, result);
  });
});

describe("Week 3: Rate Limiting & Cache", () => {
  it("enforces sliding/window rate limits", async () => {
    const testKey = `test-user-${Date.now()}`;
    const first = await checkRateLimit(testKey, 2, 10);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);

    const second = await checkRateLimit(testKey, 2, 10);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);

    const third = await checkRateLimit(testKey, 2, 10);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
  });

  it("stores and retrieves short-lived cache entries", async () => {
    const key = `cache-test-${Date.now()}`;
    await setCachedToolResult(key, "cached-value", 60);

    const retrieved = await getCachedToolResult(key);
    assert.equal(retrieved, "cached-value");
  });
});

describe("Week 3: Prometheus Observability Metrics", () => {
  it("observes turn latency in Prometheus histograms", async () => {
    const timer = new TurnTimer("t-test-metrics");
    timer.markLlmFirstToken();
    timer.markSentence1();
    timer.markFirstAudio();

    const output = await prometheusRegistry.metrics();
    assert.match(output, /voice_assistant_ttfa_ms_bucket/);
    assert.match(output, /voice_assistant_llm_ttft_ms_bucket/);
    assert.match(output, /voice_assistant_sentence1_ms_bucket/);
  });

  after(async () => {
    await closeRedis();
  });
});
