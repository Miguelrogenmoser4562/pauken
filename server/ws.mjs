/* WebSocket server for co-study sessions (Modes B/C).
 * Manages in-memory sessions with reveal-then-advance semantics:
 *  - up to two players (creator + joiner); a lone player can still advance
 *  - picks broadcast live (avatar sync), only a double-click/button LOCKS in
 *  - the answer is revealed once all connected participants have locked
 *  - the creator rebuilds the combined question queue when the partner joins
 *  - one "Continue" click from either player advances the session
 *  - players can rejoin an existing session after disconnecting/restarting
 *  - heartbeats keep sockets alive and sweep dead ones
 *  - answers are stored per question (not per index), so going back restores
 *    previously answered questions instead of clearing them
 *  - sockets that drop mark the participant "disconnected" instead of
 *    destroying the session; sessions with no connected participant are
 *    garbage-collected after an hour
 * Compatible with both the main API server and embedded LAN mode. */

import { WebSocketServer } from "ws";
import crypto from "node:crypto";

/* In-memory session store. */
const sessions = new Map();       // sessionId -> session object
const codeIndex = new Map();      // join code -> sessionId
const wsMeta = new Map();         // ws -> { sessionId, userId }
const sessionClients = new Map(); // sessionId -> Set<ws>

const HEARTBEAT_INTERVAL = 30_000;
const IDLE_TIMEOUT = 90_000;      // terminate sockets with no traffic for this long
const ORPHAN_TTL = 60 * 60 * 1000; // sessions with no connected participant last this long

/* ---- Public API --------------------------------------------------------- */

export function createWsServer(httpServer, opts = {}) {
  const isMember = opts.isMember ?? (async () => true);

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.lastActivity = Date.now();
    });

    ws.on("message", (raw) => {
      ws.lastActivity = Date.now();

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "invalid JSON" });
        return;
      }

      try {
        switch (msg.type) {
          case "ping":
            send(ws, { type: "pong" });
            break;
          case "create_session":
            handleCreate(ws, msg);
            break;
          case "join_session":
            handleJoin(ws, msg, isMember).catch((err) =>
              send(ws, { type: "error", message: err.message }),
            );
            break;
          case "rejoin_session":
            handleRejoin(ws, msg);
            break;
          case "answer_picked":
            handlePickAnswer(ws, msg);
            break;
          case "lock_answer":
            handleLockAnswer(ws, msg);
            break;
          case "navigate_session":
            handleNavigate(ws, msg);
            break;
          case "set_screen_mode":
            handleSetScreenMode(ws, msg);
            break;
          case "set_session_queue":
            handleSetQueue(ws, msg);
            break;
          case "update_progress":
            handleUpdateProgress(ws, msg);
            break;
          case "rate_question":
            handleRate(ws, msg);
            break;
          case "request_rebuild":
            handleRequestRebuild(ws, msg);
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

    /* A dropped socket only marks the participant offline; the session and
     * their slot survive so they can rejoin within the orphan TTL. Explicit
     * leave_session (handleLeave) is what actually removes them. */
    ws.on("close", () => handleDisconnect(ws));
  });

  /* Heartbeat sweep: terminate sockets that missed their pong or sat idle. */
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (Date.now() - ws.lastActivity > IDLE_TIMEOUT) {
        ws.terminate();
        continue;
      }
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL);
  sweep.unref();

  /* GC: sessions whose participants are all disconnected expire after TTL. */
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const anyConnected = session.participants.some((p) => p.connected !== false);
      if (!anyConnected && (session.orphanedAt ?? 0) && now - session.orphanedAt > ORPHAN_TTL) {
        codeIndex.delete(session.code);
        sessions.delete(id);
        sessionClients.delete(id);
      }
    }
  }, 60_000);
  gc.unref();

  wss.on("close", () => {
    clearInterval(sweep);
    clearInterval(gc);
  });

  return wss;
}

/* Create a standalone WS server (for LAN-direct mode). */
export async function createWsStandalone(port = 0, opts = {}) {
  const http = await import("node:http");
  const server = http.createServer();
  const wss = createWsServer(server, opts);
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

/* Generate a unique 4-digit join code (1000-9999). */
function generateJoinCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (codeIndex.has(code));
  return code;
}

function questionIdAt(session, index) {
  return session.questionIds[index];
}

function answersFor(session, qid) {
  if (!session.answersByQuestion) session.answersByQuestion = {};
  if (!session.answersByQuestion[qid]) session.answersByQuestion[qid] = {};
  return session.answersByQuestion[qid];
}

function revealedFor(session, qid) {
  return !!(session.revealedByQuestion && session.revealedByQuestion[qid]);
}

