import type { Logger } from "pino";

export interface StreamReplyOptions {
  prompt: string;
  onDelta?: (delta: string) => void;
  onPartial?: (fullText: string) => void;
  onFinal: (fullText: string) => void;
  onFirstToken?: () => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
  log: Logger;
}

export async function streamAssistantReply({
  prompt,
  onDelta,
  onPartial,
  onFinal,
  onFirstToken,
  onError,
  signal,
  log,
}: StreamReplyOptions): Promise<void> {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  let apiKey = openaiKey || groqKey;
  let baseUrl = process.env.OPENAI_BASE_URL ?? (groqKey && !openaiKey ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1");
  let model = process.env.OPENAI_MODEL ?? (groqKey && !openaiKey ? "llama-3.3-70b-versatile" : "gpt-4o-mini");

  baseUrl = baseUrl.replace(/\/$/, "");

  if (!apiKey) {
    throw new Error("Neither OPENAI_API_KEY nor GROQ_API_KEY is configured in .env");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.7,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a friendly, natural voice assistant. Keep answers brief (1-3 sentences maximum). Avoid markdown, lists, or asterisks.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${details}`);
  }

  if (!response.body) {
    throw new Error("LLM response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let isFirstToken = true;

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") {
          continue;
        }

        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string };
            }>;
          };

          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            if (isFirstToken) {
              isFirstToken = false;
              onFirstToken?.();
            }
            fullText += delta;
            onDelta?.(delta);
            onPartial?.(fullText);
          }
        } catch (err) {
          log.warn({ err, payload }, "Skipping malformed LLM stream chunk");
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      log.info("LLM stream aborted");
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!signal?.aborted) {
    onFinal(fullText.trim());
  }
}
