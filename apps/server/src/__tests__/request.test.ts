import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { fetchWithRetry } from "../providers/request.js";

const log = pino({ enabled: false });

describe("Provider request timeouts and retries", () => {
  it("retries one transient HTTP response", async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      "https://provider.test/stream",
      {},
      {
        provider: "test",
        timeoutMs: 1000,
        log,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? new Response("", { status: 503 }) : new Response("ok");
        },
      }
    );

    try {
      assert.equal(await result.response.text(), "ok");
      assert.equal(calls, 2);
    } finally {
      result.dispose();
    }
  });

  it("does not retry a non-transient client error", async () => {
    let calls = 0;
    await assert.rejects(
      fetchWithRetry(
        "https://provider.test/stream",
        {},
        {
          provider: "test",
          timeoutMs: 1000,
          log,
          fetchImpl: async () => {
            calls += 1;
            return new Response("", { status: 400 });
          },
        }
      ),
      /test request failed \(400\)/
    );
    assert.equal(calls, 1);
  });

  it("aborts a timed-out request and retries it only once", async () => {
    let calls = 0;
    await assert.rejects(
      fetchWithRetry(
        "https://provider.test/stream",
        {},
        {
          provider: "test",
          timeoutMs: 20,
          log,
          fetchImpl: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              calls += 1;
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true }
              );
            }),
        }
      ),
      /test request timed out after retry/
    );
    assert.equal(calls, 2);
  });
});
