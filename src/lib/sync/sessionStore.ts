/* Shared co-study session store.
 *
 * The synced-session WebSocket + session identity live OUTSIDE the Practice
 * component so that navigating to the Dashboard/Settings (or anywhere else)
 * keeps the session alive. On app restart the identity is restored from
 * localStorage and the client automatically rejoins the server-side session
 * (which survives while at least one participant is connected). */

import { StudyWsClient } from "../ws";

export interface SyncIdentity {
  sessionId: string;
  code: string;
  userId: string;
  userName: string;
  classId: string;
}

const KEY = "pauken.syncsession";

class SyncSessionStore {
  private client: StudyWsClient | null = null;
  private identity: SyncIdentity | null = null;
  private listeners = new Set<() => void>();
  private connectPromise: Promise<StudyWsClient> | null = null;

  constructor() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.identity = JSON.parse(raw) as SyncIdentity;
    } catch {
      /* corrupt or unavailable storage — start fresh */
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    fn();
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  getClient(): StudyWsClient | null {
    return this.client;
  }

  getIdentity(): SyncIdentity | null {
    return this.identity;
  }

  saveIdentity(identity: SyncIdentity) {
    this.identity = identity;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(KEY, JSON.stringify(identity));
      } catch {
        /* storage full/blocked — session still works for this tab */
      }
    }
    this.emit();
  }

  clearIdentity() {
    this.identity = null;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  /* Connect to the WS server (reusing an existing connection) and, if a
     session identity was persisted, schedule a rejoin on reconnect. */
  async connect(wsUrl: string): Promise<StudyWsClient> {
    if (this.client?.connected) return this.client;
    /* Reuse an in-flight connect so concurrent callers share one socket. */
    if (this.connectPromise) return this.connectPromise;
    if (this.client) this.client.disconnect();
    const client = new StudyWsClient(wsUrl);
    client.setReconnectHandler(() => {
      /* The server forgot our socket on disconnect — re-attach to the session. */
      const ident = this.identity;
      if (ident && client.currentSessionId !== ident.sessionId) {
        client.rejoinSession(ident.sessionId, ident.userId, ident.userName);
      }
    });
    this.connectPromise = client
      .connect()
      .then(() => {
        this.client = client;
        this.emit();
        this.connectPromise = null;
        return client;
      })
      .catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    return this.connectPromise;
  }

  /* Fully leave the session (user intent): disconnect and forget identity. */
  leave() {
    this.connectPromise = null;
    if (this.client) {
      this.client.leaveSession();
      this.client.disconnect();
      this.client = null;
    }
    this.clearIdentity();
    this.emit();
  }

  /* Test-only: wipe module state between vitest cases. */
  resetForTests() {
    this.connectPromise = null;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.clearIdentity();
  }
}

export const syncSessionStore = new SyncSessionStore();
