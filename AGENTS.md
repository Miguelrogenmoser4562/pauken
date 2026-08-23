# AGENTS.md

## Commands

```bash
npm run dev          # Vite dev server on http://localhost:1420 (proxies /api to localhost:4180)
npm run serve        # Production server at http://localhost:4180 (browser-only, no Electron)
npm run app          # Build + open in Electron desktop shell
npm run app:nobuild  # Open Electron without rebuilding
npm test             # vitest run (all tests)
npm run test:watch   # vitest (watch mode)
npm run typecheck    # tsc --noEmit
npm run build        # tsc && vite build
```

**Single test file:** `npx vitest run src/lib/db/db.test.ts`

**Build order matters:** `typecheck` → `build` → `app`/`dist`. The `build` script itself runs `tsc` first, then `vite build`. For `dist` (electron-builder), the built `dist/` directory must exist.

**No linter or formatter** is configured. TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is the sole enforcement. There is no ESLint, no Prettier, no `.prettierrc`, no `.eslintrc`.

**.env file:** The Electron shell reads `.env` from the project root on launch (`electron/main.mjs:22-36`). It loads env vars (e.g. `DEEPSEEK_API_KEY`) that are NOT set before `process.env`. The SPA in dev mode uses Vite's proxy (`vite.config.ts:22-30`) to forward `/api` to `http://127.0.0.1:4180`.

## Architecture

This is a **desktop application**, NOT a web service. No Docker, no cloud hosting, no Kubernetes. The primary target is Electron; Tauri exists as a secondary target.

### Two runtime modes

| Mode | Entry | Port | Data storage |
|------|-------|------|-------------|
| Browser dev | `npm run dev` (Vite) | 1420 | IndexedDB in browser |
| Desktop (Electron) | `npm run app` | 4180 | IndexedDB + local Node server |

### Data storage

- **IndexedDB** (via `idb` package) is the primary store. All notes, flashcards, quiz questions, chat history, jobs, and reminders live here (`src/lib/db/idb.ts`).
- The Node.js server (`server/httpServer.mjs`) is **optional** — it provides in-memory CRUD for local mode, and Postgres-backed CRUD for multi-user mode. In local/single-user mode, the SPA reads/writes IndexedDB directly without going through the server.
- `localStorage` key `pauken.prefs` for user preferences (`src/lib/prefs.ts`).
- `localStorage` key `pauken.apikey` for API key fallback in web/Electron when Tauri keychain is unavailable (`src/lib/engine/keys.ts`).

### Engine abstraction

All AI providers implement the `Engine` interface (`src/lib/engine/types.ts:36-52`). The rest of the app (generation, chat, etc.) calls `engine.complete()` or `engine.structured()` without branching on provider.

Provider selection: `src/lib/engine/index.ts` creates the appropriate engine based on `EnginePrefs.mode` (cloud → OpenAI/Anthropic/DeepSeek via `DeepSeekEngine`, local → Ollama via `LocalEngine`).

### LLM prompts

**All prompts and JSON schemas live in `src/lib/prompts/index.ts`.** This is the single source of truth. When changing LLM behavior, edit the prompt strings and schemas there, not inline in generation code.

### Key directories

```
src/lib/engine/       LLM provider abstraction (OpenAI, Anthropic, DeepSeek, Ollama)
src/lib/ingest/       Source → text (PDF, DOCX, URL, YouTube, audio)
src/lib/generation/   Note creation pipeline, flashcards, quizzes, chat, podcasts
src/lib/study/        FSRS scheduler, session composition, mastery
src/lib/db/           IndexedDB store + Repo abstraction
src/lib/prompts/      All LLM prompts and JSON schemas
src/components/       React components
src/pages/            Route-level page components
server/               Node.js HTTP server (CRUD API + Ollama/yt-dlp helpers)
electron/             Electron main process (main.mjs)
src-tauri/            Tauri Rust backend (keychain, yt-dlp)
```

## Testing

- **Framework:** Vitest 4 + Testing Library
- **Test file pattern:** `src/**/*.test.ts` (node env) and `src/**/*.test.tsx` (jsdom env). Tests live next to source.
- **Config:** `vitest.config.ts` — default `environment: "node"`. jsdom is selected per-file with the `/* @vitest-environment jsdom */` docblock pragma (the `environmentMatchGlobs` option was removed in Vitest 4).
- **jsdom + WebSocket:** tests that exercise `StudyWsClient`/co-study flows must replace `globalThis.WebSocket` with the `ws` package client (Node's undici WebSocket is incompatible with jsdom). See `src/pages/sync-join.test.tsx`.

## FSRS quirks

- NEW flashcards start with `state: "new"` and `due` set to a far-future sentinel (~year 2099). They are only surfaced when the session system introduces them from the backlog.
- **Cold-start override**: The first REVIEW interval is ~15-20% of remaining days until an exam date (`src/lib/study/fsrs.ts:44-47`).
- **Exam-date ceiling**: All intervals are capped so the next review falls at least 3 days before the exam.
- **Difficulty blending**: Seeded difficulty (from concept extraction) is averaged with FSRS-computed difficulty on first graduation.

## Conventions

- Node.js server-side code uses `.mjs` extension (ESM) with plain JS. Front-end code uses `.ts`/`.tsx`.
- `sync-server.sh` and `docs/ui-reference/` are gitignored — they contain private deployment targets.
- The Tauri build (`src-tauri/`) is a secondary target with no CI pipeline. Electron is the primary distribution path.