/* Mirror the stored per-question state for `index` onto the current-view
 * fields (session.revealed, participant.answer/lockedIn/lastAnswerAt) so the
 * wire protocol stays backward-compatible: navigating back to an answered
 * question restores the stored answers instead of clearing them. */
function applyStoredView(session, index) {
  const answers = answersFor(session, questionIdAt(session, index));
  for (const p of session.participants) {
    const stored = answers[p.userId];
    if (stored) {
      p.answer = stored.answer;
      p.lockedIn = stored.lockedIn;
      if (stored.lastAnswerAt) p.lastAnswerAt = stored.lastAnswerAt;
      else delete p.lastAnswerAt;
    } else {
      p.lockedIn = false;
      delete p.answer;
      delete p.lastAnswerAt;
    }
  }
  session.revealed = revealedFor(session, questionIdAt(session, index));
  session.advanceRequested = false;
}

/* Reveal the current question once every CONNECTED participant has locked in
 * (disconnected participants no longer block the reveal; when they rejoin,
 * session_state carries the stored answer). */
function maybeReveal(session, excludeWs = null) {
  if (session.revealed) return;
  const qid = questionIdAt(session, session.currentIndex);
  const answers = answersFor(session, qid);
  const active = session.participants.filter((p) => p.connected !== false);
  const allLocked = active.length >= 1 && active.every((p) => answers[p.userId]?.lockedIn);
  if (!allLocked) return;

  session.revealedByQuestion[qid] = true;
  session.revealed = true;
  const list = session.participants
    .map((p) => ({ userId: p.userId, answer: answers[p.userId]?.answer }))
    .filter((a) => a.answer !== undefined);
  broadcastToSession(session.id, { type: "both_answered", answers: list }, excludeWs);
}

/* ---- Handlers ----------------------------------------------------------- */

function handleCreate(ws, msg) {
  const { classId, questionIds, userId, userName, progress, reviewLogs, filter } = msg;
  if (!classId || !questionIds?.length) {
    return send(ws, { type: "error", message: "classId and questionIds required" });
  }

  const sessionId = crypto.randomUUID();
  const code = generateJoinCode();
  const uid = userId || crypto.randomUUID();
  const session = {
    id: sessionId,
    code,
    classId,
    createdBy: uid,
    questionIds,
    filter: filter ?? null,
    currentIndex: 0,
    participants: [{
      userId: uid,
      userName: userName || "Anonymous",
      lockedIn: false,
      screenMode: "follow",
      connected: true,
    }],
    status: "waiting",
    createdAt: Date.now(),
    progressByUser: { [uid]: progress ?? [] },
    reviewLogsByUser: { [uid]: reviewLogs ?? [] },
    answersByQuestion: {},
    revealedByQuestion: {},
    revealed: false,
    advanceRequested: false,
    orphanedAt: null,
  };
  sessions.set(sessionId, session);
  codeIndex.set(code, sessionId);
  sessionClients.set(sessionId, new Set([ws]));
  wsMeta.set(ws, { sessionId, userId: uid });

  send(ws, { type: "session_created", session });
}

async function handleJoin(ws, msg, isMember) {
  const { code, userId, userName, progress, reviewLogs } = msg;
  if (!/^\d{4}$/.test(code ?? "")) {
    return send(ws, { type: "error", message: "invalid join code" });
  }
  const session = sessions.get(codeIndex.get(code));
  if (!session) return send(ws, { type: "error", message: "session not found" });
  if (session.status === "complete") return send(ws, { type: "error", message: "session already complete" });
  if (session.participants.length >= 2) return send(ws, { type: "error", message: "session is full" });

  const uid = userId || crypto.randomUUID();
  if (session.participants.some((p) => p.userId === uid)) {
    return send(ws, { type: "error", message: "already in this session" });
  }

  /* The joining user must actually be enrolled in the session's class. */
  if ((await isMember(uid, session.classId)) === false) {
    return send(ws, { type: "error", message: "you are not a member of this class" });
  }

  const participant = {
    userId: uid,
    userName: userName || "Anonymous",
    lockedIn: false,
    screenMode: "follow",
    connected: true,
  };
  session.participants.push(participant);
  session.progressByUser[uid] = progress ?? [];
  session.reviewLogsByUser[uid] = reviewLogs ?? [];
  session.orphanedAt = null;
  wsMeta.set(ws, { sessionId: session.id, userId: uid });

  const clients = sessionClients.get(session.id);
  if (clients) clients.add(ws);

  session.status = "active";

  send(ws, { type: "session_joined", session, userId: uid });
  broadcastToSession(session.id, {
    type: "participant_joined",
    participant,
    progress: progress ?? [],
    reviewLogs: reviewLogs ?? [],
  }, ws);
}

