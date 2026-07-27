/* FSRS-based spaced repetition scheduler.
   Wraps ts-fsrs with Pauken-specific conventions:
   - NEW backlog: generated cards sit in NEW with a far-future `due` until
     the session system introduces them.
   - Exam-date ceiling: intervals are capped when an exam date is set.
   - Cold-start override: first REVIEW interval is ~15–20% of days until exam.
*/

import { createEmptyCard, FSRS, generatorParameters, Rating } from "ts-fsrs";
import type { Grade } from "ts-fsrs";
import type { PracticeState, QuizQuestion } from "../types";

/* Far-future sentinel used for backlogged NEW cards. */
const FAR_FUTURE_SENTINEL = 4_100_000_000_000; // ~2099
const MS_PER_DAY = 86_400_000;
const EXAM_BUFFER_DAYS = 3;

/* Shared FSRS instance (stateless — safe to reuse). */
const params = generatorParameters({ enable_fuzz: false });
const fsrs = new FSRS(params);

/* Convert ts-fsrs state enum to Pauken's string union. */
function fromFsrsState(s: number): PracticeState {
  switch (s) {
    case 0: return "new";
    case 1: return "learning";
    case 2: return "review";
    case 3: return "relearning";
    default: return "new";
  }
}

/* Convert Pauken state to ts-fsrs Grade (non-Manual Rating). */
function toFsrsRating(rating: "again" | "hard" | "good" | "easy"): Grade {
  switch (rating) {
    case "again": return Rating.Again;
    case "hard": return Rating.Hard;
    case "good": return Rating.Good;
    case "easy": return Rating.Easy;
  }
}

/* Cold-start first interval: 15–20% of days until exam date. */
function coldStartInterval(examDate: number, today: number): number {
  const remainingDays = Math.max(1, (examDate - today) / MS_PER_DAY);
  return Math.max(1, Math.round(0.175 * remainingDays));
}

/* Exam-date ceiling: cap interval so review falls before exam minus buffer. */
function applyExamCeiling(
  intervalDays: number,
  examDate: number | undefined,
  today: number,
): number {
  if (!examDate) return intervalDays;
  const maxInterval = Math.max(1, (examDate - today) / MS_PER_DAY - EXAM_BUFFER_DAYS);
  return Math.min(intervalDays, Math.max(1, maxInterval));
}

export type Rating_ = "again" | "hard" | "good" | "easy";

/* Create a brand-new question in NEW backlog state (not immediately due). */
export function newQuestionState(
  nowMs: number = Date.now(),
): Pick<
  QuizQuestion,
  "state" | "due" | "stability" | "fsrsDifficulty" | "reps" | "lapses" | "lastReview" | "generatedAt" | "firstExposedAt"
> {
  return {
    state: "new" as PracticeState,
    due: FAR_FUTURE_SENTINEL,
    stability: 0,
    fsrsDifficulty: 5,
    reps: 0,
    lapses: 0,
    lastReview: undefined,
    generatedAt: nowMs,
    firstExposedAt: undefined,
  };
}

/* Apply one review rating to a question and return updated scheduling fields.
   Handles exam-date ceiling and cold-start override. */
