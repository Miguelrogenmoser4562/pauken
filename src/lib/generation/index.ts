/* Generation tasks. Each takes an Engine (cloud or local — identical interface)
   and returns domain objects. Persistence is the caller's job. */

import type { Engine, ChatMessage, TokenHandler } from "../engine/types";
import type { Block, ChatTurn, Flashcard, Note, QuizQuestion, QuizType, SourceChunk } from "../types";
import { uuid, now } from "../ids";
import { markdownToBlocks, plainText, stripFence } from "../markdown";
import { newQuestionState } from "../study/fsrs";
import { capTokens, chunkByTokens, estimateTokens } from "./chunk";
import {
  chatSystem,
  conceptsSchema,
  conceptsSystem,
  noteReduceSystem,
  noteSectionSystem,
  noteSystem,
  noteUser,
  perConceptSchema,
  perConceptSystem,
  quizSchema,
  quizSystem,
  titleSystem,
  titleUser,
} from "../prompts";
import { deduplicateTopics, normalizeTopic } from "../topics";
import { retrieveRelevantChunks, chunksToContext } from "./rag";

/* Token budgets. Sized so a single request stays well under a low 30k-TPM
   free-tier key even after the model's own output. The engine layer adds 429
   backoff on top, so bigger docs just take longer — they never hard-fail. */
const NOTE_CHUNK_TOKENS = 6000; // input per map request
const STUDY_TOKENS = 8000; // grounding cap for cards/quiz/chat

/* Density normalization bounds. */
const MIN_CARDS = 5;
const MAX_CARDS = 40;
const DENSITY_FACTOR = 2000; // ~1 card per 2000 chars of note

/* Study tools are generated from the *notes* (like Turbo), which are far smaller
   than a raw transcript; fall back to raw source only for a note with no body. */
export function studyContent(note: Note): string {
  const body = plainText(note.blocks);
  const base = body.trim() ? body : note.sourceText;
  return capTokens(base, STUDY_TOKENS);
}

/* The text used to ground generation: prefer the raw source; fall back to the
   note body (e.g. a blank note the user wrote by hand). */
export function contentFor(note: Note): string {
  return note.sourceText?.trim() ? note.sourceText : plainText(note.blocks);
}