/* Re-attach a previously connected user (page navigation, app restart, or
 * reconnect). The session survives while at least one participant is
 * connected, so returning users resume exactly where they left off. */
function handleRejoin(ws, msg) {
  const { sessionId, userId, userName, progress, reviewLogs } = msg;
  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const uid = userId || crypto.randomUUID();
  let participant = session.participants.find((p) => p.userId === uid);
  if (!participant) {
    participant = {
      userId: uid,
      userName: userName || "Anonymous",
      lockedIn: false,
      screenMode: "follow",
    };
    if (uid === session.createdBy) session.participants.unshift(participant);
    else session.participants.push(participant);
  } else if (userName) {
    participant.userName = userName;
  }
  participant.connected = true;
  session.orphanedAt = null;

  session.progressByUser[uid] = progress ?? session.progressByUser[uid] ?? [];
  session.reviewLogsByUser[uid] = reviewLogs ?? session.reviewLogsByUser[uid] ?? [];

  wsMeta.set(ws, { sessionId: session.id, userId: uid });
  const clients = sessionClients.get(session.id);
  if (clients) clients.add(ws);

  applyStoredView(session, session.currentIndex);
  send(ws, { type: "session_state", session, reason: "rejoin" });
}

/* Live pick: updates the avatar + "partner thinking" status without locking. */
function handlePickAnswer(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const participant = session.participants.find((p) => p.userId === meta.userId);
  if (!participant) return send(ws, { type: "error", message: "not a participant" });

  if (session.revealed) return; /* answer phase is over */

  participant.answer = msg.answer;

  broadcastToSession(meta.sessionId, { type: "pick_changed", userId: meta.userId, answer: msg.answer });
}

/* Double-click / lock button: final answer. Reveals once every connected
 * participant has locked (a lone participant reveals on their own lock).
 * The answer is stored PER QUESTION, so it survives back/forward moves. */
function handleLockAnswer(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const participant = session.participants.find((p) => p.userId === meta.userId);
  if (!participant) return send(ws, { type: "error", message: "not a participant" });

  if (session.revealed) return; /* answer phase is over */
  if (msg.index !== session.currentIndex) {
    /* Lock arrived for a question that is no longer current (stale position). */
    return send(ws, { type: "error", message: "stale position" });
  }

  const qid = questionIdAt(session, msg.index);
  const stored = answersFor(session, qid);
  const entry = stored[meta.userId] ?? (stored[meta.userId] = { answer: undefined, lockedIn: false });
  entry.answer = msg.answer;
  entry.lockedIn = true;
  entry.lastAnswerAt = Date.now();

  /* Mirror onto the current view so existing clients behave identically. */
  participant.answer = msg.answer;
  participant.lockedIn = true;
  participant.lastAnswerAt = entry.lastAnswerAt;

  broadcastToSession(meta.sessionId, { type: "answer_locked", userId: meta.userId, answer: msg.answer });
  maybeReveal(session);
}

/* Skip/Back: move the shared position; followers' screens jump with it.
 * The target question's stored answers (if any) are restored, not cleared. */
function handleNavigate(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });
  if (session.status === "complete") return;

  const idx = Number(msg.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= session.questionIds.length) {
    return send(ws, { type: "error", message: "invalid index" });
  }

  session.currentIndex = idx;
  applyStoredView(session, idx);

  broadcastToSession(meta.sessionId, { type: "session_state", session, reason: "navigate" });
}

function handleSetScreenMode(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  const participant = session.participants.find((p) => p.userId === meta.userId);
  if (!participant) return send(ws, { type: "error", message: "not a participant" });

  const mode = msg.mode === "independent" || msg.mode === "not-follow" ? msg.mode : "follow";
  participant.screenMode = mode;

  broadcastToSession(meta.sessionId, {
    type: "screen_mode_changed",
    userId: meta.userId,
    mode,
  });
}

/* Creator sets the combined question queue — either once the partner joins,
 * or mid-session when either player re-filters the unit/topic. Answers for
 * questions that leave the queue are dropped; the rest are kept. */
function handleSetQueue(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  if (meta.userId !== session.createdBy) {
    return send(ws, { type: "error", message: "only the session creator can set the queue" });
  }
  if (session.status === "complete") {
    return send(ws, { type: "error", message: "session already complete" });
  }
  if (!msg.questionIds?.length) {
    return send(ws, { type: "error", message: "questionIds required" });
  }

  const removed = session.questionIds.filter((id) => !msg.questionIds.includes(id));
  session.questionIds = msg.questionIds;
  session.currentIndex = 0;
  session.advanceRequested = false;
  if (msg.filter) session.filter = msg.filter;

  for (const qid of removed) {
    delete session.answersByQuestion[qid];
    delete session.revealedByQuestion[qid];
  }

  applyStoredView(session, 0);

  broadcastToSession(meta.sessionId, {
    type: "session_started",
    sessionId: session.id,
    questionIds: session.questionIds,
    index: 0,
    filter: session.filter,
  });
}

