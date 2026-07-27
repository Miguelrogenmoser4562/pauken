/* Pauken API server.
 *
 * Two modes:
 *   Local mode (no config) — serves static SPA + health endpoint.
 *     The client uses IndexedDB directly (single-user, no auth).
 *   Multi-user mode (with dbConfig + usersPath) — full API over Postgres.
 *     Clients authenticate with static keys; the server is the source of truth.
 *
 * Exported as startServer() so both the Electron main process and
 * `node server/standalone.mjs` can run it.
 */

import express from "express";
import cors from "cors";
import http from "node:http";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, initSchema } from "./db.mjs";
import { loadUsers } from "./auth.mjs";
import { createWsServer } from "./ws.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---- helpers ----------------------------------------------------------- */

const VALID_COLLECTIONS = new Set([
  "notes", "folders", "classes", "flashcards",
  "quiz", "attempts", "review_logs", "chunks",
  "users", "class_members",
  "user_progress", "activity_events",
  "chat", "jobs", "reminders",
]);

/* ---- entity CRUD helpers (Postgres) ----------------------------------- */

async function listEntities(pool, collection, query) {
  const result = await pool.query(
    "SELECT data FROM entities WHERE collection = $1 ORDER BY data->>'createdAt' DESC",
    [collection],
  );
  let items = result.rows.map((r) => r.data);
  for (const [k, v] of Object.entries(query)) {
    items = items.filter((item) => String(item[k]) === v);
  }
  return items;
}

async function getEntity(pool, collection, id) {
  const result = await pool.query(
    "SELECT data FROM entities WHERE collection = $1 AND id = $2",
    [collection, id],
  );
  return result.rows[0]?.data ?? null;
}

