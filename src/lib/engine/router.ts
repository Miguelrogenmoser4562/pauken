/* Capability routing. Generation code calls supportsTask() before invoking
   an engine method that not every engine implements (e.g. Anthropic has no
   embeddings), and falls back to unsupportedMessage() for a clean, user-facing
   explanation instead of letting the raw EngineError surface. */

import type { Engine } from "./types";

export type Task = "chat" | "embeddings";

export function supportsTask(engine: Engine, task: Task): boolean {
  const caps = engine.capabilities();
  switch (task) {
    case "chat":
      return caps.chat;
    case "embeddings":
      return caps.embeddings;
  }
}

export function unsupportedMessage(task: Task): string {
  switch (task) {
    case "chat":
      return "This engine doesn't support chat. Switch to a cloud key or a chat-capable local model.";
    case "embeddings":
      return "This engine doesn't support embeddings. Add an OpenAI key or use a local embedding model.";
  }
}
