/* Note-creation pipeline: ingest -> (transcribe) -> notes -> title -> persist.
   Emits Job progress and records per-file success/fail (Turbo silently drops
   files 3-5 of a multi-upload; we show every file's status explicitly). Jobs are
   persisted so a crash mid-generation is recoverable on relaunch. */

import type { Engine } from "../engine/types";
import { EngineError } from "../engine/types";
import type { Repo } from "../db";
import type { Job, JobFile, Note, QuizQuestion, SourceKind } from "../types";
import { uuid, now } from "../ids";
import { ingest, type IngestInput } from "../ingest";
import { generateNoteBody, generatePracticeItems, generateSummary, generateTitle } from "./index";
import { chunkAndEmbed } from "./rag";
import { ocrSystem } from "../prompts";

/* Self-hosted Whisper API endpoint (OpenAI-compatible). Configure via env var
   or update this default when setting up your server in Phase A. */
const WHISPER_API_URL =
  import.meta.env.VITE_WHISPER_API_URL ?? "/api/transcribe";

async function transcribeAudio(
  audio: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "audio.webm");
  form.append("model", "whisper-1");
  form.append("response_format", "json");

  const res = await fetch(WHISPER_API_URL, {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    const msg = `Whisper API returned ${res.status}`;
    throw new EngineError(msg, "unknown");
  }
  const json = await res.json();
  return json.text ?? "";
}

export type ProgressCb = (job: Job) => void;

export interface CreateNoteOptions {
  repo: Repo;
  engine: Engine;
  inputs: IngestInput[];
  /* Optional vision-capable engine used only to OCR image-only (scanned)
     PDFs. Falls back to `engine` when omitted. Generation always uses
     `engine` (DeepSeek). */
  ocrEngine?: Engine;
  language?: string;
  /* Class/unit context for organization. */
  classId?: string;
  folderId?: string;
  /* Whether this note is study material or practice problems. */
  contentCategory?: "knowledge" | "practice";
  /* Topic label within the unit. */
  topic?: string;
  /* What kind of content this is. */
  contentScope?: "new_topic" | "new_unit" | "additional" | "general";
  /* Auto-generate flashcards + quiz after the note. */
  generateStudyTools?: boolean;
  /* Toggle for generating full written summary (default true). */
  generateSummary?: boolean;
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}

function primaryKind(inputs: IngestInput[]): SourceKind {
  return inputs[0]?.kind ?? "text";
}