export function reviewQuestion(
  question: QuizQuestion,
  rating: Rating_,
  nowMs: number = Date.now(),
  examDate?: number,
): QuizQuestion {
  const now = new Date(nowMs);

  /* Build a ts-fsrs card from current question state.
     NEW cards keep the empty-card defaults (stability=0, difficulty=0) —
     ts-fsrs rejects non-zero difficulty with zero stability as invalid. */
  const card = createEmptyCard(now);

  if (question.state !== "new") {
    card.stability = question.stability;
    card.difficulty = question.fsrsDifficulty;
    card.reps = question.reps;
    card.lapses = question.lapses;
    card.state = toFsrsState(question.state);
    card.last_review = question.lastReview
      ? new Date(question.lastReview)
      : new Date(question.due);
    /* Restore learning step progress for cards still in LEARNING state. */
    if (question.state === "learning") {
      card.learning_steps = question.reps > 0 ? 1 : 0;
    }
  } else {
    /* NEW backlog state: promote to Learning first so ts-fsrs can compute
       sensible intervals. Card stays at empty defaults (stable=0, diff=0). */
    card.state = 1; // Learning
    card.due = new Date(nowMs);
    card.last_review = new Date(nowMs);
  }

  const result = fsrs.next(card, now, toFsrsRating(rating));

  const state = fromFsrsState(result.card.state);

  /* Compute difficulty: if the question had a seeded difficulty (from NEW),
     blend it with the ts-fsrs computed difficulty for a smoother transition.
     Otherwise use ts-fsrs result directly. */
  const computedDiff = result.card.difficulty;
  const fsrsDifficulty =
    question.state === "new" && question.fsrsDifficulty > 0
      ? (question.fsrsDifficulty + computedDiff) / 2
      : computedDiff;

  /* Determine due date.
     For learning/relearning steps, ts-fsrs sets `due` to (now + step).
     For review intervals, use scheduled_days and apply overrides. */
  let due: number;
  if (state === "learning" || state === "relearning") {
    /* Use ts-fsrs' computed due directly (includes learning step timing). */
    due = result.card.due.getTime();
  } else {
    /* REVIEW state: apply cold-start and exam-date overrides. */
    let intervalDays = result.card.scheduled_days;

    /* Cold-start override: first graduation to REVIEW. */
    if (
      question.state === "learning" &&
      question.reps === 0 &&
      examDate
    ) {
      intervalDays = coldStartInterval(examDate, nowMs);
    }

    /* Exam-date ceiling. */
    intervalDays = applyExamCeiling(intervalDays, examDate, nowMs);

    due = nowMs + intervalDays * MS_PER_DAY;
  }

  return {
    ...question,
    due,
    stability: result.card.stability,
    fsrsDifficulty,
    reps: result.card.reps,
    lapses: result.card.lapses,
    lastReview: nowMs,
    state,
    firstExposedAt: question.firstExposedAt ?? nowMs,
  };
}

/* ---- Convenience wrappers ----------------------------------------------- */

/* Map ts-fsrs state number to Pauken state. */
export function toFsrsState(s: PracticeState): 0 | 1 | 2 | 3 {
  switch (s) {
    case "new": return 0;
    case "learning": return 1;
    case "review": return 2;
    case "relearning": return 3;
  }
}

/* Questions whose `due` has arrived, sorted soonest-first. */
export function dueQuestions(
  questions: QuizQuestion[],
  nowMs: number = Date.now(),
): QuizQuestion[] {
  return questions
    .filter((q) => q.state !== "new" && q.due <= nowMs)
    .slice()
    .sort((a, b) => a.due - b.due);
}

/* Questions in the NEW backlog, ordered oldest-generated first. */
export function backlogQuestions(
  questions: QuizQuestion[],
): QuizQuestion[] {
  return questions
    .filter((q) => q.state === "new")
    .slice()
    .sort((a, b) => a.generatedAt - b.generatedAt);
}

/* Session priority: learning/relearning first, then review (ties by due). */
export function studyOrderQuestions(
  questions: QuizQuestion[],
  nowMs: number = Date.now(),
): QuizQuestion[] {
  const due = dueQuestions(questions, nowMs).sort((a, b) => {
    const aPriority = a.state === "review" ? 1 : 0;
    const bPriority = b.state === "review" ? 1 : 0;
    return aPriority !== bPriority ? aPriority - bPriority : a.due - b.due;
  });
  const notDue = questions
    .filter((q) => q.state !== "new" && q.due > nowMs)
    .slice()
    .sort((a, b) => a.due - b.due);
  return [...due, ...notDue];
}

/* ---- Diagnostics helper ------------------------------------------------- */

/* Coarse progress bucket for a question. */
export function bucketOf(
  question: QuizQuestion,
): "new" | "learning" | "review" {
  if (question.state === "new") return "new";
  if (question.state === "review" || question.state === "relearning") return "review";
  return "learning";
}

export type { Rating } from "ts-fsrs";
