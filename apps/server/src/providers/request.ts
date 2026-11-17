import type { Logger } from "pino";

export interface TimedResponse {
  response: Response;
  dispose: () => void;
}

function createRequestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Provider request timed out"));
  }, timeoutMs);

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    provider: string;
    timeoutMs: number;
    signal?: AbortSignal;
    log: Logger;
    fetchImpl?: typeof fetch;
  }
): Promise<TimedResponse> {
  const parentSignal = options.signal ?? init.signal ?? undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  let timedOut = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const request = createRequestSignal(parentSignal, options.timeoutMs);
    const onTimeout = () => {
      timedOut = true;
    };
    request.signal.addEventListener("abort", onTimeout, { once: true });

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: request.signal });
    } catch (error) {
      request.dispose();
      if (parentSignal?.aborted) throw parentSignal.reason ?? error;
      if (attempt === 0) {
        options.log.warn(
          { provider: options.provider, errorName: error instanceof Error ? error.name : "unknown" },
          "Provider request failed before response; retrying once"
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw new Error(
        `${options.provider} request ${timedOut ? "timed out" : "failed"} after retry`
      );
    }

    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      if (attempt === 0) {
        await response.body?.cancel();
        request.dispose();
        options.log.warn(
          { provider: options.provider, status: response.status },
          "Provider returned a transient error; retrying once"
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
    }

    if (!response.ok) {
      await response.body?.cancel();
      request.dispose();
      throw new Error(`${options.provider} request failed (${response.status})`);
    }

    return {
      response,
      dispose() {
        request.signal.removeEventListener("abort", onTimeout);
        request.dispose();
      },
    };
  }

  throw new Error(`${options.provider} request failed after retry`);
}

export function getTimeoutMs(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1000 || value > 120_000) {
    throw new Error(`${name} must be an integer between 1000 and 120000`);
  }
  return value;
}
