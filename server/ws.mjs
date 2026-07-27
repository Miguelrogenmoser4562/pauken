/* WebSocket server for co-study sessions (Modes B/C).
 * Manages in-memory sessions with lock-in-to-advance semantics.
 * Compatible with both the main API server and embedded LAN mode. */

import { WebSocketServer } from "ws";
import crypto from "node:crypto";

/* In-memory session store. */
const sessions = new Map();       // sessionId -> session object
const wsMeta = new Map();         // ws -> { sessionId, userId }
const sessionClients = new Map(); // sessionId -> Set<ws>

/* ---- Public API --------------------------------------------------------- */

export function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "invalid JSON" });
        return;
      }

      try {
        switch (msg.type) {
          case "create_session":
            handleCreate(ws, msg);
            break;
          case "join_session":
            handleJoin(ws, msg);
            break;
          case "lock_answer":
            handleLockAnswer(ws, msg);
            break;
          case "leave_session":
            handleLeave(ws);
            break;
          default:
            send(ws, { type: "error", message: `unknown: ${msg.type}` });
        }
      } catch (err) {
        send(ws, { type: "error", message: err.message });
      }
    });

    ws.on("close", () => handleLeave(ws));
  });

  return wss;
}

/* Create a standalone WS server (for LAN-direct mode). */
export async function createWsStandalone(port = 0) {
  const http = await import("node:http");
  const server = http.createServer();
  const wss = createWsServer(server);
  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      const addr = server.address();
      resolve({ server, wss, port: addr.port, url: `ws://0.0.0.0:${addr.port}` });
    });
    server.once("error", reject);
  });
}

export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

export function listSessions() {
  return [...sessions.values()];
}

/* ---- Helpers ------------------------------------------------------------ */

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToSession(sessionId, msg, excludeWs = null) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const raw = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      ws.send(raw);
    }
  }
}

/* ---- Handlers ----------------------------------------------------------- */

function handleCreate(ws, msg) {
  const { classId, questionIds } = msg;
  if (!classId || !questionIds?.length) {
    return send(ws, { type: "error", message: "classId and questionIds required" });
  }

  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    classId,
    questionIds,
    currentIndex: 0,
    participants: [],
    status: "waiting",
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);
  sessionClients.set(sessionId, new Set([ws]));
  wsMeta.set(ws, { sessionId });

  send(ws, { type: "session_created", session });
}

function handleJoin(ws, msg) {
  const { sessionId, userId, userName } = msg;
  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const uid = userId || crypto.randomUUID();
  const participant = {
    userId: uid,
    userName: userName || "Anonymous",
    lockedIn: false,
  };

  session.participants.push(participant);
  wsMeta.set(ws, { sessionId, userId: uid });

  const clients = sessionClients.get(sessionId);
  if (clients) clients.add(ws);

  session.status = "active";

  send(ws, { type: "session_joined", session, userId: uid });
  broadcastToSession(sessionId, { type: "participant_joined", participant }, ws);
}

function handleLockAnswer(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const participant = session.participants.find((p) => p.userId === meta.userId);
  if (!participant) return send(ws, { type: "error", message: "not a participant" });

  participant.lockedIn = true;
  participant.lastAnswer = msg.answer;
  participant.lastAnswerAt = Date.now();

  broadcastToSession(meta.sessionId, { type: "answer_locked", userId: meta.userId });

  const allLocked = session.participants.length >= 2 &&
    session.participants.every((p) => p.lockedIn);
  if (allLocked) {
    const answers = session.participants.map((p) => ({
      userId: p.userId,
      answer: p.lastAnswer,
    }));
    const nextIndex = session.currentIndex + 1;
    if (nextIndex < session.questionIds.length) {
      session.currentIndex = nextIndex;
      session.participants.forEach((p) => { p.lockedIn = false; });
      broadcastToSession(meta.sessionId, { type: "both_answered", answers, nextIndex });
      broadcastToSession(meta.sessionId, { type: "next_question", index: nextIndex });
    } else {
      session.status = "complete";
      broadcastToSession(meta.sessionId, { type: "both_answered", answers, nextIndex });
      broadcastToSession(meta.sessionId, { type: "session_ended", sessionId: session.id });
    }
  }
}

function handleLeave(ws) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return;

  const session = sessions.get(meta.sessionId);
  if (session) {
    session.participants = session.participants.filter(
      (p) => p.userId !== meta.userId,
    );
    if (session.participants.length === 0) {
      sessions.delete(meta.sessionId);
      sessionClients.delete(meta.sessionId);
    }
  }

  const clients = sessionClients.get(meta.sessionId);
  if (clients) clients.delete(ws);

  wsMeta.delete(ws);
}
