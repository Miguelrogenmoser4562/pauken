import type { Store } from "./index";
import type { ID } from "../types";

export class CachingStore implements Store {
  constructor(
    public local: Store,
    public remote: Store | null,
  ) {}

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    if (this.remote) {
      const server = await this.remote.get<T>(collection, id).catch(() => undefined);
      if (server) {
        await (this.local.put as any)(collection, server).catch(() => {});
        return server;
      }
    }
    return this.local.get<T>(collection, id);
  }

  async put<T extends { id: ID }>(collection: string, value: T): Promise<T> {
    await this.local.put(collection, value);
    if (this.remote) {
      try {
        await (this.remote.put as any)(collection, value);
      } catch (err) {
        console.error(`Failed to sync ${collection}/${value.id} to server:`, err);
      }
    }
    return value;
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.local.delete(collection, id);
    if (this.remote) {
      this.remote.delete(collection, id).catch(() => {});
    }
  }

  async all<T>(collection: string): Promise<T[]> {
    if (this.remote) {
      const local = await this.local.all<T>(collection).catch<T[]>(() => []);
      this.remote.all<T>(collection)
        .then((server) => {
          for (const item of server) {
            (this.local.put as any)(collection, item).catch(() => {});
          }
        })
        .catch(() => {});
      return local;
    }
    return this.local.all<T>(collection);
  }

  async where<T>(collection: string, match: Partial<T>): Promise<T[]> {
    if (this.remote) {
      const local = await this.local.where<T>(collection, match).catch<T[]>(() => []);
      this.remote.where<T>(collection, match)
        .then((server) => {
          for (const item of server) {
            (this.local.put as any)(collection, item).catch(() => {});
          }
        })
        .catch(() => {});
      return local;
    }
    return this.local.where<T>(collection, match);
  }

  async clear(collection: string): Promise<void> {
    await this.local.clear(collection);
    if (this.remote) {
      this.remote.clear(collection).catch(() => {});
    }
  }

  async clearAllLocal(): Promise<void> {
    const collections = [
      "notes", "folders", "classes", "flashcards",
      "quiz", "attempts", "review_logs", "chunks",
      "users", "class_members", "user_progress",
      "activity_events", "chat", "jobs", "reminders",
    ];
    for (const col of collections) {
      await this.local.clear(col).catch(() => {});
    }
  }

  async pullAll(): Promise<void> {
    if (!this.remote) return;
    const collections = [
      "notes", "folders", "classes", "flashcards",
      "quiz", "attempts", "review_logs", "chunks",
      "users", "class_members", "user_progress",
      "activity_events", "chat", "jobs", "reminders",
    ];
    for (const col of collections) {
      try {
        const items: { id: ID }[] = await this.remote.all(col);
        for (const item of items) {
          await (this.local.put as any)(col, item).catch(() => {});
        }
      } catch {}
    }
  }
}
