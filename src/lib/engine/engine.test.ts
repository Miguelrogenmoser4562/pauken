import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEngine } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { DeepSeekEngine } from "./deepseek";
import { createEngine } from "./index";
import { EngineError } from "./types";

/* Builds a fake streaming Response whose body yields the given raw SSE/NDJSON
   chunks one at a time, mirroring how a real fetch ReadableStream arrives. */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* Typed wrapper around vi.fn() so `.mock.calls[n]` comes back as
   [url, init?] instead of an inferred empty tuple. */
function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIEngine", () => {
  it("complete() streams tokens and returns concatenated text", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    const tokens: string[] = [];
    const text = await engine.complete(
      { messages: [{ role: "user", content: "hi" }] },
      (t) => tokens.push(t),
    );

    expect(text).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(true);
  });

  it("complete() uses the strong-tier model and a constructor override", async () => {
    const fetchMock = mockFetch(async () => streamResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const strong = new OpenAIEngine("sk-test");
    await strong.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe("gpt-4o");

    const overridden = new OpenAIEngine("sk-test", "gpt-4o-2024-08-06");
    await overridden.complete({ messages: [{ role: "user", content: "hi" }], tier: "fast" });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).model).toBe("gpt-4o-2024-08-06");
  });

  it("structured() parses the JSON content returned by the model", async () => {
    const payload = { name: "Ada", age: 30 };
    const fetchMock = mockFetch(async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    const result = await engine.structured<typeof payload>({
      messages: [{ role: "user", content: "extract the person" }],
      schema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
      schemaName: "person",
    });

    expect(result).toEqual(payload);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "person", schema: expect.any(Object), strict: true },
    });
  });

  it("ocrImage() sends a vision message and returns the transcribed text", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ choices: [{ message: { content: "  $x^2 + y^2 = z^2$  " } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    const text = await engine.ocrImage("data:image/png;base64,AAAA", {
      system: "Transcribe this math.",
    });

    expect(text).toBe("$x^2 + y^2 = z^2$");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Transcribe this math." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
    ]);
  });

  it("ocrImage() honors a model override via opts", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ choices: [{ message: { content: "text" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    await engine.ocrImage("data:image/png;base64,AAAA", { model: "gpt-4o" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe("gpt-4o");
  });

  it("ocrImage() throws on empty content instead of returning it", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ choices: [{ message: { content: "   " } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenAIEngine("sk-test").ocrImage("data:image/png;base64,AAAA"),
    ).rejects.toThrow(/empty OCR content/i);
  });

  it("ocrImage() throws when the model refuses to transcribe the image", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content:
                "I'm unable to transcribe the content of that image. If you can " +
                "provide the text or describe the content, I'd be happy to help!",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenAIEngine("sk-test").ocrImage("data:image/png;base64,AAAA"),
    ).rejects.toThrow(/couldn't read this page|too low-resolution/i);
  });

  it("capabilities() advertises vision", () => {
    expect(new OpenAIEngine("sk-test").capabilities()).toEqual({
      chat: true,
      embeddings: true,
      vision: true,
    });
  });

  it("maps a 401 response to an auth EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => jsonResponse({ error: { message: "Incorrect API key" } }, 401)),
    );
    const engine = new OpenAIEngine("sk-bad");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "auth" });
  });

  it("maps insufficient_quota to a quota EngineError even on HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () =>
        jsonResponse({ error: { message: "You exceeded your quota", code: "insufficient_quota" } }, 429),
      ),
    );
    const engine = new OpenAIEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "EngineError", kind: "quota" });
  });

  it("wraps a network failure as a network EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const engine = new OpenAIEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "EngineError", kind: "network" });
  });
});

