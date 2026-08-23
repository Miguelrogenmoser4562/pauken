import type {
  ChatMessage,
  CompletionOptions,
  Engine,
  EngineCapabilities,
  StructuredOptions,
  TokenHandler,
} from "./types";
import { EngineError } from "./types";

const BASE_URL = "https://api.deepseek.com/v1";
const BETA_BASE_URL = "https://api.deepseek.com/beta";

const UNSUPPORTED_MESSAGE =
  "DeepSeek does not support this operation; use OpenAI or local models.";

export class DeepSeekEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider = "deepseek" as const;

  constructor(
    private readonly apiKey: string,
    private readonly modelOverride?: string,
  ) {}

  capabilities(): EngineCapabilities {
    return { chat: true, embeddings: false };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const res = await this.post("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: true,
      ...thinkingParam(opts.tier),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    }, opts.signal);

    if (!res.body) throw new EngineError("DeepSeek returned an empty stream.", "unknown");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finishReason: string | undefined;
    let sawReasoning = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            const delta: string | undefined = choice?.delta?.content;
            if (delta) {
              full += delta;
              onToken?.(delta);
            }
            if (choice?.delta?.reasoning_content) sawReasoning = true;
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          } catch {
            /* skip malformed SSE chunk */
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new EngineError("DeepSeek response stream interrupted.", "network");
      }
      throw err;
    }
    if (!full.trim() && finishReason !== undefined) {
      throw new EngineError(
        `DeepSeek returned no content (finish_reason=${finishReason}` +
          (sawReasoning ? ", model produced only reasoning tokens)" : ")") +
          ". The response stream carried no usable text.",
        "unknown",
      );
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const toolName = opts.schemaName || "structured_output";
    const res = await this.postBeta("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: false,
      thinking: { type: "disabled" },
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      tools: [
        {
          type: "function",
          function: {
            name: toolName,
            description: `Produce output matching the ${toolName} schema.`,
            strict: true,
            parameters: opts.schema as Record<string, unknown>,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: toolName } },
    }, opts.signal);

    const json = await res.json();
    const choice = json.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function?.name !== toolName) {
      const raw = JSON.stringify(json);
      throw new EngineError(
        `DeepSeek did not return a structured tool call (${toolName}). ` +
          `Model: ${this.resolveModel(opts.tier)}. Raw: ${raw.slice(0, 1000)}`,
        "unknown",
      );
    }
    return JSON.parse(toolCall.function.arguments) as T;
  }

  async embed(_texts: string[], _signal?: AbortSignal): Promise<number[][]> {
    throw new EngineError(UNSUPPORTED_MESSAGE, "unsupported");
  }

  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/models`, {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (res.status === 401) throw new EngineError("Invalid DeepSeek API key.", "auth");
    if (res.status === 402) throw new EngineError("Insufficient balance. Top up at https://platform.deepseek.com/top_up.", "quota");
    if (!res.ok) throw await mapError(res);
  }

  private resolveModel(tier?: "fast" | "strong"): string {
    if (this.modelOverride) return this.modelOverride;
    return tier === "strong" ? "deepseek-v4-pro" : "deepseek-v4-flash";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("DeepSeek API did not respond within 120 seconds.")), 120_000);
    if (signal) {
      if (signal.aborted) { clearTimeout(timeout); throw new EngineError("Request cancelled.", "network"); }
      signal.addEventListener("abort", () => { clearTimeout(timeout); controller.abort(signal.reason); }, { once: true });
    }
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw await mapError(res);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new EngineError(err.message || "DeepSeek request timed out.", "network");
      }
      throw toNetworkError(err);
    }
  }

  private async postBeta(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("DeepSeek API did not respond within 120 seconds.")), 120_000);
    if (signal) {
      if (signal.aborted) { clearTimeout(timeout); throw new EngineError("Request cancelled.", "network"); }
      signal.addEventListener("abort", () => { clearTimeout(timeout); controller.abort(signal.reason); }, { once: true });
    }
    try {
      const res = await fetch(`${BETA_BASE_URL}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw await mapError(res);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new EngineError(err.message || "DeepSeek request timed out.", "network");
      }
      throw toNetworkError(err);
    }
  }
}

function buildMessages(opts: CompletionOptions): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  if (opts.system) out.push({ role: "system", content: opts.system });
  for (const m of opts.messages as ChatMessage[]) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function thinkingParam(tier?: "fast" | "strong"): Record<string, unknown> {
  if (tier === "strong") {
    return { thinking: { type: "enabled" }, reasoning_effort: "high" };
  }
  return { thinking: { type: "disabled" } };
}

function toNetworkError(err: unknown): EngineError {
  if (err instanceof Error && err.name === "AbortError") throw err;
  const message = err instanceof Error ? err.message : "Network request failed.";
  return new EngineError(message, "network");
}

async function mapError(res: Response): Promise<EngineError> {
  let message = res.statusText || "DeepSeek request failed.";
  let raw = "";
  try {
    const body = await res.json();
    raw = JSON.stringify(body);
    const em = body?.error?.message;
    if (typeof em === "string" && em) message = em;
  } catch {
    raw = "";
  }
  const suffix = raw ? `\nRaw response: ${raw.slice(0, 1000)}` : "";
  if (res.status === 401) return new EngineError(message + suffix, "auth");
  if (res.status === 402) return new EngineError(message + suffix, "quota");
  if (res.status === 429) return new EngineError(message + suffix, "rate_limit");
  if (res.status === 403) return new EngineError(message + suffix, "model_missing");
  return new EngineError(message + suffix, "unknown");
}
