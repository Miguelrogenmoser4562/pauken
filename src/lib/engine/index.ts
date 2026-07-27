/* Engine factory. This is the single entry point generation/UI code should
   use to get an Engine — never `new` a provider class directly, so switching
   providers/modes stays a one-line change at the call site. */

import type { EngineMode, Provider } from "../types";
import type { Engine } from "./types";
import { EngineError } from "./types";
import { OpenAIEngine } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { DeepSeekEngine } from "./deepseek";
import { ProxyEngine } from "./proxy";

export * from "./types";
export { detectProvider } from "./keys";

export interface CreateEngineOptions {
  mode: EngineMode;
  provider?: Provider;
  apiKey?: string;
  model?: string;
  /* When set, routes through the Pauken server's AI proxy */
  serverUrl?: string;
  userKey?: string;
}

export function createEngine(opts: CreateEngineOptions): Engine {
  /* Server proxy mode: AI calls go through the Pauken server */
  if (opts.serverUrl && opts.userKey) {
    return new ProxyEngine(opts.serverUrl, opts.userKey);
  }

  if (!opts.apiKey) {
    throw new EngineError("An API key is required.", "auth");
  }

  switch (opts.provider) {
    case "anthropic":
      return new AnthropicEngine(opts.apiKey, opts.model);
    case "deepseek":
      return new DeepSeekEngine(opts.apiKey, opts.model);
    case "openai":
      return new OpenAIEngine(opts.apiKey, opts.model);
    default:
      throw new EngineError("A provider (openai, anthropic, or deepseek) is required.", "unknown");
  }
}

/* Cheap liveness/credentials check without the caller needing to hold onto
   the Engine instance. Throws EngineError on failure. */
export async function validateCredentials(opts: CreateEngineOptions): Promise<void> {
  await createEngine(opts).validate();
}
