/* Session composition system.
   Takes the full question pool and constructs a study session:
   1. Due queue (REVIEW + RELEARNING questions whose `due` ≤ now)
   2. Backlog pacing (pull N NEW questions per session)
   3. Weekly per-item review cap (accurate via review log)
   4. Early-review fallback (if nothing is due, pull near-due questions)
   5. Co-study mode merges both users' review logs for unified session building
*/

import type { QuizQuestion, ReviewLog, StudyDefaults, UserProgress } from "../types";
import { dueQuestions, backlogQuestions } from "./fsrs";

const MS_PER_DAY = 86_400_000;
const EARLY_REVIEW_THRESHOLD_DAYS = 3; // pull cards due within this many days

export interface Session {
  due: QuizQuestion[];
  newItems: QuizQuestion[];
  total: number;
}

/* Compute how many reviews each question already had this week
   using the append-only review log. */
function weeklyReviewCount(
  questionId: string,
  reviewLogs: ReviewLog[],
  nowMs: number,
): number {
  const weekAgo = nowMs - 7 * MS_PER_DAY;
  return reviewLogs.filter(
    (r) => r.questionId === questionId && r.at >= weekAgo,
  ).length;
}

/* Overlay per-user FSRS state onto shared quiz questions.
   Questions with UserProgress use per-user fields; questions without
   keep their default FSRS state from generation. */
export function mergeUserProgress(
  questions: QuizQuestion[],
  progress: UserProgress[],
): QuizQuestion[] {
  const progMap = new Map(progress.map((p) => [p.questionId, p]));
  return questions.map((q) => {
    const p = progMap.get(q.id);
    if (!p) return q;
    return {
      ...q,
      state: p.state,
      due: p.due,
      stability: p.stability,
      fsrsDifficulty: p.fsrsDifficulty,
      reps: p.reps,
      lapses: p.lapses,
      lastReview: p.lastReview,
      firstExposedAt: p.firstExposedAt,
    };
  });
}

export function buildSession(
  allQuestions: QuizQuestion[],
  defaults: StudyDefaults,
  nowMs: number = Date.now(),
  _examDate?: number,
  reviewLogs: ReviewLog[] = [],
): Session {
  const due = dueQuestions(allQuestions, nowMs);

  /* Apply weekly per-item cap using review log. */
  const cappedDue = due.filter((q) => {
    if (q.state === "relearning") return true;
    const weekly = weeklyReviewCount(q.id, reviewLogs, nowMs);
    return weekly < defaults.maxReviewsPerItemPerWeek;
  });

  /* Backlog: pull NEW questions up to the session cap. */
  const backlog = backlogQuestions(allQuestions);
  const newItems = backlog.slice(0, defaults.maxNewCardsPerSession);

  /* Early-review fallback: if nothing is due, pull near-due REVIEW questions. */
  let earlyReview: QuizQuestion[] = [];
  if (cappedDue.length === 0 && newItems.length === 0) {
    const threshold = nowMs + EARLY_REVIEW_THRESHOLD_DAYS * MS_PER_DAY;
    earlyReview = allQuestions.filter(
      (q) =>
        (q.state === "review" || q.state === "relearning") &&
        q.due > nowMs &&
        q.due <= threshold,
    );
  }

  const sessionItems = [...cappedDue, ...earlyReview, ...newItems];
  return {
    due: cappedDue,
    newItems,
    total: sessionItems.length,
  };
}

/* Build a merged study session for co-study (both modes).
   Each user's progress is merged independently, then due questions are
   averaged by rank across both users. Intersection (due for both) floats
   to the top naturally via lower average rank.
   Returns the session queue; callers must track per-user rating separately. */
export function buildCoStudySession(
  allQuestions: QuizQuestion[],
  defaults: StudyDefaults,
  userProgress: UserProgress[],
  partnerProgress: UserProgress[],
  userReviewLogs: ReviewLog[],
  partnerReviewLogs: ReviewLog[],
  nowMs: number = Date.now(),
): Session {
  const userMerged = mergeUserProgress(allQuestions, userProgress);
  const partnerMerged = mergeUserProgress(allQuestions, partnerProgress);

  const userDueIds = new Set(dueQuestions(userMerged, nowMs).map((q) => q.id));
  const partnerDueIds = new Set(dueQuestions(partnerMerged, nowMs).map((q) => q.id));
  const unionDueIds = new Set([...userDueIds, ...partnerDueIds]);

  /* Build ranking per user: sort by due ascending, lower rank = more urgent. */
  const userSorted = [...userMerged].sort((a, b) => a.due - b.due);
  const partnerSorted = [...partnerMerged].sort((a, b) => a.due - b.due);
  const userRank = new Map(userSorted.map((q, i) => [q.id, i + 1]));
  const partnerRank = new Map(partnerSorted.map((q, i) => [q.id, i + 1]));
  /* Use a large sentinel for questions not in a user's due set (e.g. NEW). */
  const SENTINEL = allQuestions.length + 1;

  const unionDue = allQuestions
    .filter((q) => unionDueIds.has(q.id))
    .sort((a, b) => {
      const aAvg = ((userRank.get(a.id) ?? SENTINEL) + (partnerRank.get(a.id) ?? SENTINEL)) / 2;
      const bAvg = ((userRank.get(b.id) ?? SENTINEL) + (partnerRank.get(b.id) ?? SENTINEL)) / 2;
      if (aAvg !== bAvg) return aAvg - bAvg;
      return a.due - b.due;
    });

  /* Apply weekly per-item cap using merged review logs. */
  const mergedLogs = [...userReviewLogs, ...partnerReviewLogs];
  const cappedDue = unionDue.filter((q) => {
    if (q.state === "relearning") return true;
    const weekly = mergedLogs.filter(
      (r) => r.questionId === q.id && r.at >= nowMs - 7 * MS_PER_DAY,
    ).length;
    return weekly < defaults.maxReviewsPerItemPerWeek;
  });

  const backlog = backlogQuestions(allQuestions);
  const newItems = backlog.slice(0, defaults.maxNewCardsPerSession);

  let earlyReview: QuizQuestion[] = [];
  if (cappedDue.length === 0 && newItems.length === 0) {
    const threshold = nowMs + EARLY_REVIEW_THRESHOLD_DAYS * MS_PER_DAY;
    earlyReview = allQuestions.filter(
      (q) =>
        (q.state === "review" || q.state === "relearning") &&
        q.due > nowMs &&
        q.due <= threshold,
    );
  }

  const sessionItems = [...cappedDue, ...earlyReview, ...newItems];
  return {
    due: cappedDue,
    newItems,
    total: sessionItems.length,
  };
}