async function upsertEntity(pool, collection, id, data) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO entities (id, collection, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = $5`,
    [id, collection, JSON.stringify(data), data.createdAt ?? now, now],
  );
  return data;
}

async function deleteEntity(pool, collection, id) {
  await pool.query(
    "DELETE FROM entities WHERE collection = $1 AND id = $2",
    [collection, id],
  );
}

/* ---- in-memory fallback (local mode) ---------------------------------- */

const memory = new Map();

function memList(collection, query) {
  let items = [...(memory.get(collection) || []).values()];
  for (const [k, v] of Object.entries(query)) {
    items = items.filter((item) => String(item[k]) === v);
  }
  return items;
}

function memGet(collection, id) {
  return memory.get(collection)?.get(id) ?? null;
}

function memPut(collection, id, data) {
  if (!memory.has(collection)) memory.set(collection, new Map());
  memory.get(collection).set(id, data);
  return data;
}

function memDelete(collection, id) {
  memory.get(collection)?.delete(id);
}

/* ---- Whisper proxy ---------------------------------------------------- */
/* Forwards multipart audio upload to self-hosted Whisper.
   Must be registered before the JSON body parser. */

function whisperProxy(req, res) {
  const whisperUrl = process.env.WHISPER_API_URL || "http://127.0.0.1:9000";
  const url = new URL("/v1/audio/transcriptions", whisperUrl);

  const opts = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || 9000,
    path: url.pathname,
    headers: { ...req.headers, host: url.host },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    res.status(502).json({ error: "whisper proxy failed" });
  });
  req.pipe(proxyReq);
}

/* ---- Express app factory ---------------------------------------------- */

function createApp({ pool, usersByKey, distDir, usersPath }) {
  const app = express();

  app.use(cors());

  /* Whisper proxy — before JSON body parser (multipart, not JSON) */
  app.post("/api/transcribe", whisperProxy);

  /* JSON body parser for all other API routes */
  app.use(express.json({ limit: "50mb" }));

  /* Public routes (no auth) */
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "pauken", db: !!pool });
  });

  app.post("/api/auth/verify", (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "key required" });
    const user = usersByKey?.get(key);
    if (!user) return res.status(401).json({ error: "invalid key" });
    res.json({ user: { id: user.id, name: user.name, isAdmin: !!user.isAdmin, ...(user.avatar ? { avatar: user.avatar } : {}) } });
  });

  /* Auth middleware for remaining API routes */
  if (usersByKey) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/health" || req.path === "/auth/verify" || req.path === "/transcribe") return next();
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return res.status(401).json({ error: "missing authorization" });
      }
      const user = usersByKey.get(auth.slice(7));
      if (!user) return res.status(401).json({ error: "invalid key" });
      req.user = user;
      next();
    });
  }

  /* AI proxy endpoint — forwards to DeepSeek with server-side API key */
  app.post("/api/ai/chat", async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "DEEPSEEK_API_KEY not configured on server" });
    }

    try {
      const isBeta = req.query.beta === "1";
      const url = isBeta
        ? "https://api.deepseek.com/beta/chat/completions"
        : "https://api.deepseek.com/v1/chat/completions";

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(req.body),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        console.error("DeepSeek API error:", response.status, JSON.stringify(errBody));
        return res.status(response.status).json(errBody);
      }

      if (req.body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        Readable.fromWeb(response.body).pipe(res);
      } else {
        const data = await response.json();
        res.json(data);
      }
    } catch (err) {
      res.status(502).json({ error: "AI proxy failed: " + (err.message || "unknown") });
    }
  });

  app.get("/api/ai/status", (_req, res) => {
    res.json({ configured: !!process.env.DEEPSEEK_API_KEY });
  });

  /* Users endpoint — returns all known users (without keys) */
  app.get("/api/users", (req, res) => {
    try {
      if (usersByKey) {
        const safe = [];
        for (const user of usersByKey.values()) {
          safe.push({ id: user.id, name: user.name, isAdmin: !!user.isAdmin, ...(user.avatar ? { avatar: user.avatar } : {}) });
        }
        res.json(safe);
      } else {
        const allUsers = memList("users", {});
        res.json(allUsers);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/users/:id", (req, res) => {
    try {
      if (usersByKey) {
        for (const user of usersByKey.values()) {
          if (user.id === req.params.id) {
            return res.json({ id: user.id, name: user.name, isAdmin: !!user.isAdmin, ...(user.avatar ? { avatar: user.avatar } : {}) });
          }
        }
        return res.status(404).json({ error: "not found" });
      }
      const user = memGet("users", req.params.id);
      if (!user) return res.status(404).json({ error: "not found" });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Classes endpoint — scope to user's active memberships when authenticated */
  const classesList = pool
    ? async (query, userId) => {
        let items = await listEntities(pool, "classes", query);
        if (userId) {
          const members = await pool.query(
            "SELECT data FROM entities WHERE collection = 'class_members' AND data->>'userId' = $1 AND (data->>'status' IS NULL OR data->>'status' = 'active')",
            [userId],
          );
          const memberClassIds = new Set(members.rows.map((r) => r.data?.classId));
          items = items.filter((c) => memberClassIds.has(c.id));
        }
        return items;
      }
    : (query, userId) => {
        let items = memList("classes", query);
        if (userId) {
          const members = memList("class_members", { userId }).filter(
            (m) => !m.status || m.status === "active",
          );
          const memberClassIds = new Set(members.map((m) => m.classId));
          items = items.filter((c) => memberClassIds.has(c.id));
        }
        return items;
      };

  app.get("/api/classes", async (req, res) => {
    try {
      const items = await classesList(req.query, req.user?.id);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  function userIsMember(userId, classId) {
    if (pool) {
      return pool.query(
        "SELECT 1 FROM entities WHERE collection = 'class_members' AND data->>'userId' = $1 AND data->>'classId' = $2 AND (data->>'status' IS NULL OR data->>'status' = 'active') LIMIT 1",
        [userId, classId],
      ).then((r) => r.rows.length > 0);
    }
    const members = memList("class_members", { userId, classId }).filter(
      (m) => !m.status || m.status === "active",
    );
    return Promise.resolve(members.length > 0);
  }

  function userHasAccess(userId, classId) {
    if (pool) {
      return pool.query(
        "SELECT 1 FROM entities WHERE collection = 'class_members' AND data->>'userId' = $1 AND data->>'classId' = $2 AND (data->>'status' IS NULL OR data->>'status' = 'active' OR data->>'status' = 'pending') LIMIT 1",
        [userId, classId],
      ).then((r) => r.rows.length > 0);
    }
    const members = memList("class_members", { userId, classId });
    return Promise.resolve(members.length > 0);
  }

  const getUserFolderIds = pool
    ? async (userId) => {
        const members = await pool.query(
          "SELECT data FROM entities WHERE collection = 'class_members' AND data->>'userId' = $1 AND (data->>'status' IS NULL OR data->>'status' = 'active')",
          [userId],
        );
        const classIds = members.rows.map((r) => r.data?.classId).filter(Boolean);
        if (classIds.length === 0) return new Set();
        const folders = await pool.query(
          "SELECT data FROM entities WHERE collection = 'folders' AND data->>'classId' = ANY($1)",
          [classIds],
        );
        return new Set(folders.rows.map((r) => r.data?.id).filter(Boolean));
      }
    : async (userId) => {
        const members = memList("class_members", { userId }).filter(
          (m) => !m.status || m.status === "active",
        );
        const classIds = members.map((m) => m.classId);
        if (classIds.length === 0) return new Set();
        const allFolders = memList("folders", {});
        return new Set(
          allFolders.filter((f) => classIds.includes(f.classId)).map((f) => f.id),
        );
      };

  app.get("/api/classes/:id", async (req, res) => {
    try {
      if (req.user) {
        const hasAccess = await userHasAccess(req.user.id, req.params.id);
        if (!hasAccess) return res.status(404).json({ error: "not found" });
      }
      const item = pool
        ? await getEntity(pool, "classes", req.params.id)
        : memGet("classes", req.params.id);
      if (!item) return res.status(404).json({ error: "not found" });
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Activity endpoint — recent class activity for async co-study */
  app.get("/api/activity/:classId", async (req, res) => {
    try {
      const { classId } = req.params;
      const userId = req.user?.id;
      const now = Date.now();
      const since = now - 86400000; // last 24h

      let attempts;
      if (pool) {
        /* Get all notes in this class via folders */
        const folders = await pool.query(
          "SELECT data FROM entities WHERE collection = 'folders' AND data->>'classId' = $1",
          [classId],
        );
        const noteIds = folders.rows
          .map((r) => r.data?.id)
          .filter(Boolean);
        if (noteIds.length === 0) return res.json([]);

        const result = await pool.query(
          "SELECT data FROM entities WHERE collection = 'attempts' AND data->>'noteId' = ANY($1) AND (data->>'at')::bigint > $2 ORDER BY (data->>'at')::bigint DESC LIMIT 20",
          [noteIds, since],
        );
        attempts = result.rows.map((r) => r.data);
      } else {
        /* In-memory mode */
        const allAttempts = memList("attempts", {});
        const folders = memList("folders", { classId });
        const noteIds = new Set(folders.map((f) => f.id));
        attempts = allAttempts
          .filter((a) => noteIds.has(a.noteId) && a.at > since && a.userId !== userId)
          .sort((a, b) => b.at - a.at)
          .slice(0, 20);
      }

      /* Resolve user names */
      const userMap = {};
      if (pool) {
        const userIds = [...new Set(attempts.map((a) => a.userId).filter(Boolean))];
        if (userIds.length > 0) {
          const users = await pool.query(
            "SELECT data FROM entities WHERE collection = 'users' AND id = ANY($1)",
            [userIds],
          );
          for (const row of users.rows) {
            if (row.data) userMap[row.data.id] = row.data.name;
          }
        }
      } else {
        const allUsers = memList("users", {});
        for (const u of allUsers) userMap[u.id] = u.name;
      }

      const events = attempts.map((a) => ({
        id: a.id,
        classId,
        userId: a.userId,
        userName: userMap[a.userId] || "Unknown",
        type: "attempt",
        details: `${a.correct ? "Correct" : "Incorrect"} answer on ${a.topic || "a question"}`,
        at: a.at,
      }));

      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Class member routes — only the class owner can add or remove members */
  app.put("/api/class_members/:id", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "authentication required" });
      const member = req.body;
      const classEntity = pool
        ? await getEntity(pool, "classes", member.classId)
        : memGet("classes", member.classId);
      if (!classEntity) return res.status(404).json({ error: "class not found" });
      if (classEntity.ownerId !== req.user.id && member.userId !== req.user.id) {
        return res.status(403).json({ error: "only the class owner can add members" });
      }
      if (member.role === "owner" && member.userId !== classEntity.ownerId) {
        return res.status(403).json({ error: "cannot assign owner role to another user" });
      }
      const item = await (pool
        ? upsertEntity(pool, "class_members", req.params.id, member)
        : memPut("class_members", req.params.id, member));
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/class_members/:id", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "authentication required" });
      const existing = pool
        ? await getEntity(pool, "class_members", req.params.id)
        : memGet("class_members", req.params.id);
      if (!existing) return res.status(404).json({ error: "not found" });
      const classEntity = pool
        ? await getEntity(pool, "classes", existing.classId)
        : memGet("classes", existing.classId);
      if (!classEntity) return res.status(404).json({ error: "class not found" });
      if (classEntity.ownerId !== req.user.id) {
        return res.status(403).json({ error: "only the class owner can remove members" });
      }
      await (pool
        ? deleteEntity(pool, "class_members", req.params.id)
        : memDelete("class_members", req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Specific class PUT handler — auto-creates owner membership */
  app.put("/api/classes/:id", async (req, res) => {
    try {
      const classEntity = req.body;
      const item = await (pool
        ? upsertEntity(pool, "classes", req.params.id, classEntity)
        : memPut("classes", req.params.id, classEntity));

      if (classEntity.ownerId) {
        const hasOwnerMember = pool
          ? (await pool.query(
              "SELECT 1 FROM entities WHERE collection = 'class_members' AND data->>'userId' = $1 AND data->>'classId' = $2 AND data->>'role' = 'owner' LIMIT 1",
              [classEntity.ownerId, classEntity.id],
            )).rows.length > 0
          : memList("class_members", { userId: classEntity.ownerId, classId: classEntity.id }).some(
              (m) => m.role === "owner",
            );

        if (!hasOwnerMember) {
          const member = {
            id: `${classEntity.id}-${classEntity.ownerId}-owner`,
            classId: classEntity.id,
            userId: classEntity.ownerId,
            role: "owner",
            status: "active",
            joinedAt: Date.now(),
          };
          if (pool) {
            await upsertEntity(pool, "class_members", member.id, member);
          } else {
            memPut("class_members", member.id, member);
          }
        }
      }

      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Notes routes — filtered by class membership when authenticated */
  app.get("/api/notes", async (req, res) => {
    try {
      let items = pool
        ? await listEntities(pool, "notes", req.query)
        : memList("notes", req.query);
      if (req.user) {
        const folderIds = await getUserFolderIds(req.user.id);
        if (folderIds.size === 0) {
          items = [];
        } else {
          items = items.filter((n) => n.folderId && folderIds.has(n.folderId));
        }
      }
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/notes/:id", async (req, res) => {
    try {
      const item = pool
        ? await getEntity(pool, "notes", req.params.id)
        : memGet("notes", req.params.id);
      if (!item) return res.status(404).json({ error: "not found" });
      if (req.user && item.folderId) {
        const folderIds = await getUserFolderIds(req.user.id);
        if (!folderIds.has(item.folderId)) {
          return res.status(404).json({ error: "not found" });
        }
      }
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Folder routes — filtered by class membership when authenticated */
  app.get("/api/folders", async (req, res) => {
    try {
      let items = pool
        ? await listEntities(pool, "folders", req.query)
        : memList("folders", req.query);
      if (req.user) {
        const folderIds = await getUserFolderIds(req.user.id);
        items = items.filter((f) => folderIds.has(f.id));
      }
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/folders/:id", async (req, res) => {
    try {
      const item = pool
        ? await getEntity(pool, "folders", req.params.id)
        : memGet("folders", req.params.id);
      if (!item) return res.status(404).json({ error: "not found" });
      if (req.user) {
        const isMember = await userIsMember(req.user.id, item.classId);
        if (!isMember) return res.status(404).json({ error: "not found" });
      }
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ---- Admin routes (multi-user mode only) ------------------------------ */

  function adminOnly(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: "admin privileges required" });
    }
    next();
  }

  if (usersByKey) {
    function saveUsers() {
      if (!usersPath) return;
      const users = Array.from(usersByKey.values()).map((u) => ({
        id: u.id,
        name: u.name,
        key: u.key,
        ...(u.isAdmin ? { isAdmin: true } : {}),
        ...(u.avatar ? { avatar: u.avatar } : {}),
      }));
      fs.writeFileSync(usersPath, JSON.stringify({ users }, null, 2) + "\n", "utf8");
    }

    function findUserById(id) {
      for (const u of usersByKey.values()) {
        if (u.id === id) return u;
      }
      return null;
    }

    /* List all users with their keys (admin only) */
    app.get("/api/admin/users", adminOnly, (req, res) => {
      try {
        const all = [];
        for (const user of usersByKey.values()) {
          all.push({ id: user.id, name: user.name, key: user.key, isAdmin: !!user.isAdmin, ...(user.avatar ? { avatar: user.avatar } : {}) });
        }
        res.json(all);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /* Create a new user (admin only) */
    app.post("/api/admin/users", adminOnly, (req, res) => {
      try {
        const { name } = req.body;
        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "name required" });
        }
        const id = crypto.randomUUID();
        const key = crypto.randomBytes(8).toString("hex");
        const user = { id, name: name.trim(), key, isAdmin: false };
        usersByKey.set(user.key, user);
        saveUsers();
        res.status(201).json({ id: user.id, name: user.name, key: user.key, isAdmin: false });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /* Update a user (admin only) */
    app.put("/api/admin/users/:id", adminOnly, (req, res) => {
      try {
        const found = findUserById(req.params.id);
        if (!found) return res.status(404).json({ error: "user not found" });
        const { isAdmin, name } = req.body;
        if (typeof isAdmin === "boolean") found.isAdmin = isAdmin;
        if (typeof name === "string" && name.trim()) found.name = name.trim();
        saveUsers();
        res.json({ id: found.id, name: found.name, key: found.key, isAdmin: !!found.isAdmin });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /* Update current user's own profile (avatar, name) */
    app.put("/api/users/me", (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "authentication required" });
        const { avatar } = req.body;
        if (typeof avatar !== "string") return res.status(400).json({ error: "avatar required" });
        req.user.avatar = avatar;
        saveUsers();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /* Delete all data for a specific user (admin only) */
    app.delete("/api/admin/users/:id", adminOnly, async (req, res) => {
      try {
        const { id } = req.params;

        /* Remove from auth map before deleting data */
        let deletedKey = null;
        for (const u of usersByKey.values()) {
          if (u.id === id) { deletedKey = u.key; break; }
        }

        const userIdCollections = ["attempts", "review_logs", "class_members", "user_progress", "activity_events", "chat"];

        if (pool) {
          for (const c of userIdCollections) {
            await pool.query(
              "DELETE FROM entities WHERE collection = $1 AND data->>'userId' = $2",
              [c, id],
            );
          }
          /* Delete classes owned by this user */
          const owned = await pool.query(
            "SELECT data->>'id' AS class_id FROM entities WHERE collection = 'classes' AND data->>'ownerId' = $1",
            [id],
          );
          const classIds = owned.rows.map((r) => r.class_id).filter(Boolean);
          if (classIds.length > 0) {
            /* Delete all entities belonging to these classes */
            for (const cId of classIds) {
              const classCollections = ["folders", "notes", "quiz", "flashcards", "chunks"];
              for (const c of classCollections) {
                await pool.query(
                  "DELETE FROM entities WHERE collection = $1 AND (data->>'classId' = $2 OR data->>'folderId' IN (SELECT data->>'id' FROM entities WHERE collection = 'folders' AND data->>'classId' = $2))",
                  [c, cId],
                );
              }
              await pool.query("DELETE FROM entities WHERE collection = 'classes' AND id = $1", [cId]);
            }
          }
          /* Delete the user entity itself */
          await pool.query("DELETE FROM entities WHERE collection = 'users' AND id = $1", [id]);
        } else {
          /* In-memory mode */
          for (const c of userIdCollections) {
            const items = memList(c, {});
            for (const item of items) {
              if (item.userId === id) memDelete(c, item.id);
            }
          }
          const ownedClasses = memList("classes", {}).filter((c) => c.ownerId === id);
          for (const cls of ownedClasses) {
            const folders = memList("folders", {}).filter((f) => f.classId === cls.id);
            for (const f of folders) {
              const classCollections = ["notes", "quiz", "flashcards", "chunks"];
              for (const c of classCollections) {
                const items = memList(c, {});
                for (const item of items) {
                  if (item.classId === cls.id || item.folderId === f.id) memDelete(c, item.id);
                }
              }
              memDelete("folders", f.id);
            }
            memDelete("classes", cls.id);
          }
          memDelete("users", id);
        }

        /* Remove from auth map and persist */
        if (deletedKey) usersByKey.delete(deletedKey);
        saveUsers();

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /* Reset the entire database (admin only) */
    app.post("/api/admin/reset-db", adminOnly, async (req, res) => {
      try {
        if (pool) {
          await pool.query("DELETE FROM entities");
        } else {
          memory.clear();
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  /* CRUD routes — one handler per collection */
  const userScopedCollections = new Set(["user_progress", "attempts", "review_logs"]);
  for (const collection of VALID_COLLECTIONS) {
    const list = pool
      ? (q) => listEntities(pool, collection, q)
      : (q) => memList(collection, q);
    const get = pool
      ? (id) => getEntity(pool, collection, id)
      : (id) => memGet(collection, id);
    const put = pool
      ? (id, data) => upsertEntity(pool, collection, id, data)
      : (id, data) => memPut(collection, id, data);
    const del = pool
      ? (id) => deleteEntity(pool, collection, id)
      : (id) => memDelete(collection, id);

    const isUserScoped = userScopedCollections.has(collection);

    app.get(`/api/${collection}`, async (req, res) => {
      try {
        let items = await list(req.query);
        if (req.user && isUserScoped) {
          items = items.filter((item) => item.userId === req.user.id);
        }
        res.json(items);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get(`/api/${collection}/:id`, async (req, res) => {
      try {
        const item = await get(req.params.id);
        if (!item) return res.status(404).json({ error: "not found" });
        if (req.user && isUserScoped && item.userId !== req.user.id) {
          return res.status(404).json({ error: "not found" });
        }
        res.json(item);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.put(`/api/${collection}/:id`, async (req, res) => {
      try {
        const item = await put(req.params.id, req.body);
        res.json(item);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete(`/api/${collection}/:id`, async (req, res) => {
      try {
        await del(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  /* Static SPA serving (desktop mode) */
  if (distDir) {
    app.use(express.static(distDir, {
      setHeaders(res, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== ".html") {
          res.set("cache-control", "public, max-age=31536000, immutable");
        }
      },
    }));
    /* SPA fallback — must be the last middleware */
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  return app;
}

/* ---- startServer ------------------------------------------------------ */

export async function startServer({
  distDir,
  port = 0,
  host = "127.0.0.1",
  dbConfig,
  usersPath,
} = {}) {
  const resolvedDist = distDir
    ? path.resolve(distDir)
    : path.join(__dirname, "..", "dist");

  let pool = null;
  let usersByKey = null;

  if (dbConfig) {
    pool = await createPool(dbConfig);
    if (pool) await initSchema(pool);
  }

  if (usersPath) {
    const { byKey } = loadUsers(usersPath);
    usersByKey = byKey;
  }

  const app = createApp({ pool, usersByKey, distDir: resolvedDist, usersPath });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;

      /* Attach WebSocket server for co-study sessions */
      const wss = createWsServer(server);

      resolve({
        server,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        wss,
      });
    });
    server.once("error", reject);
  });
}