function cleanTitle(raw: string): string {
  const line = raw.replace(/["""]/g, "").split("\n")[0].trim();
  const words = line.split(/\s+/).slice(0, 8).join(" ");
  return words.replace(/[.,:;]+$/, "") || "Untitled Document";
}

/* ---- Notes -------------------------------------------------------------- */

export async function generateNoteBody(
  engine: Engine,
  sourceText: string,
  language = "English",
  onToken?: TokenHandler,
  onChunk?: (current: number, total: number) => void,
): Promise<Block[]> {
  const chunks = chunkByTokens(sourceText, NOTE_CHUNK_TOKENS, 150);

  if (chunks.length <= 1) {
    const md = await engine.complete(
      {
        system: noteSystem(language),
        messages: [{ role: "user", content: noteUser(sourceText) }],
        tier: "strong",
        temperature: 0.4,
        maxTokens: 8000,
      },
      onToken,
    );
    return markdownToBlocks(stripFence(md));
  }

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onChunk?.(i + 1, chunks.length);
    const md = await engine.complete({
      system: noteSectionSystem(language, i + 1, chunks.length),
      messages: [{ role: "user", content: noteUser(chunks[i]) }],
      tier: "strong",
      temperature: 0.4,
      maxTokens: 4000,
    });
    parts.push(stripFence(md).trim());
    onToken?.(md);
  }

  let combined = parts.join("\n\n");
  if (estimateTokens(combined) <= NOTE_CHUNK_TOKENS) {
    try {
      combined = stripFence(
        await engine.complete({
          system: noteReduceSystem(language),
          messages: [{ role: "user", content: combined }],
          tier: "strong",
          temperature: 0.3,
          maxTokens: 6000,
        }),
      );
    } catch {
      /* keep the mapped section notes as-is */
    }
  }
  return markdownToBlocks(combined);
}

export async function generateTitle(
  engine: Engine,
  text: string,
): Promise<string> {
  const t = await engine.complete({
    system: titleSystem,
    messages: [{ role: "user", content: titleUser(text) }],
    tier: "fast",
    temperature: 0.3,
    maxTokens: 30,
  });
  return cleanTitle(t);
}

/* ---- Practice items + Flashcards (concept-aware pipeline) --------------- */

interface ExtractedConcept {
  id: string;
  title: string;
  detail: string;
  difficulty: number; // 1–10
}

interface GeneratedItem {
  conceptId: string;
  conceptTitle: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  front: string;
  back: string;
  context: string;
  sourcePassage?: string;
}

/* Density normalization: target card count proportional to note length. */
function normalizeCount(noteLength: number): number {
  const target = Math.round(noteLength / DENSITY_FACTOR);
  return Math.max(MIN_CARDS, Math.min(MAX_CARDS, target));
}

/* Step 1 — Concept extraction.
   Decompose notes into atomic, individually-testable concepts.
   When existingTopicNames are provided, the LLM avoids extracting concepts
   already covered by those topics (semantic dedup — catches similar phrasings). */
async function extractConcepts(
  engine: Engine,
  content: string,
  existingTopicNames?: string[],
): Promise<ExtractedConcept[]> {
  const targetCount = normalizeCount(content.length);
  let userContent = content;
  if (existingTopicNames && existingTopicNames.length > 0) {
    userContent +=
      `\n\nExisting topics already covered:\n` +
      existingTopicNames.map((t) => `- ${t}`).join("\n") +
      `\n\nDo NOT extract concepts that are already covered by these existing topics, even if they are phrased differently.`;
  }
  const { concepts } = await engine.structured<{
    concepts: { title: string; detail: string; difficulty: number }[];
  }>({
    system: conceptsSystem,
    messages: [{ role: "user", content: userContent }],
    schema: conceptsSchema as unknown as Record<string, unknown>,
    schemaName: "concepts",
    tier: "fast",
  });
  /* Select the top-N concepts, closest to target count. */
  const selected = concepts.slice(0, targetCount);
  return selected.map((c) => ({
    id: uuid(),
    title: c.title,
    detail: c.detail,
    difficulty: Math.max(1, Math.min(10, c.difficulty)),
  }));
}

/* Step 2+3 — Per-concept content generation with RAG.
   For each concept individually: retrieve relevant source passages, then
   generate MCQ + flashcard grounded in those passages. */
async function generatePerConcept(
  engine: Engine,
  concepts: ExtractedConcept[],
  noteContent: string,
  chunks: SourceChunk[],
  existingQuestions?: QuizQuestion[],
): Promise<GeneratedItem[]> {
  const existingTopics = new Set(existingQuestions?.map((q) => normalizeTopic(q.topic)) ?? []);
  const items: GeneratedItem[] = [];

  for (const concept of concepts) {
    if (existingTopics.has(normalizeTopic(concept.title))) continue;

    let context = noteContent;
    try {
      const queryEmbedding = await engine.embed([`${concept.title}: ${concept.detail}`]);
      if (queryEmbedding?.[0] && chunks.length > 0) {
        const relevant = retrieveRelevantChunks(chunks, queryEmbedding[0]);
        if (relevant.length > 0) {
          context = chunksToContext(relevant);
        }
      }
    } catch {
      /* embedding not available — fall back to full note content */
    }

    try {
      const { item } = await engine.structured<{
        item: {
          question: string;
          options: string[];
          correctIndex: number;
          explanation: string;
          flashcardFront: string;
          flashcardBack: string;
          flashcardContext: string;
          sourcePassage: string;
        };
      }>({
        system: perConceptSystem,
        messages: [
          {
            role: "user",
            content: [
              `Concept: ${concept.title}`,
              `Detail: ${concept.detail}`,
              `Difficulty: ${concept.difficulty}/10`,
              ``,
              `Relevant source passages:\n${context}`,
            ].join("\n"),
          },
        ],
        schema: perConceptSchema as unknown as Record<string, unknown>,
        schemaName: "practiceItem",
        tier: "strong",
      });

      items.push({
        conceptId: concept.id,
        conceptTitle: concept.title,
        question: item.question,
        options: item.options,
        correctIndex: item.correctIndex,
        explanation: item.explanation,
        front: item.flashcardFront,
        back: item.flashcardBack,
        context: item.flashcardContext,
        sourcePassage: item.sourcePassage,
      });
    } catch (e) {
      console.error(`Skipping concept "${concept.title}" — generation failed:`, e);
    }
  }

  return items;
}

/* Main generation entry point: extract concepts → per-concept RAG generation →
   seed FSRS state → return questions + flashcards.
   When `existingQuestions` is provided (e.g. adding material to an existing
   topic), concepts already covered by existing questions are skipped. */
export async function generatePracticeItems(
  engine: Engine,
  note: Note,
  existingQuestions?: QuizQuestion[],
  chunks?: SourceChunk[],
): Promise<{ questions: QuizQuestion[]; flashcards: Flashcard[] }> {
  const content = studyContent(note);
  const nowMs = now();

  const existingTopicNames = existingQuestions
    ? deduplicateTopics(existingQuestions.map((q) => q.topic))
    : undefined;
  const concepts = await extractConcepts(engine, content, existingTopicNames);
  const items = await generatePerConcept(engine, concepts, content, chunks ?? [], existingQuestions);

  const questions: QuizQuestion[] = items.map((item) => ({
    id: uuid(),
    noteId: note.id,
    conceptId: item.conceptId,
    type: "mcq" as QuizType,
    topic: item.conceptTitle,
    difficulty: "exam" as const,
    question: item.question,
    options: item.options,
    correctIndex: item.correctIndex,
    explanation: item.explanation,
    sourcePassage: item.sourcePassage,
    ...newQuestionState(nowMs),
  }));

  const flashcards: Flashcard[] = items.map((item) => ({
    id: uuid(),
    noteId: note.id,
    conceptId: item.conceptId,
    front: item.front,
    back: item.back,
    context: item.context,
    topic: item.conceptTitle,
    sourcePassage: item.sourcePassage,
  }));

  return { questions, flashcards };
}

/* ---- Quiz (legacy — kept for backward compat, delegates to new pipeline) */

export interface QuizOptions {
  count?: number;
  types?: QuizType[];
  category?: "knowledge" | "practice";
}

export async function generateQuiz(
  engine: Engine,
  note: Note,
  opts: QuizOptions = {},
): Promise<QuizQuestion[]> {
  const count = opts.count ?? 8;
  const types = opts.types ?? ["mcq", "true_false", "fill_blank"];
  const category = opts.category;
  const content = studyContent(note);
  const { questions } = await engine.structured<{
    questions: Omit<QuizQuestion, "id" | "noteId" | "difficulty" | "state" | "due" | "stability" | "fsrsDifficulty" | "reps" | "lapses" | "lastReview" | "firstExposedAt" | "generatedAt">[];
  }>({
    system: quizSystem({ count, types, category }),
    messages: [{ role: "user", content }],
    schema: quizSchema as unknown as Record<string, unknown>,
    schemaName: "quiz",
    tier: "strong",
  });
  const nowMs = now();
  return questions.map((q) => ({
    ...q,
    difficulty: "exam" as const,
    id: uuid(),
    noteId: note.id,
    ...newQuestionState(nowMs),
  }));
}

/* ---- Summary ------------------------------------------------------------ */

export async function generateSummary(engine: Engine, content: string): Promise<string> {
  const md = await engine.complete({
    system:
      "Summarize the source material in bullet points. Use at most 3 bullets. " +
      "Each bullet should capture one key concept. Format as a Markdown bullet list " +
      "(- point). Be concise — 1-2 sentences per bullet.",
    messages: [{ role: "user", content }],
    tier: "fast",
    temperature: 0.3,
    maxTokens: 1000,
  });
  return md.trim();
}

/* ---- Chat --------------------------------------------------------------- */

export async function chatAnswer(
  engine: Engine,
  note: Note,
  history: ChatTurn[],
  question: string,
  onToken?: TokenHandler,
): Promise<string> {
  const messages: ChatMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: question },
  ];
  return engine.complete(
    {
      system: chatSystem(note.title, studyContent(note)),
      messages,
      tier: "strong",
      temperature: 0.3,
    },
    onToken,
  );
}
