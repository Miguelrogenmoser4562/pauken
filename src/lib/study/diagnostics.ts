/* Weak-point diagnostics.
   Rolls up question performance by class / unit / lecture scope.
   Metrics:
   - Lapse ratio (lapses / reps) — high = chronic weakness
   - Maturity (reps >= 3 counts as "mature")
   - Overall retention estimate via retrievability
*/

import type { QuizQuestion } from "../types";

export interface ScopeDiagnostics {
  totalQuestions: number;
  matureQuestions: number; // reps >= 3
  totalLapses: number;
  totalReps: number;
  lapseRatio: number; // 0..1, higher = worse
  weakQuestions: QuizQuestion[]; // lapse ratio > 0.3 AND mature
}

/* Diagnostic rollup for any scope (class / unit / lecture). */
export function computeDiagnostics(questions: QuizQuestion[]): ScopeDiagnostics {
  const total = questions.length;
  const mature = questions.filter((q) => q.reps >= 3);
  const totalLapses = questions.reduce((s, q) => s + q.lapses, 0);
  const totalReps = questions.reduce((s, q) => s + q.reps, 0);
  const lapseRatio = totalReps > 0 ? totalLapses / totalReps : 0;

  const weakQuestions = mature.filter(
    (q) => q.reps > 0 && q.lapses / q.reps > 0.3,
  );

  return {
    totalQuestions: total,
    matureQuestions: mature.length,
    totalLapses,
    totalReps,
    lapseRatio,
    weakQuestions,
  };
}

/* Group diagnostics by topic within a set of questions. */
export function diagnosticsByTopic(
  questions: QuizQuestion[],
): Map<string, ScopeDiagnostics> {
  const byTopic = new Map<string, QuizQuestion[]>();
  for (const q of questions) {
    const group = byTopic.get(q.topic) ?? [];
    group.push(q);
    byTopic.set(q.topic, group);
  }
  const result = new Map<string, ScopeDiagnostics>();
  for (const [topic, qs] of byTopic) {
    result.set(topic, computeDiagnostics(qs));
  }
  return result;
}
