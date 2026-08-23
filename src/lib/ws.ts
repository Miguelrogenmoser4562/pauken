/* WebSocket client for co-study sessions (Modes B/C).
 * Connects to the Pauken WS server (or a LAN-direct server).
 * Auto-reconnects forever with exponential backoff and keeps the connection
 * alive with an app-level ping every 25s (the server replies pong). If no
 * traffic arrives for 120s the socket is closed to force a reconnect cycle,
 * so idle-but-dead connections recover instead of hanging. */

import type { CoStudySession, ReviewLog, ScreenMode, UserProgress, WsMessage } from "./types";

type Listener = (msg: WsMessage) => void;

const PING_INTERVAL = 25_000;
const STALE_TIMEOUT = 120_000;

export class StudyWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private buffer: WsMessage[] = [];
  private onHandlerError: ((err: unknown) => void) | null = null;
  private onReconnect: (() => void) | null = null;
  private onConnectionStateChange: ((connected: boolean) => void) | null = null;
  private everConnected = false;
  private disposed = false;
  private lastActivity = 0;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disposed = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.lastActivity = Date.now();
        this.startHeartbeat();
        if (this.everConnected) this.onReconnect?.();
        this.everConnected = true;
        this.onConnectionStateChange?.(true);
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.lastActivity = Date.now();
        let msg: WsMessage;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error("StudyWsClient: invalid message", err);
          return;
        }
        if (this.listeners.size === 0) {
          /* No listeners registered (handler effect is re-registering) —
             buffer the message so it is not lost. */
          this.buffer.push(msg);
          return;
        }
        this.dispatch(msg);
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.onConnectionStateChange?.(false);
        if (this.disposed) return;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };
    });
  }

  /* Reconnect forever (exponential backoff capped at 15s). The caller's
     reconnect handler re-attaches to the session on the server side. */
  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.buffer = [];
      this.connect().catch(() => {});
    }, delay);
  }

  /* App-level ping every 25s keeps the connection alive across idle time.
     If nothing at all arrives for STALE_TIMEOUT, the socket is dead — close
     it so onclose drives the reconnect cycle. */
  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastActivity > STALE_TIMEOUT) {
        this.ws.close();
        return;
      }
      this.send({ type: "ping" });
    }, PING_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* Dispatch a parsed message to all listeners; handler errors are logged and
     surfaced via the registered error handler instead of being swallowed. */
  private dispatch(msg: WsMessage) {
    try {
      this.listeners.forEach((fn) => fn(msg));
    } catch (err) {
      console.error("StudyWsClient: message handler error", err);
      this.onHandlerError?.(err);
    }
  }

  /* Register an error handler for listener exceptions (e.g. so the UI can
     surface them instead of hanging on a spinner). */
  setHandlerErrorHandler(fn: ((err: unknown) => void) | null) {
    this.onHandlerError = fn;
  }

  /* Register a callback fired after every successful (re)connect after the
     first — the caller can re-attach to the session on the server side. */
  setReconnectHandler(fn: (() => void) | null) {
    this.onReconnect = fn;
  }

  /* Register a callback fired on every open/close so the UI can show a
     "reconnecting…" indicator while the socket is down. */
  setConnectionStateHandler(fn: ((connected: boolean) => void) | null) {
    this.onConnectionStateChange = fn;
  }

  send(msg: WsMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(fn: Listener) {
    this.listeners.add(fn);
    /* Replay messages that arrived while no listener was registered. */
    if (this.buffer.length > 0) {
      const pending = this.buffer;
      this.buffer = [];
      for (const msg of pending) this.dispatch(msg);
    }
    return () => { this.listeners.delete(fn); };
  }

  createSession(
    classId: string,
    questionIds: string[],
    userId?: string,
    userName?: string,
    progress: UserProgress[] = [],
    reviewLogs: ReviewLog[] = [],
    filter?: { folderIds: string[]; topic?: string },
  ): Promise<{ id: string; code: string }> {
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === "session_created") {
          this.sessionId = msg.session.id;
          unsub();
          resolve({ id: msg.session.id, code: msg.session.code });
        } else if (msg.type === "error") {
          unsub();
          reject(new Error(msg.message));
        }
      });
      this.send({ type: "create_session", classId, questionIds, userId, userName, progress, reviewLogs, filter });
      setTimeout(() => {
        unsub();
        reject(new Error("create_session timeout"));
      }, 15000);
    });
  }

  joinSession(
    code: string,
    userId: string,
    userName: string,
    progress: UserProgress[] = [],
    reviewLogs: ReviewLog[] = [],
  ): Promise<{ id: string; code: string }> {
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === "session_joined") {
          this.sessionId = msg.session.id;
          unsub();
          resolve({ id: msg.session.id, code: msg.session.code });
        } else if (msg.type === "error") {
          unsub();
          reject(new Error(msg.message));
        }
      });
      this.send({ type: "join_session", code, userId, userName, progress, reviewLogs });
      setTimeout(() => {
        unsub();
        reject(new Error("join_session timeout"));
      }, 15000);
    });
  }

  /* Re-attach to an existing session (page navigation or app restart).
     Resolves with the full session snapshot so the caller can restore state
     even if their regular message handler was not yet subscribed. */
  rejoinSession(
    sessionId: string,
    userId: string,
    userName: string,
    progress: UserProgress[] = [],
    reviewLogs: ReviewLog[] = [],
  ): Promise<CoStudySession> {
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === "session_state") {
          this.sessionId = msg.session.id;
          unsub();
          resolve(msg.session);
        } else if (msg.type === "error") {
          unsub();
          reject(new Error(msg.message));
        }
      });
      this.send({ type: "rejoin_session", sessionId, userId, userName, progress, reviewLogs });
      setTimeout(() => {
        unsub();
        reject(new Error("rejoin_session timeout"));
      }, 15000);
    });
  }

  /* Live pick — avatar sync without locking. */
  sendPick(answer: number) {
    if (!this.sessionId) return;
    this.send({ type: "answer_picked", sessionId: this.sessionId, answer });
  }

  /* Double-click / lock button — final answer for the current question. */
  lockAnswer(answer: number, index: number) {
    if (!this.sessionId) return;
    this.send({ type: "lock_answer", sessionId: this.sessionId, answer, index });
  }

  /* Skip/Back — move the shared session position. */
  navigateSession(index: number) {
    if (!this.sessionId) return;
    this.send({ type: "navigate_session", sessionId: this.sessionId, index });
  }

  /* How this user's screen tracks the partner's position. */
  setScreenMode(mode: ScreenMode) {
    if (!this.sessionId) return;
    this.send({ type: "set_screen_mode", sessionId: this.sessionId, mode });
  }

  rateQuestion() {
    if (!this.sessionId) return;
    this.send({ type: "rate_question", sessionId: this.sessionId });
  }

  setSessionQueue(questionIds: string[], filter?: { folderIds: string[]; topic?: string }) {
    if (!this.sessionId) return;
    this.send({ type: "set_session_queue", sessionId: this.sessionId, questionIds, filter });
  }

  updateProgress(progress: UserProgress[], reviewLogs: ReviewLog[] = []) {
    if (!this.sessionId) return;
    this.send({ type: "update_progress", sessionId: this.sessionId, progress, reviewLogs });
  }

  /* Ask the creator to rebuild the queue with a different unit/topic filter.
     Carries the requester's fresh progress so the rebuild uses it. */
  requestRebuild(folderIds: string[], topic: string | undefined, progress: UserProgress[] = [], reviewLogs: ReviewLog[] = []) {
    if (!this.sessionId) return;
    this.send({ type: "request_rebuild", sessionId: this.sessionId, folderIds, topic, progress, reviewLogs });
  }

  leaveSession() {
    if (this.sessionId) {
      this.send({ type: "leave_session", sessionId: this.sessionId });
    }
    this.sessionId = null;
  }

  disconnect() {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.buffer = [];
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
