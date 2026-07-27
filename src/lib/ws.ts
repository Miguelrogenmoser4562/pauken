/* WebSocket client for co-study sessions (Modes B/C).
 * Connects to the Pauken WS server (or a LAN-direct server).
 * Auto-reconnects with exponential backoff. */

import type { WsMessage } from "./types";

type Listener = (msg: WsMessage) => void;

export class StudyWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private sessionId: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data);
          this.listeners.forEach((fn) => fn(msg));
        } catch {
          /* ignore malformed messages */
        }
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  send(msg: WsMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  createSession(classId: string, questionIds: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === "session_created") {
          this.sessionId = msg.session.id;
          unsub();
          resolve(msg.session.id);
        } else if (msg.type === "error") {
          unsub();
          reject(new Error(msg.message));
        }
      });
      this.send({ type: "create_session", classId, questionIds });
      setTimeout(() => {
        unsub();
        reject(new Error("create_session timeout"));
      }, 15000);
    });
  }

  joinSession(sessionId: string, userId: string, userName: string): Promise<void> {
    this.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === "session_joined") {
          unsub();
          resolve();
        } else if (msg.type === "error") {
          unsub();
          reject(new Error(msg.message));
        }
      });
      this.send({ type: "join_session", sessionId, userId, userName });
      setTimeout(() => {
        unsub();
        reject(new Error("join_session timeout"));
      }, 15000);
    });
  }

  lockAnswer(answer: number) {
    if (!this.sessionId) return;
    this.send({ type: "lock_answer", sessionId: this.sessionId, answer });
  }

  leaveSession() {
    if (this.sessionId) {
      this.send({ type: "leave_session", sessionId: this.sessionId });
    }
    this.sessionId = null;
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}
