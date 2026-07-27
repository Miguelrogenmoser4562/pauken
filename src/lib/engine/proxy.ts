import type {
  ChatMessage,
  CompletionOptions,
  Engine,
  EngineCapabilities,
  StructuredOptions,
  TokenHandler,
} from "./types";
import { EngineError } from "./types";

const UNSUPPORTED_MESSAGE =
  "This operation is not supported via the server proxy.";

export class ProxyEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider = "deepseek" as const;

  constructor(
    private readonly serverUrl: string,
    private readonly userKey: string,
  ) {}

  capabilities(): EngineCapabilities {
    return { chat: true, embeddings: false };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const res = await this.post("/api/ai/chat", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: true,
      ...thinkingParam(opts.tier),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    }, opts.signal);

    if (!res.body) throw new EngineError("Server returned an empty stream.", "unknown");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

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
            const delta: string | undefined = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              onToken?.(delta);
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new EngineError("Stream interrupted.", "network");
      }
      throw err;
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const toolName = opts.schemaName || "structured_output";
    const res = await this.post("/api/ai/chat?beta=1", {
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
      throw new EngineError("Server did not return a structured tool call.", "unknown");
    }
    return JSON.parse(toolCall.function.arguments) as T;
  }

  async embed(_texts: string[], _signal?: AbortSignal): Promise<number[][]> {
    throw new EngineError(UNSUPPORTED_MESSAGE, "unsupported");
  }

  async validate(): Promise<void> {
    const res = await fetch(`${this.serverUrl}/api/ai/status`, {
      headers: { authorization: `Bearer ${this.userKey}` },
    });
    const data = await res.json();
    if (!data.configured) {
      throw new EngineError("Server AI proxy is not configured (missing DEEPSEEK_API_KEY).", "auth");
    }
  }

  private resolveModel(tier?: "fast" | "strong"): string {
    return tier === "strong" ? "deepseek-v4-pro" : "deepseek-v4-flash";
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Server did not respond within 120 seconds.")), 120_000);
    if (signal) {
      if (signal.aborted) { clearTimeout(timeout); throw new EngineError("Request cancelled.", "network"); }
      signal.addEventListener("abort", () => { clearTimeout(timeout); controller.abort(signal.reason); }, { once: true });
    }
    try {
      const res = await fetch(`${this.serverUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${this.userKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || errBody?.error || `Server returned ${res.status}`;
        throw new EngineError(msg, mapStatus(res.status));
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof EngineError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new EngineError(err.message || "Server request timed out.", "network");
      }
      throw new EngineError(err instanceof Error ? err.message : "Network request failed.", "network");
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

function mapStatus(status: number): "auth" | "quota" | "rate_limit" | "network" | "model_missing" | "unknown" {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 403) return "model_missing";
  if (status >= 500) return "network";
  return "unknown";
}
