/* OpenAI implementation of the Engine interface. Cloud mode, provider "openai".
   Uses the OpenAI REST API directly via `fetch` — no SDK dependency. */

import type {
  ChatMessage,
  CompletionOptions,
  Engine,
  EngineCapabilities,
  OcrOptions,
  StructuredOptions,
  TokenHandler,
} from "./types";
import { EngineError } from "./types";

const BASE_URL = "https://api.openai.com/v1";

export class OpenAIEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider = "openai" as const;

  constructor(
    private readonly apiKey: string,
    private readonly modelOverride?: string,
  ) {}

  capabilities(): EngineCapabilities {
    return { chat: true, embeddings: true, vision: true };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const res = await this.post("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    }, opts.signal);

    if (!res.body) throw new EngineError("OpenAI returned an empty stream.", "unknown");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

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
        } catch {
          /* malformed SSE chunk; skip it */
        }
      }
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const res = await this.post("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: false,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
      },
    }, opts.signal);

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new EngineError("OpenAI returned no structured content.", "unknown");
    }
    return JSON.parse(content) as T;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await this.post("/embeddings", {
      model: "text-embedding-3-small",
      input: texts,
    }, signal);
    const json = await res.json();
    return (json.data ?? []).map((d: { embedding: number[] }) => d.embedding);
  }

  async ocrImage(dataUrl: string, opts?: OcrOptions): Promise<string> {
    /* Native PDF input: OpenAI can read the file directly (extracting both
       text and images). Sending a base64 PDF as an image_url makes the model
       "see" nothing coherent, so route PDFs to a `file` content block. */
    const isPdf = dataUrl.startsWith("data:application/pdf");
    const contentBlock = isPdf
      ? {
          type: "file" as const,
          file: {
            file_data: dataUrl,
            filename: opts?.filename ?? "document.pdf",
          },
        }
      : {
          type: "image_url" as const,
          image_url: { url: dataUrl, detail: "high" as const },
        };
    const res = await this.post("/chat/completions", {
      model: opts?.model ?? "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts?.system ?? "Transcribe the content of this document as Markdown." },
            contentBlock,
          ],
        },
      ],
      stream: false,
      max_tokens: 4096,
    }, opts?.signal);

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new EngineError("OpenAI returned no OCR content.", "unknown");
    }
    const trimmed = content.trim();
    if (!trimmed) {
      throw new EngineError("OpenAI returned empty OCR content.", "unknown");
    }
    if (
      /unable to (transcribe|read)|i(?:'| a)m (?:unable|sorry|not able)|can'?t (?:transcribe|read)|i cannot (?:transcribe|read)/i.test(
        trimmed,
      )
    ) {
      throw new EngineError(
        "The OCR model couldn't read this page. The scan may be too blurry or " +
          "too low-resolution. Try re-capturing it at higher quality, or paste the text directly.",
        "unknown",
      );
    }
    return trimmed;
  }

  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/models`, { method: "GET", headers: this.headers() });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (res.status === 401) throw new EngineError("Invalid OpenAI API key.", "auth");
    if (!res.ok) throw await mapError(res);
  }

  private resolveModel(tier?: "fast" | "strong"): string {
    if (this.modelOverride) return this.modelOverride;
    return tier === "strong" ? "gpt-4o" : "gpt-4o-mini";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /* Shared POST helper: sends JSON, handles network failure + non-2xx mapping. */
  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await mapError(res);
    return res;
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

/* User-initiated cancellation should surface as a native AbortError, not get
   reinterpreted as a network failure. */
function toNetworkError(err: unknown): EngineError {
  if (err instanceof Error && err.name === "AbortError") throw err;
  const message = err instanceof Error ? err.message : "Network request failed.";
  return new EngineError(message, "network");
}

async function mapError(res: Response): Promise<EngineError> {
  let message = res.statusText || "OpenAI request failed.";
  let code: string | undefined;
  let type: string | undefined;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
    code = body?.error?.code;
    type = body?.error?.type;
  } catch {
    /* body wasn't JSON */
  }
  /* OpenAI returns HTTP 429 for both rate limits and quota exhaustion — check
     the error code first so quota errors aren't misreported as rate_limit. */
  if (code === "insufficient_quota" || type === "insufficient_quota") {
    return new EngineError(message, "quota");
  }
  /* Project-scoped keys can be missing access to specific models (e.g. TTS).
     Surface that as a clear, actionable message rather than a raw API error. */
  if (
    code === "model_not_found" ||
    /does not have access to model|model_not_found|must be verified to use the model/i.test(
      message,
    )
  ) {
    return new EngineError(
      `${message} — enable this model for your OpenAI project at platform.openai.com → Settings → Project → Limits.`,
      "model_missing",
    );
  }
  if (res.status === 401) return new EngineError(message, "auth");
  if (res.status === 429) return new EngineError(message, "rate_limit");
  if (res.status === 403) return new EngineError(message, "model_missing");
  return new EngineError(message, "unknown");
}