describe("AnthropicEngine", () => {
  it("complete() parses the Anthropic content_block_delta SSE stream", async () => {
    const chunks = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: " there" },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new AnthropicEngine("sk-ant-test");
    const text = await engine.complete({
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(text).toBe("Hi there");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("claude-3-5-haiku-latest");
    expect(body.system[0].text).toBe("Be terse.");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("structured() sends a forced tool_choice and parses tool_use input", async () => {
    const payload = { title: "Photosynthesis", topic: "biology" };
    const fetchMock = mockFetch(async () =>
      jsonResponse({ content: [{ type: "tool_use", name: "note", input: payload }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new AnthropicEngine("sk-ant-test");
    const result = await engine.structured<typeof payload>({
      messages: [{ role: "user", content: "extract" }],
      schema: { type: "object" },
      schemaName: "note",
    });

    expect(result).toEqual(payload);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.tool_choice).toEqual({ type: "tool", name: "note" });
    expect(body.tools[0].name).toBe("note");
  });

  it("embed() throws kind unsupported", async () => {
    const engine = new AnthropicEngine("sk-ant-test");
    await expect(engine.embed(["hello"])).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("capabilities() reports no embeddings", () => {
    const engine = new AnthropicEngine("sk-ant-test");
    expect(engine.capabilities()).toEqual({
      chat: true,
      embeddings: false,
      vision: false,
    });
  });

  it("validate() maps a 401 to an auth EngineError", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { message: "bad key" } }, 401)));
    const engine = new AnthropicEngine("sk-ant-bad");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "auth" });
  });
});

describe("DeepSeekEngine", () => {
  it("ocrImage() throws unsupported (no vision)", async () => {
    const engine = new DeepSeekEngine("sk-test");
    await expect(engine.ocrImage("data:image/png;base64,AAAA")).rejects.toMatchObject({
      name: "EngineError",
      kind: "unsupported",
    });
  });

  it("complete() streams tokens and returns concatenated text", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    const tokens: string[] = [];
    const text = await engine.complete(
      { messages: [{ role: "user", content: "hi" }] },
      (t) => tokens.push(t),
    );

    expect(text).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("complete() uses the strong-tier model with thinking enabled", async () => {
    const fetchMock = mockFetch(async () =>
      streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`, "data: [DONE]\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    await engine.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("complete() uses the constructor model override", async () => {
    const fetchMock = mockFetch(async () =>
      streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`, "data: [DONE]\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test", "deepseek-v4-pro");
    await engine.complete({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe("deepseek-v4-pro");
  });

  it("complete() skips reasoning_content deltas in thinking mode", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    const tokens: string[] = [];
    const text = await engine.complete(
      { messages: [{ role: "user", content: "hi" }], tier: "strong" },
      (t) => tokens.push(t),
    );

    expect(text).toBe("Answer");
    expect(tokens).toEqual(["Answer"]);
  });

  it("complete() retries with thinking disabled when the model returns only reasoning", async () => {
    let calls = 0;
    const fetchMock = mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return streamResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
          `data: [DONE]\n\n`,
        ]);
      }
      return streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Final answer" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    const text = await engine.complete({
      messages: [{ role: "user", content: "hi" }],
      tier: "strong",
    });

    expect(text).toBe("Final answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const second = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(first.thinking).toEqual({ type: "enabled" });
    expect(second.thinking).toEqual({ type: "disabled" });
    expect(second.reasoning_effort).toBeUndefined();
  });

  it("complete() throws the no-content error when both attempts come back empty", async () => {
    const fetchMock = mockFetch(async () =>
      streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" }),
    ).rejects.toThrow(/carried no usable text/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("structured() sends a forced tool call on the beta endpoint", async () => {
    const payload = { title: "Photosynthesis", topic: "biology" };
    const fetchMock = mockFetch(async () =>
      jsonResponse({
        choices: [{ message: { tool_calls: [{ function: { name: "note", arguments: JSON.stringify(payload) } }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new DeepSeekEngine("sk-test");
    const result = await engine.structured<typeof payload>({
      messages: [{ role: "user", content: "extract" }],
      schema: { type: "object", properties: { title: { type: "string" }, topic: { type: "string" } } },
      schemaName: "note",
    });

    expect(result).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/beta/chat/completions");
    const body = JSON.parse(init?.body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "note" } });
    expect(body.tools[0].function.strict).toBe(true);
  });

  it("embed() throws kind unsupported", async () => {
    const engine = new DeepSeekEngine("sk-test");
    await expect(engine.embed(["hello"])).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("capabilities() reports no embeddings", () => {
    const engine = new DeepSeekEngine("sk-test");
    expect(engine.capabilities()).toEqual({
      chat: true,
      embeddings: false,
      vision: false,
    });
  });

  it("validate() maps a 401 to an auth EngineError", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { message: "bad key" } }, 401)));
    const engine = new DeepSeekEngine("sk-bad");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "auth" });
  });

  it("validate() maps a 402 to a quota EngineError", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { message: "insufficient balance" } }, 402)));
    const engine = new DeepSeekEngine("sk-test");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "quota" });
  });

  it("wraps a network failure as a network EngineError", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => { throw new TypeError("Failed to fetch"); }));
    const engine = new DeepSeekEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "EngineError", kind: "network" });
  });
});

describe("createEngine", () => {
  it("returns the right class per mode/provider", () => {
    expect(createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-x" })).toBeInstanceOf(
      OpenAIEngine,
    );
    expect(
      createEngine({ mode: "cloud", provider: "anthropic", apiKey: "sk-ant-x" }),
    ).toBeInstanceOf(AnthropicEngine);
    expect(
      createEngine({ mode: "cloud", provider: "deepseek", apiKey: "sk-x" }),
    ).toBeInstanceOf(DeepSeekEngine);
  });

  it("throws when cloud mode is missing an API key or provider", () => {
    expect(() => createEngine({ mode: "cloud" })).toThrow(EngineError);
    expect(() => createEngine({ mode: "cloud", apiKey: "sk-x" })).toThrow(EngineError);
  });
});
