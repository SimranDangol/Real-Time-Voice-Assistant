import type { Logger } from "pino";
import { TOOLS, executeTool } from "../tools/index.js";
import { fetchWithRetry, getTimeoutMs } from "./request.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface StreamReplyOptions {
  prompt?: string;
  history?: ChatMessage[];
  onDelta?: (delta: string) => void;
  onPartial?: (fullText: string) => void;
  onFinal: (fullText: string) => void;
  onFirstToken?: () => void;
  onToolCall?: (toolName: string, args: Record<string, any>, result: string) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
  log: Logger;
}

export async function streamAssistantReply({
  prompt,
  history = [],
  onDelta,
  onPartial,
  onFinal,
  onFirstToken,
  onToolCall,
  onError,
  signal,
  log,
}: StreamReplyOptions): Promise<void> {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  let apiKey: string | undefined;
  let baseUrl: string;
  let model: string;

  if (groqKey && !openaiKey) {
    apiKey = groqKey;
    baseUrl = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
    model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
  } else {
    apiKey = openaiKey;
    baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  baseUrl = baseUrl.replace(/\/$/, "");

  if (!apiKey) {
    throw new Error("Neither OPENAI_API_KEY nor GROQ_API_KEY is configured in .env");
  }

  const systemMessage: ChatMessage = {
    role: "system",
    content:
      "You are a friendly, natural voice assistant. Keep answers brief (1-2 sentences maximum). Never use markdown, asterisks, bullet points, or lists. You have tools available for weather, current time, and reminders: call them when relevant.",
  };

  const messages: ChatMessage[] = [systemMessage, ...history];
  if (prompt) {
    messages.push({ role: "user", content: prompt });
  }

  // Helper to run a streaming chat completion request
  async function runStream(msgs: ChatMessage[]): Promise<{
    hasToolCalls: boolean;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    fullText: string;
  }> {
    const { response, dispose } = await fetchWithRetry(`${baseUrl}/chat/completions`, {
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
        tools: TOOLS,
        tool_choice: "auto",
        messages: msgs,
      }),
    }, {
      provider: "LLM",
      timeoutMs: getTimeoutMs("LLM_REQUEST_TIMEOUT_MS", 30_000),
      signal,
      log,
    });

    if (!response.body) {
      dispose();
      throw new Error("LLM response body is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let isFirstToken = true;

    // Collect streaming tool calls
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload) continue;

          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
            };

            const choice = parsed.choices?.[0];
            const deltaContent = choice?.delta?.content;
            const deltaToolCalls = choice?.delta?.tool_calls;

            // Accumulate tool calls if model decided to call tools
            if (deltaToolCalls && Array.isArray(deltaToolCalls)) {
              for (const tc of deltaToolCalls) {
                const idx = tc.index ?? 0;
                const existing = toolCallsMap.get(idx) ?? { id: "", name: "", arguments: "" };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallsMap.set(idx, existing);
              }
            }

            // Emit regular voice content
            if (typeof deltaContent === "string" && deltaContent.length > 0) {
              if (isFirstToken) {
                isFirstToken = false;
                onFirstToken?.();
              }
              fullText += deltaContent;
              onDelta?.(deltaContent);
              onPartial?.(fullText);
            }
          } catch (err) {
            log.warn({ errorName: err instanceof Error ? err.name : "unknown" }, "Skipping malformed LLM stream chunk");
          }
        }
      }

      const toolCalls = Array.from(toolCallsMap.values()).filter((t) => t.name.length > 0);
      return {
        hasToolCalls: toolCalls.length > 0,
        toolCalls,
        fullText,
      };
    } finally {
      reader.releaseLock();
      dispose();
    }
  }

  try {
    const firstPass = await runStream(messages);
    if (signal?.aborted) return;

    if (firstPass.hasToolCalls) {
      log.info({ toolCount: firstPass.toolCalls.length }, "LLM invoked voice tools");

      // Build assistant tool call message
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: firstPass.fullText || undefined,
        tool_calls: firstPass.toolCalls.map((tc) => ({
          id: tc.id || `call_${Date.now()}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of firstPass.toolCalls) {
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          parsedArgs = {};
        }

        const toolResult = await executeTool(tc.name, parsedArgs);
        onToolCall?.(tc.name, parsedArgs, toolResult);

        messages.push({
          role: "tool",
          tool_call_id: tc.id || assistantMsg.tool_calls?.[0]?.id,
          content: toolResult,
        });
      }

      // Stream the synthesized voice reply incorporating the tool output
      const secondPass = await runStream(messages);
      if (signal?.aborted) return;

      onFinal(secondPass.fullText.trim());
    } else {
      onFinal(firstPass.fullText.trim());
    }
  } catch (err) {
    if (signal?.aborted) {
      log.info("LLM stream aborted");
      return;
    }
    const error = err instanceof Error ? err : new Error("LLM provider request failed");
    onError(error);
  }
}
