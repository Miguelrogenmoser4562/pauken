# Pauken v2 — Migration Summary

Full redesign: from a single-user local-first desktop app to a self-hosted,
multi-user study platform with spaced repetition, partner co-study, and
source-grounded AI generation.

---

## Section 1 — Cuts

Removed features that moved to external self-hosted services:

| Removed | Replacement |
|---------|-------------|
| Local AI via Ollama (LocalEngine, localSetup, ollama.mjs) | Cloud AI only (OpenAI/Anthropic/DeepSeek) |
| YouTube extraction (youtube.ts, ytdlp.mjs, Rust yt-extract) | — |
| Podcast generation (PodcastPanel, TTS, podcast prompts) | — |
| `transcribe()` / `tts()` on Engine interface | Self-hosted Whisper proxy at `/api/transcribe` |
| `"youtube"` SourceKind, `"podcast"` JobStage | — |

**Files deleted:** LocalSetupModal, PodcastPanel, youtube.ts, ytdlp.mjs,
vite.youtube-plugin.ts, ollama.mjs. Rust backend stripped of base64/reqwest/yt-dlp.

---

## Section 3 — Multi-User (Server)

### New files

| File | Purpose |
|------|---------|
| `server/db.mjs` | Postgres pool + `entities` table with JSONB (id, collection, data) |
| `server/auth.mjs` | Static-key auth from `users.json`, `authMiddleware()` |
| `server/httpServer.mjs` | Express 5 API: CRUD on 15 collections, Whisper proxy, health, activity |
| `server/users.json` | Example user config (id/name/key) |
| `server/standalone.mjs` | Entry point: env-driven (PORT, HOST, DATABASE_URL, USERS_PATH) |
| `src/lib/api.ts` | `ServerStore` (implements Store over fetch), `verifyKey()`, `serverHealth()` |

### Key types

- `PaukenUser` — id, name, key (from static config)
- `ClassMember` — userId, classId, role (owner/member)
- `UserProgress` — per-user FSRS override

### Connection flow

1. User enters server URL + user key in Onboarding or Settings
2. `POST /api/auth/verify` returns `{ user: { id, name } }`
3. `app.tsx` creates `ServerStore(serverUrl, userKey)` as the Store backend
4. All Repo CRUD transparently goes through HTTP to the server
5. IndexedDB falls back when no server configured

### Deploy infrastructure

- `deploy/docker-compose.yml` — Postgres 17 + API (Dockerfile.api) + whisper.cpp
- `deploy/Dockerfile.api` — Node 22, pre-built `dist/` only (no TypeScript in container)
- `deploy/nginx/pauken.conf` — Reverse proxy with SSL + WS upgrade
- `deploy/systemd/` — pauken-api.service, pauken-whisper.service
- `deploy/scripts/` — setup.sh, deploy.sh, backup.sh

---

## Section 4 — Partner / Co-Study

### New files

| File | Purpose |
|------|---------|
| `server/ws.mjs` | WebSocket server: session create/join/lock-in/leave |
| `src/lib/ws.ts` | `StudyWsClient` with auto-reconnect, exponential backoff |

### Modes

- **Mode A (same-device)** — two users share one screen, dual handleRate
- **Mode B/C (synced)** — WebSocket-mediated sessions with lock-in-to-advance

### Activity feed

- `POST /api/activity/:classId` resolves user names and returns recent events
- Dashboard shows partner activity in class view
- Event types: attempt, note_created, joined_class

### Types added

- `CoStudySession`, `CoStudyParticipant` — session state
- `WsMessage` union — all WS protocol messages
- `ActivityEvent` — async co-study feed

---

## Sections 2 + 5 — Core Pipeline + Hallucination Guard

### Per-concept RAG generation

Replaced the single bundled LLM call with per-concept generation:

1. `extractConcepts()` — LLM decomposes note into atomic concepts
2. Per-concept loop: embed concept query → `retrieveRelevantChunks()` (cosine similarity, top-3) → `chunksToContext()` → LLM generates MCQ + flashcard + sourcePassage
3. Falls back to full note content when embedding unavailable
4. Skips concepts already covered by existing questions (topic dedup)

### Source chunking

- `SourceChunk` type: id, noteId, index, text, embedding
- `src/lib/generation/rag.ts` — `chunkAndEmbed()`, `cosineSimilarity()`, `retrieveRelevantChunks()`, `chunksToContext()`
- Pipeline chunks and embeds source text at ingestion, persists chunks with noteId

### Hallucination guard

- Chat prompt: removed "no citations" — now requires citation like `[§2]`
- "Base your answers strictly on the source material"
- "Do not use external knowledge beyond the source"
- Flashcard/quiz schemas require `sourcePassage` field (verbatim quote or `[paraphrased]`)

### Review tracking

- `ReviewLog` type: userId, questionId, rating, stateBefore/stateAfter, at
- `reviewLogsForNote()` Repo method
- `exportReviewHistory()` — CSV export of all review logs for a note
- Session builder uses real ReviewLogs for weekly cap calculation (replaced `lastReview` approximation)

### New prompts

- `perConceptSystem` / `perConceptSchema` — single-concept generation with RAG context

---

## Architecture Changes

| Aspect | Before | After |
|--------|--------|-------|
| Engine mode | `"local" \| "cloud"` | `"cloud"` only |
| Data store | IndexedDB only | IndexedDB (local) or ServerStore (HTTP) |
| Audio ingest | OpenAI Whisper via engine | Self-hosted Whisper proxy |
| Auth | OS keychain only | Static key via users.json |
| Practice items | Bundled LLM call | Per-concept RAG loop |
| Source grounding | None | Chunks, embeddings, citations |
| Co-study | — | WebSocket + activity feed |
| Deploy | Desktop-only | Docker compose + systemd |

---

## Deploy Bugs Fixed During Session

1. **`deploy/users.example.json`** — was bare array, needed `{"users": [...]}` wrapper
2. **Postgres password mismatch** — setup.sh used random password, but systemd hardcoded `pauken`
3. **`deploy.sh` excluded `dist/`** — rsync excluded built frontend that server needs
4. **whisper.cpp tag** — `:server` didn't exist, corrected to `:main`
5. **Dockerfile.api** — `npm ci --omit=dev` stripped TypeScript, blocking build; changed to pre-built `dist/`
6. **Postgres port conflict** — removed port mapping (`127.0.0.1:5432:5432`) so Docker Postgres doesn't collide with host
7. **`GenerationProgress` useEffect** — empty deps `[]` meant pipeline never started when repo arrived late
8. **`handleGenerate`** — no try/catch on auto unit folder creation, missing engine silently dead-ended