/* Partner refreshes their progress after an auto class-switch (only relevant
 * before the session's first reveal). */
function handleUpdateProgress(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  if (session.revealed || session.advanceRequested) return; /* queue locked in */

  session.progressByUser[meta.userId] = msg.progress ?? [];
  session.reviewLogsByUser[meta.userId] = msg.reviewLogs ?? [];

  broadcastToSession(meta.sessionId, {
    type: "progress_updated",
    userId: meta.userId,
    progress: msg.progress ?? [],
    reviewLogs: msg.reviewLogs ?? [],
  }, ws);
}

/* A participant asks to rebuild the queue with a different unit/topic filter.
 * The server records the requester's fresh progress and relays the request to
 * the creator, who owns queue building (it needs BOTH users' progress). */
function handleRequestRebuild(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });
  if (session.status === "complete") return;

  session.filter = { folderIds: msg.folderIds ?? [], topic: msg.topic ?? undefined };
  session.progressByUser[meta.userId] = msg.progress ?? [];
  session.reviewLogsByUser[meta.userId] = msg.reviewLogs ?? [];

  broadcastToSession(meta.sessionId, {
    type: "rebuild_requested",
    folderIds: msg.folderIds ?? [],
    topic: msg.topic ?? undefined,
    requesterId: meta.userId,
    progress: msg.progress ?? [],
    reviewLogs: msg.reviewLogs ?? [],
  }, ws);
}

/* One "Continue" click from either player advances the session. The next
 * question's stored answers (if any) travel in the message payload. */
function handleRate(ws, msg) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return send(ws, { type: "error", message: "no active session" });

  const session = sessions.get(meta.sessionId);
  if (!session) return send(ws, { type: "error", message: "session not found" });

  if (!session.revealed) return; /* nothing to advance yet */
  if (session.advanceRequested) return; /* already advancing */

  session.advanceRequested = true;

  const nextIndex = session.currentIndex + 1;
  if (nextIndex < session.questionIds.length) {
    session.currentIndex = nextIndex;
    applyStoredView(session, nextIndex);
    const answers = session.participants.map((p) => ({
      userId: p.userId,
      answer: p.answer,
      lockedIn: p.lockedIn,
    }));
    broadcastToSession(meta.sessionId, {
      type: "next_question",
      index: nextIndex,
      answers,
      revealed: session.revealed,
    });
  } else {
    session.status = "complete";
    broadcastToSession(meta.sessionId, { type: "session_ended", sessionId: session.id });
  }
}

/* Explicit leave (the user clicked Leave): remove them immediately. */
function handleLeave(ws) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return;

  const session = sessions.get(meta.sessionId);
  if (session) {
    session.participants = session.participants.filter(
      (p) => p.userId !== meta.userId,
    );
    if (session.participants.length === 1) {
      broadcastToSession(meta.sessionId, { type: "participant_left", userId: meta.userId }, ws);
      /* The remaining player keeps going: reveal their already-locked answer
         so they are not stuck waiting for a partner who left. */
      maybeReveal(session, ws);
    }
    if (session.participants.length === 0) {
      codeIndex.delete(session.code);
      sessions.delete(meta.sessionId);
      sessionClients.delete(meta.sessionId);
    }
  }

  const clients = sessionClients.get(meta.sessionId);
  if (clients) clients.delete(ws);

  wsMeta.delete(ws);
}

/* Socket drop: keep the participant and session (grace period) so a brief
 * disconnect can be recovered by rejoining. Explicit leave still removes. */
function handleDisconnect(ws) {
  const meta = wsMeta.get(ws);
  if (!meta?.sessionId) return;

  const session = sessions.get(meta.sessionId);
  if (session) {
    const participant = session.participants.find((p) => p.userId === meta.userId);
    if (participant) {
      participant.connected = false;
      /* If the remaining connected players have all locked, reveal so they
         are not stuck waiting for the dropped socket. */
      maybeReveal(session);
    }
    const anyConnected = session.participants.some((p) => p.connected !== false);
    if (!anyConnected) session.orphanedAt = Date.now();
  }

  const clients = sessionClients.get(meta.sessionId);
  if (clients) clients.delete(ws);

  wsMeta.delete(ws);
}