export async function createNoteFromSources(
  opts: CreateNoteOptions,
): Promise<string> {
  const { repo, engine, inputs, language = "English", onProgress } = opts;

  const job: Job = {
    id: uuid(),
    label:
      inputs.length > 1
        ? `${inputs.length} sources`
        : inputs[0]?.filename || inputs[0]?.url || "New note",
    stage: "ingest",
    status: "running",
    progress: 0,
    message: "Reading sources…",
    files: inputs.map<JobFile>((i) => ({
      name: i.filename || i.url || i.kind,
      status: "queued",
    })),
    createdAt: now(),
    updatedAt: now(),
  };

  const emit = async (patch: Partial<Job>) => {
    Object.assign(job, patch, { updatedAt: now() });
    await repo.putJob(job);
    onProgress?.({ ...job });
  };
  await emit({});

  // 1. Ingest + transcribe each source, tracking per-file status.
  const texts: string[] = [];
  const metas: Record<string, string | number | undefined>[] = [];
  let anyOk = false;
  for (let i = 0; i < inputs.length; i++) {
    const file = job.files![i];
    file.status = "running";
    await emit({
      stage: "ingest",
      message: `Processing ${file.name}…`,
      progress: (i + 0.2) / (inputs.length + 1),
    });
    try {
      const res = await ingest(inputs[i]);
      let text = res.text;
      if (res.needsTranscription && res.audio) {
        if (res.audio.size > 24 * 1024 * 1024) {
          throw new Error(
            "This audio is over 24 MB — larger than the transcription limit. " +
              "Split it into shorter clips.",
          );
        }
        file.status = "running";
        await emit({ stage: "transcribe", message: `Transcribing ${file.name}…` });
        text = await transcribeAudio(res.audio, opts.signal);
      } else if (res.needsOcr && (res.fileDataUrl || (res.pageImages && res.pageImages.length > 0))) {
        const ocrEngine = opts.ocrEngine ?? engine;
        if (!ocrEngine.capabilities().vision) {
          throw new Error(
            "This PDF is a scan or image with no selectable text. " +
              "Paste the text instead — no OCR engine is configured.",
          );
        }
        file.status = "running";
        let ocrText: string;
        if (res.fileDataUrl) {
          /* Send the original file to the vision engine so it can read native
             text / do OCR in one shot (cheaper + more accurate than per-page
             re-rendered images). */
          await emit({
            stage: "ocr",
            message: `Reading ${file.name}…`,
            progress: (i + 0.5) / (inputs.length + 1),
          });
          ocrText = await ocrEngine.ocrImage(res.fileDataUrl, {
            system: ocrSystem,
            signal: opts.signal,
            filename: file.name,
          });
        } else {
          /* Fallback: OCR each rendered page image individually. */
          const pagesImages = res.pageImages ?? [];
          const pages: string[] = [];
          for (let p = 0; p < pagesImages.length; p++) {
            await emit({
              stage: "ocr",
              message: `Reading page ${p + 1} of ${pagesImages.length}…`,
              progress: (i + (p + 1) / pagesImages.length) / (inputs.length + 1),
            });
            pages.push(
              await ocrEngine.ocrImage(pagesImages[p], { system: ocrSystem, signal: opts.signal }),
            );
          }
          ocrText = pages.join("\n\n");
        }
        text = ocrText;
      }
      if (!text.trim() && inputs[i].kind !== "blank") {
        throw new Error("No readable content found.");
      }
      texts.push(text);
      if (res.meta) metas.push(res.meta);
      file.status = "done";
      anyOk = true;
    } catch (err) {
      file.status = "error";
      file.error =
        err instanceof EngineError || err instanceof Error
          ? err.message
          : "Failed to process.";
    }
    await emit({ progress: (i + 1) / (inputs.length + 1) });
  }

  if (!anyOk) {
    await emit({
      status: "error",
      message: "None of the sources could be read.",
      error: job.files?.find((f) => f.error)?.error,
    });
    throw new EngineError(job.error || "Ingestion failed.", "unknown");
  }

  const combined = texts.join("\n\n---\n\n");
  const isBlank = primaryKind(inputs) === "blank" && !combined.trim();

  // 2. Chunk + embed source text for RAG (always, regardless of summary toggle).
  let chunks: import("../types").SourceChunk[] = [];
  if (!isBlank && combined.trim()) {
    try {
      const sourceName = inputs.length === 1 && inputs[0]?.filename ? inputs[0].filename : undefined;
      chunks = await chunkAndEmbed(engine, "pending", combined, sourceName);
    } catch {
      /* embedding is best-effort */
    }
  }

  // 3. Generate the note body (streaming) — optional, controlled by prefs.
  const generateSummaryPref =
    typeof opts.generateSummary === "boolean"
      ? opts.generateSummary
      : true;
  let blocks: Note["blocks"] = [];
  if (!isBlank && generateSummaryPref) {
    await emit({ stage: "notes", message: "Writing your notes…", progress: 0.75 });
    blocks = await generateNoteBody(
      engine, combined, language, undefined,
      (current, total) => emit({
        stage: "notes",
        message: `Writing section ${current} of ${total}…`,
        progress: 0.75 + 0.17 * current / total,
      }),
    );
  }

  // 3. Title.
  await emit({ stage: "title", message: "Naming the note…", progress: 0.92 });
  let title = "Untitled Document";
  if (!isBlank) {
    try {
      title = await generateTitle(engine, combined);
    } catch {
      /* keep default title */
    }
  }

  // 4. Summary.
  let summary: string | undefined;
  if (!isBlank) {
    await emit({ stage: "title", message: "Writing summary…", progress: 0.95 });
    try {
      summary = await generateSummary(engine, combined);
    } catch {
      /* keep no summary */
    }
  }

  // 5. Persist.
  const note: Note = {
    id: uuid(),
    title,
    sourceKind: primaryKind(inputs),
    sourceText: combined,
    sourceMeta: metas[0],
    blocks,
    summary,
    folderId: opts.folderId,
    contentCategory: opts.contentCategory,
    topic: opts.topic,
    contentScope: opts.contentScope,
    createdAt: now(),
    updatedAt: now(),
    lastOpenedAt: now(),
  };
  await repo.putNote(note);
  await emit({
    noteId: note.id,
    stage: "notes",
    status: "done",
    progress: 1,
    message: "Done",
  });

  // Persist chunks with the real note ID for future RAG queries.
  const persisted = chunks.length > 0
    ? chunks.map((c) => ({ ...c, noteId: note.id }))
    : [];
  if (persisted.length > 0) {
    try {
      await repo.putChunks(persisted);
    } catch {
      /* best-effort */
    }
  }

  // 6. Background study tools (practice questions + learning flashcards).
  if (opts.generateStudyTools !== false && !isBlank) {
    try {
      await emit({ stage: "flashcards", message: "Creating practice items…", progress: 1 });
      /* If adding additional material to an existing topic, fetch existing
         questions for dedup so the LLM avoids generating duplicates. */
      let existing: QuizQuestion[] = [];
      if (opts.contentScope === "additional" && opts.topic && opts.classId) {
        existing = await repo.questionsForClassAndTopic(opts.classId, opts.topic);
      }
      const { questions, flashcards } = await generatePracticeItems(engine, note, existing, persisted);
      await repo.putQuestions(questions);
      await repo.putFlashcards(flashcards);
    } catch (err) {
      console.error("generatePracticeItems failed:", err);
      await emit({
        stage: "flashcards",
        status: "done",
        progress: 1,
        message: "Study tools skipped — generation failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return note.id;
}

/* On relaunch, mark any jobs left "running" as errored so the UI doesn't show a
   phantom spinner. (Real resumption would re-enqueue; we surface the failure.) */
export async function reconcileJobs(repo: Repo): Promise<void> {
  const active = await repo.activeJobs();
  for (const j of active) {
    j.status = "error";
    j.message = "Interrupted — please retry.";
    j.updatedAt = now();
    await repo.putJob(j);
  }
}
