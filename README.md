# Pauken

**Turn any lecture, PDF, or video into study notes, flashcards, quizzes, and a study chat — free, and private by default.** Pauken is an open-source, local-first desktop application. Point it at a document, a website, a YouTube link, or an audio file and it generates structured notes (with math rendering), spaced-repetition flashcards, adaptive quizzes, and a chat assistant grounded in your material. Everything runs on your machine with no account, no telemetry, and no subscription.

---

## Architecture & Infrastructure

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Desktop Shell (Electron / Tauri)                  │
│                                                                      │
│  ┌──────────────┐    ┌────────────────┐    ┌──────────────────────┐  │
│  │  React SPA   │◄──►│  Local Server  │◄──►│  Ollama (local AI)   │  │
│  │  (Vite SPA)  │    │  (Node http)   │    │  qwen2.5:3b + nomic  │  │
│  │              │    │                │    │                      │  │
│  │  IndexedDB   │    │  /api/youtube  │    │  └──────────────────┘  │
│  │  (all data)  │    │  /api/local/*  │    │                       │
│  │              │    │  /api/health   │    │  Cloud API (optional)  │
│  └──────┬───────┘    └────────────────┘    │  OpenAI / Anthropic    │
│         │                                  │  / DeepSeek           │
│         ▼                                  └──────────────────────┘
│  ┌──────────────┐                                                   │
│  │  OS Keychain │  (API key storage in Tauri builds)                │
│  └──────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Architecture shape:** Modular monolith — a single React SPA with clearly separated domains (`lib/engine`, `lib/ingest`, `lib/generation`, `lib/study`, `lib/db`). It is not a microservices architecture; there is no backend server beyond a thin local Node.js HTTP server that wraps native-only capabilities (yt-dlp extraction, Ollama lifecycle). In cloud mode, the app talks directly to OpenAI/Anthropic/DeepSeek APIs from the browser/webview; in local mode it talks to a locally-running Ollama instance.

**Hosting:** None — Pauken is a desktop application. It is never deployed as a hosted web service. There are no Dockerfiles, no Terraform manifests, no Kubernetes configs, and no platform configs (no vercel.json, netlify.toml, fly.toml, etc.).

**Deployment path:**
1. Tag a commit (`git tag v0.1.x && git push --tags`)
2. GitHub Actions workflow (`.github/workflows/release.yml`) builds macOS `.dmg`, Windows `.exe`, and Linux `.AppImage` via `electron-builder`
3. Builds are attached to a GitHub Release
4. Optionally code-signed (macOS Developer ID, Windows Authenticode) via GitHub Secrets

**Key infra components:**
| Component | Technology | Notes |
|-----------|-----------|-------|
| Client-side database | **IndexedDB** (via `idb` package) | All notes, flashcards, quiz questions, chat history, podcasts, jobs, reminders stored here |
| Local AI runtime | **Ollama** | Auto-downloaded and managed by the app on macOS/Linux; Windows users install manually |
| Cloud AI providers | **OpenAI**, **Anthropic**, **DeepSeek** | User's own API key; stored in OS keychain (Tauri) or localStorage (Electron/browser) |
| YouTube extraction | **yt-dlp** | Downloaded on-demand; accessed via the local Node server |
| Desktop shell | **Electron** (primary), **Tauri** (alternative) | The Electron shell is the main distribution target |
| Signing | Apple Developer ID + Windows Authenticode | Optional; ad-hoc fallback works with one-time OS warnings |

**External dependencies the app talks to over the network:**
- `api.openai.com` (OpenAI API, including Whisper transcription)
- `api.anthropic.com` (Anthropic Claude API)
- `api.deepseek.com` (DeepSeek API)
- `www.youtube.com` (timedtext captions, video page scraping)
- `github.com/ollama/ollama` (Ollama binary downloads)
- `github.com/yt-dlp/yt-dlp` (yt-dlp binary downloads)

**Secrets management:**
- API keys stored in OS keychain via `keyring` crate (Tauri builds: `src-tauri/src/lib.rs`)
- Fallback to `localStorage` in Electron/browser-only mode (`src/lib/engine/keys.ts`)
- Preferences in `localStorage` key `pauken.prefs` (`src/lib/prefs.ts`)
- No `.env` file; all config is user-driven via the UI

**Environments:** None distinguished — there is no dev/staging/prod split. The CI workflow differentiates by git tag (tagged = release build, untagged = regular commits get no artifacts).

---

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Language** | TypeScript 5.8 | Entire app (frontend, server, build tooling) |
| **Language** | Rust (via Tauri) | OS-level API bindings (keychain, yt-dlp) |
| **UI Framework** | React 19 | Component tree and rendering |
| **Bundler** | Vite 7 | Dev server and production builds |
| **Styling** | Tailwind CSS v4 | Utility-first CSS |
| **Desktop Shell** | Electron 43 | Primary desktop distribution |
| **Desktop Shell** | Tauri 2 | Alternative desktop distribution (Rust backend) |
| **Database** | IndexedDB (`idb` package) | Client-side document store |
| **Routing** | React Router 7 | Client-side navigation |
| **Local AI** | Ollama (qwen2.5:3b, nomic-embed-text) | Fully local LLM inference |
| **Cloud AI** | OpenAI, Anthropic, DeepSeek | Cloud LLM + embeddings + TTS |
| **SRS** | ts-fsrs 5.4 | FSRS spaced repetition algorithm |
| **Math** | KaTeX 0.18 | LaTeX math rendering |
| **Markdown** | marked 18 | Markdown → HTML rendering |
| **PDF** | pdfjs-dist 6 | PDF text extraction |
| **DOCX** | mammoth 1.12 | DOCX text extraction |
| **Sanitization** | DOMPurify 3 | HTML output sanitization |
| **Icons** | Lucide React 1 | SVG icon library |
| **Fonts** | Fontsource (Quicksand, Nunito) | UI typography |
| **Testing** | Vitest 4 + Testing Library | Unit and component tests |
| **Packaging** | electron-builder 26 | Installers (DMG, NSIS, AppImage) |
| **YouTube** | yt-dlp | Caption and audio extraction |
| **Audio TTS** | OpenAI TTS API | Podcast voice synthesis (cloud mode) |
| **Audio STT** | OpenAI Whisper API | Audio transcription (cloud mode) |

---

## Features

### Source Ingestion (`src/lib/ingest/`)

Turns any supported input type into normalized plain text for downstream generation.

**Supported sources:**
| Source | Handler | File | Mechanism |
|--------|---------|------|-----------|
| Plain text | `ingestText` | `text.ts` | Direct text input or `.text()` on uploaded file |
| Web URL | `ingestUrl` | `url.ts` | Fetches page HTML, extracts readable text |
| YouTube | `ingestYoutube` | `youtube.ts` | Browser-side timedtext API or server-side yt-dlp |
| PDF | `ingestPdf` | `pdf.ts` | `pdfjs-dist` text extraction |
| DOCX | `ingestDocx` | `docx.ts` | `mammoth` text extraction |
| Audio | `ingest` router | `index.ts:81-91` | Returns blob; transcription deferred to engine |
| Blank | `ingest` router | `index.ts:52` | Returns empty text for user-typed notes |

**Entry point:** `src/lib/ingest/index.ts` — `ingest(input: IngestInput): Promise<IngestResult>`. Routes by `input.kind` to the format-specific extractor. Returns `{ text, title?, meta?, needsTranscription?, audio? }`.

Audio files are not transcribed during ingestion; the pipeline checks `needsTranscription` and dispatches to `engine.transcribe()` (Whisper API in cloud mode) before generating notes (`src/lib/generation/pipeline.ts:84-95`).

### Note Generation Pipeline (`src/lib/generation/pipeline.ts`)

The core flow: ingest → transcribe (if audio) → generate note body → title → summary → persist → optionally generate study tools.

**Entry point:** `createNoteFromSources(opts: CreateNoteOptions): Promise<string>` at `pipeline.ts:40`.

**Pipeline steps:**
1. **Ingest** each source file, tracking per-file success/failure (`pipeline.ts:74-112`)
2. **Transcribe** audio files if needed (`pipeline.ts:84-95`, calls `engine.transcribe()`)
3. **Generate note body** via `generateNoteBody()` using a map-reduce strategy for large docs (`pipeline.ts:128-137`, delegates to `generation/index.ts:61-115`)
4. **Generate title** via `generateTitle()` (~8 word summary) (`pipeline.ts:144-146`)
5. **Generate summary** via `generateSummary()` (bullet-point summary) (`pipeline.ts:154-158`)
6. **Persist** the Note to IndexedDB (`pipeline.ts:163-179`)
7. **Background study tools:** Calls `generatePracticeItems()` for MCQ + flashcards (`pipeline.ts:189-204`)

**Job system:** The pipeline emits a `Job` object persisted to IndexedDB (`COLLECTIONS.jobs`). Progress callbacks (`onProgress`) flow through every stage. On app relaunch, `reconcileJobs()` marks any stale "running" jobs as errored (`pipeline.ts:211-218`).

**Map-reduce for large documents** (`generation/index.ts:61-115`):
- Source text is chunked by tokens (`chunkByTokens(text, 6000, 150)`)
- If single chunk: one LLM call with `noteSystem()` + `noteUser()`
- If multi-chunk: each chunk gets a `noteSectionSystem()` call, then all sections are merged by a `noteReduceSystem()` call

### Practice Items: Flashcards + Quiz Questions (`src/lib/generation/index.ts`)

A two-phase generation pipeline for creating study material.

**Phase 1 — Concept extraction** (`extractConcepts`, `generation/index.ts:160-182`):
- Calls `engine.structured()` with `conceptsSystem` prompt + `conceptsSchema`
- Returns `ExtractedConcept[]` with `{ id, title, detail, difficulty (1-10) }`
- Target count is density-normalized: ~1 concept per 2000 characters of note text, clamped to [5, 40]

**Phase 2+3 — Bundled MCQ + flashcard generation** (`generateBundledContent`, `generation/index.ts:186-254`):
- One LLM call per note (not per concept) with `flashcardContentSystem` prompt
- Returns `{ question, options, correctIndex, explanation, flashcardFront, flashcardBack, flashcardContext }` per concept
- Supports dedup: if `existingQuestions` is provided (e.g., adding to an existing topic), the LLM is told to skip covered concepts

**Main entry:** `generatePracticeItems(engine, note, existingQuestions?)` at `generation/index.ts:260-298`. Returns `{ questions: QuizQuestion[], flashcards: Flashcard[] }`. Each question is seeded with FSRS state via `newQuestionState()` (state="new", due=FAR_FUTURE_SENTINEL).

### FSRS Spaced Repetition (`src/lib/study/fsrs.ts`)

Wraps `ts-fsrs` with Pauken-specific scheduling conventions.

**Key customizations:**
- **NEW backlog:** Generated cards start with `state: "new"` and `due` set to a far-future sentinel (~year 2099) until the session system introduces them (`fsrs.ts:63-80`)
- **Cold-start override:** The first REVIEW interval is ~15-20% of remaining days until an exam date, giving a sensible first spacing (`fsrs.ts:44-47`, applied at `fsrs.ts:143-149`)
- **Exam-date ceiling:** All intervals are capped so the next review falls at least 3 days before the exam (`fsrs.ts:50-57`, applied at `fsrs.ts:151-152`)
- **Difficulty blending:** When a NEW card graduates, the seeded difficulty (from concept extraction) is averaged with the FSRS-computed difficulty for a smooth transition (`fsrs.ts:126-129`)

**Core function:** `reviewQuestion(question, rating, nowMs?, examDate?): QuizQuestion` at `fsrs.ts:84-168`. Updates the question's scheduling fields based on the rating (`again`/`hard`/`good`/`easy`).

**Convenience queries:**
- `dueQuestions()` — questions whose `due` has arrived (`fsrs.ts:183-191`)
- `backlogQuestions()` — NEW questions ordered by generation time (`fsrs.ts:194-201`)
- `studyOrderQuestions()` — learning/relearning first, then by due date (`fsrs.ts:204-218`)

### Study Session System (`src/lib/study/session.ts`)

Composes a daily practice session from the full question pool.

`buildSession(allQuestions, defaults, nowMs?, examDate?): Session` at `session.ts:32-69`:

1. **Due queue** — REVIEW + RELEARNING questions with `due ≤ now`
2. **Weekly per-item cap** — limits how many times a question can appear per week (approximated via `lastReview` + `reps`)
3. **Backlog pacing** — pulls up to `maxNewCardsPerSession` NEW questions
4. **Early-review fallback** — if nothing is due, pull questions due within the next 3 days

### Study Chat (`src/components/Assistant.tsx` + `src/lib/generation/index.ts`)

A chat interface grounded in a specific note's content.

**Entry:** `Assistant` component at `components/Assistant.tsx:33`. Two variants: `"hero"` (full-page) and `"panel"` (collapsible sidebar in the editor view).

**How it works:**
1. User enters a question (optionally attaching PDF/DOCX/TXT files)
2. Attachments are ingested to text via `fileToAttachment()` (`Assistant.tsx:17-28`)
3. `chatAnswer(engine, note, history, question, onToken)` is called (`generation/index.ts:354-374`)
4. The LLM receives a `chatSystem` prompt containing the note's title and study content (capped at 8000 tokens)
5. Response streams token-by-token via `onToken` callback
6. Both user message and assistant response are persisted to IndexedDB
7. History is loaded from `repo.chatFor(note.id)` on mount

The chat input includes file attachment support (PDF, DOCX, TXT, Markdown). Responses render Markdown with KaTeX math via `renderMarkdown()`.

### Podcast Generation (`src/components/PodcastPanel.tsx` + `src/lib/generation/index.ts`)

Creates a two-host (host + guest) dialogue study podcast from note content.

**Two-phase flow:**
1. **Script generation:** `generatePodcastScript(engine, note, length)` at `generation/index.ts:378-394`. Calls `engine.structured()` with `podcastSystem` prompt + `podcastSchema`. Returns a `Podcast` with `{ lines: [{ speaker, text, spoken }] }`. The `spoken` field is TTS-optimized (phonetic respelling, expanded abbreviations).
2. **Audio synthesis:** `synthesizePodcastAudio(engine, podcast, voices, signal?)` at `generation/index.ts:398-413`. Iterates through each script line, calls `engine.tts()` (OpenAI TTS in cloud mode), and concatenates the audio blobs into a single MP3.

**Lengths:** `short` (~12 turns), `medium` (~24 turns), `long` (~40 turns).

### Export (`src/lib/export.ts`)

Three export paths from the `EditorView` component:
- **Markdown:** `exportMarkdown(note)` — `# title` + `blocksToMarkdown()` output
- **Word (.doc):** `exportDocxHtml(note)` — Word-compatible HTML document
- **PDF:** `printPdf(note)` — opens a new window with rendered HTML and triggers the browser's Print dialog (user selects "Save as PDF")

### Organizer (Dashboard + Classes + Units + Reminders)

The `Dashboard` page (`src/pages/Dashboard.tsx`) provides a hierarchical organization system:

- **Classes** — top-level containers (e.g., "Biology 101")
- **Units** (Folders) — sub-containers within a class (e.g., "Chapter 1: Cell Structure")
- **Notes** — assigned to a unit and optionally categorized as "Knowledge" or "Practice"
- **Quick Reminders** — lightweight todo items, optionally tied to a class or due date

Navigation uses URL query params: `/?class=<id>&folder=<id>`. Notes can be dragged between units.

### Local AI Provisioning (`server/ollama.mjs`)

When the user selects local mode on macOS/Linux:

1. `findBinary()` — checks `PATH` and app data directory for existing Ollama binary
2. If not found, `downloadBinary()` downloads the official standalone build from GitHub Releases (~150 MB) and extracts it to the app's data directory
3. `ensureServing()` — starts `ollama serve` with CORS opened to the app origin; waits up to 20s for it to respond
4. `pullModel()` — downloads the default chat model (qwen2.5:3b, ~1.9 GB) and embedding model (nomic-embed-text), streaming progress to the UI via SSE
5. Writes a `.provisioned` marker file so the shell re-launches Ollama on next start without re-downloading

**Windows:** Automatic setup is not supported; users are directed to install Ollama manually from ollama.com.

**UI:** `LocalSetupModal` component (`src/components/LocalSetupModal.tsx`) shows streaming progress. Provisioning is managed via `src/lib/localSetup.ts`.

### YouTube Extraction (`server/ytdlp.mjs` + `src/lib/ingest/youtube.ts`)

Two extraction paths, selected by availability:

1. **Browser path** (`youtube.ts`): Fetches the video page and parses available captions from the `timedtext` API. No binary dependency.
2. **Server path** (`ytdlp.mjs`, behind `/api/youtube-extract`): Uses `yt-dlp` to download captions. `yt-dlp` is auto-downloaded on first use. A Vite dev server plugin (`vite.youtube-plugin.ts`) injects the same endpoint during development.

The Tauri version invokes yt-dlp from the Rust side (`src-tauri/src/lib.rs`, `youtube_extract` command).

---

## Data Flow / Request Lifecycle

### Note Creation

```
User uploads source  →  Dashboard (Dashboard.tsx)
    →  navigate to /generation (GenerationProgress.tsx)
    →  createNoteFromSources() (pipeline.ts)
        →  ingest(inputs[i]) for each source (ingest/index.ts)
            →  ingestYoutube / ingestPdf / ingestDocx / ingestUrl / ingestText
            →  if audio: engine.transcribe(audio)
        →  generateNoteBody(engine, combinedText)
            →  chunkByTokens() → LLM calls (map) → noteReduceSystem (reduce)
        →  generateTitle(engine, text)
        →  generateSummary(engine, content)
        →  repo.putNote(note)  (IndexedDB)
        →  if generateStudyTools:
            →  generatePracticeItems(engine, note)
                →  extractConcepts() → LLM structured output
                →  generateBundledContent() → LLM structured output
                →  repo.putQuestions(), repo.putFlashcards()
    →  redirect to /notes/:id/editor
```

### Practice Session

```
User clicks "Practice"  →  Dashboard.href=/practice?class=X
    →  Practice.tsx loads all QuizQuestions for the class
    →  buildSession(allQuestions, defaults) (session.ts)
        →  dueQuestions(): REVIEW + RELEARNING where due ≤ now
        →  backlogQuestions(): NEW backlog, slice to maxNewCardsPerSession
        →  early-review fallback if nothing is due
    →  User answers question, clicks "Good" / "Again" etc.
    →  reviewQuestion(question, rating) (fsrs.ts)
        →  FSRS.next() computes new stability, difficulty, interval
        →  Cold-start override applied if first REVIEW
        →  Exam-date ceiling applied
        →  repo.putQuestion(updatedQuestion) + repo.putAttempt(attempt)
```

### Chat

```
User types question in Assistant  →  components/Assistant.tsx
    →  chatAnswer(engine, note, history, question, onToken) (generation/index.ts)
        →  engine.complete() with chatSystem(note.title, studyContent(note))
        →  LLM streams response token-by-token → UI updates live
    →  assistant turn persisted to repo.putChat()
    →  Markdown + KaTeX rendered via renderMarkdown() (markdown.ts:330-340)
```

---

## Local Development / Deployment

### Prerequisites

- **Node.js ≥ 20.19** (Node 21.x not supported; use 22 LTS)

### Quick Start

```bash
git clone https://github.com/your-fork/pauken.git
cd pauken
npm install

npm run dev         # Vite dev server on http://localhost:1420 (includes YouTube helper)
npm run serve       # Build once, then serve at http://localhost:4180 (browser-only)
npm run app         # Build + open in Electron desktop shell
```

### Other Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm test` | `vitest run` | Run all tests |
| `npm run test:watch` | `vitest` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` | TypeScript type checking |
| `npm run build` | `tsc && vite build` | Production build |
| `npm run dist:mac` | `electron-builder --mac` | macOS DMG installer |
| `npm run dist:win` | `electron-builder --win` | Windows NSIS installer |
| `npm run dist` | `electron-builder` | All platforms |

### Production Build & Release

1. Bump version in `package.json`
2. Tag: `git tag v0.1.x && git push --tags`
3. GitHub Actions (`.github/workflows/release.yml`) builds macOS + Windows + Linux installers and attaches them to a GitHub Release
4. Optional code signing via GitHub Secrets (see below)

### Code Signing

Builds are ad-hoc signed by default (works, but shows one-time OS warnings). To get silent installs:

**macOS** (needs Apple Developer account):
| Secret | Value |
|--------|-------|
| `CSC_LINK` | Developer ID cert as base64 `.p12` |
| `CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-char Team ID |

**Windows** (optional):
| Secret | Value |
|--------|-------|
| `WIN_CSC_LINK` | Authenticode cert as base64 `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | `.pfx` password |

### Project Layout

```
src/            React application
  lib/
    engine/     LLM provider abstraction (OpenAI, Anthropic, DeepSeek, Ollama)
    ingest/     Source → text conversion (PDF, DOCX, URL, YouTube, audio)
    generation/ Notes, flashcards, quiz, podcast, chat generation
    study/      FSRS scheduler, session composition, mastery, diagnostics
    db/         IndexedDB store + Repo abstraction layer
    prompts/    Versioned LLM prompts + JSON schemas
  components/   React components (Editor, Assistant, Flashcards, Quiz, Podcast)
  pages/        Route-level page components
  styles/       Tailwind + CSS custom properties
server/         Local Node.js HTTP server
  httpServer.mjs  API endpoints + static file serving
  ytdlp.mjs       yt-dlp download and extraction
  ollama.mjs      Ollama install/serve/pull lifecycle
electron/       Electron desktop shell
src-tauri/      Tauri Rust backend (keychain, yt-dlp)
```

---

## Open Questions / Gaps

- **Audio transcription via `engine.transcribe()`** is implemented only in `OpenAIEngine` (Whisper API). The `LocalEngine` has no transcription support yet (a future Kokoro/Whisper.cpp integration is mentioned in comments but not wired).
- **Local TTS** (text-to-speech) is similarly unimplemented in the local engine — functions like `engine.tts()` are called only in cloud mode. The code references a future "Kokoro" local TTS integration.
- **Embeddings** (`engine.embed()`) are defined in the `Engine` interface and implemented in OpenAI/Local engines, but no feature currently uses them. They appear to be future RAG infrastructure.
- **Weekly per-item review cap** (`session.ts:22-29`) uses `lastReview` + `reps` as an approximation — it cannot accurately count reviews within a rolling week without a full review log.
- **Tauri build** exists (`src-tauri/`) but the primary distribution targets use Electron. The Tauri build is less mature (no CI pipeline, feature parity not confirmed).
- **Windows local AI setup** is manual — the `downloadBinary()` function for Windows throws with instructions to install Ollama manually. This is a known gap noted in docs.
- **Version history** button exists in the editor UI (`NoteView.tsx:176-177`) but the feature is not implemented (no icon handler).

---

## License

[AGPL-3.0-or-later](LICENSE)
