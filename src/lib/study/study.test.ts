import { describe, expect, it } from "vitest";
import type { QuizAttempt, QuizQuestion } from "../types";
import {
  bucketOf,
  newQuestionState,
  reviewQuestion,
  dueQuestions,
  backlogQuestions,
  studyOrderQuestions,
} from "./fsrs";
import { masteryByTopic, masteryColor } from "./mastery";
import { buildCoStudySession, mergeUserProgress } from "./session";
import type { StudyDefaults } from "../types";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const FAR_FUTURE = 4_100_000_000_000;

const DEFAULTS: StudyDefaults = {
  retentionTarget: 0.9,
  maxReviewsPerItemPerWeek: 3,
  maxNewCardsPerSession: 5,
};

function makeQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: overrides.id ?? "q-1",
    noteId: "note-1",
    type: "mcq",
    topic: "biology",
    difficulty: "basic",
    question: "What pigment absorbs light in photosynthesis?",
    options: ["Chlorophyll", "Melanin", "Keratin", "Hemoglobin"],
    correctIndex: 0,
    explanation: "Chlorophyll absorbs light for photosynthesis.",
    state: "new",
    due: FAR_FUTURE,
    stability: 0,
    fsrsDifficulty: 5,
    reps: 0,
    lapses: 0,
    lastReview: undefined,
    firstExposedAt: undefined,
    generatedAt: NOW,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return {
    id: overrides.id ?? "attempt-1",
    noteId: "note-1",
    questionId: "q-1",
    topic: "biology",
    correct: true,
    at: NOW,
    ...overrides,
  };
}

describe("newQuestionState", () => {
  it("produces a fresh 'new' question in the backlog (due = sentinel)", () => {
    const state = newQuestionState(NOW);
    expect(state.state).toBe("new");
    expect(state.reps).toBe(0);
    expect(state.lapses).toBe(0);
    expect(state.stability).toBe(0);
    expect(state.due).toBe(FAR_FUTURE);
    expect(state.generatedAt).toBe(NOW);
  });
});

describe("reviewQuestion", () => {
  it("'good' on a backlog NEW card promotes to learning and sets a near due", () => {
    const q = makeQuestion();
    const reviewed = reviewQuestion(q, "good", NOW);

    expect(reviewed.reps).toBe(1);
    expect(reviewed.state).toBe("learning");
    expect(reviewed.due).toBeGreaterThan(NOW);
    expect(reviewed.lastReview).toBe(NOW);
    expect(reviewed.stability).toBeGreaterThan(0);
    expect(reviewed.firstExposedAt).toBe(NOW);
  });

  it("does not mutate the input question", () => {
    const q = makeQuestion();
    const snapshot = { ...q };
    reviewQuestion(q, "good", NOW);
    expect(q).toEqual(snapshot);
  });

  it("'again' on a NEW card keeps it in learning with a shorter interval than 'good'", () => {
    const q = makeQuestion();
    const good = reviewQuestion(q, "good", NOW);
    const again = reviewQuestion(q, "again", NOW);

    /* ts-fsrs does not increment lapses on NEW/LEARNING cards — only REVIEW. */
    expect(again.lapses).toBe(0);
    expect(again.state).toBe("learning");
    expect(again.due).toBeGreaterThan(NOW);
    expect(again.due - NOW).toBeLessThan(good.due - NOW);
    expect(again.stability).toBeGreaterThan(0);
  });

  it("moves a new question through learning into review on successive goods", () => {
    const q = makeQuestion();
    const afterGood = reviewQuestion(q, "good", NOW);
    expect(afterGood.state).toBe("learning");

    const afterSecond = reviewQuestion(afterGood, "good", NOW + DAY);
    expect(afterSecond.state).toBe("review");
    expect(afterSecond.reps).toBe(2);
  });

  it("lapsing a review question sends it to 'relearning'", () => {
    const reviewQ = makeQuestion({
      state: "review",
      due: NOW,
      stability: 30,
      reps: 5,
    });
    const lapsed = reviewQuestion(reviewQ, "again", NOW);
    expect(lapsed.state).toBe("relearning");
  });

  it("keeps difficulty clamped within ts-fsrs bounds through repeated agains", () => {
    let q = makeQuestion({ fsrsDifficulty: 5 });
    for (let i = 0; i < 5; i++) {
      q = reviewQuestion(q, "again", NOW + i * DAY);
    }
    expect(q.fsrsDifficulty).toBeGreaterThan(0);
    expect(q.fsrsDifficulty).toBeLessThanOrEqual(10);
  });

  it("firstExposedAt is set on first review and preserved thereafter", () => {
    const q = makeQuestion();
    const r1 = reviewQuestion(q, "good", NOW);
    expect(r1.firstExposedAt).toBe(NOW);

    const r2 = reviewQuestion(r1, "good", NOW + DAY);
    expect(r2.firstExposedAt).toBe(NOW);
  });
});

describe("bucketOf", () => {
  it("classifies a backlog question as 'new'", () => {
    expect(bucketOf(makeQuestion())).toBe("new");
  });

  it("classifies a learning question as 'learning'", () => {
    expect(bucketOf(makeQuestion({ state: "learning", reps: 1, stability: 2 }))).toBe("learning");
  });

  it("classifies a review question as 'review'", () => {
    expect(bucketOf(makeQuestion({ state: "review", reps: 3, stability: 10 }))).toBe("review");
  });

  it("classifies a relearning question as 'review'", () => {
    expect(bucketOf(makeQuestion({ state: "relearning", reps: 4, stability: 2 }))).toBe("review");
  });
});

describe("due / backlog queries", () => {
  it("dueQuestions returns only questions past their due date (excluding NEW)", () => {
    const soon = makeQuestion({ id: "soon", state: "review", due: NOW - 1000 });
    const now = makeQuestion({ id: "now", state: "relearning", due: NOW });
    const future = makeQuestion({ id: "future", state: "review", due: NOW + DAY });
    const backlogged = makeQuestion({ id: "backlog", state: "new", due: FAR_FUTURE });
    const result = dueQuestions([future, now, soon, backlogged], NOW);
    expect(result.map((q) => q.id)).toEqual(["soon", "now"]);
  });

  it("backlogQuestions returns only NEW questions, sorted by generatedAt", () => {
    const older = makeQuestion({ id: "older", state: "new", generatedAt: NOW });
    const newer = makeQuestion({ id: "newer", state: "new", generatedAt: NOW + 100 });
    const review = makeQuestion({ id: "review", state: "review", due: NOW });
    const result = backlogQuestions([review, newer, older]);
    expect(result.map((q) => q.id)).toEqual(["older", "newer"]);
  });

  it("studyOrderQuestions prioritizes learning/relearning, then review, then not-due", () => {
    const dueReview = makeQuestion({ id: "due-review", state: "review", due: NOW - 10, stability: 30, reps: 5 });
    const dueLearning = makeQuestion({ id: "due-learning", state: "learning", due: NOW - 5, reps: 1 });
    const notDue = makeQuestion({ id: "not-due", state: "review", due: NOW + DAY, reps: 2 });

    const order = studyOrderQuestions([dueReview, dueLearning, notDue], NOW);
    expect(order.map((q) => q.id)).toEqual([
      "due-learning",
      "due-review",
      "not-due",
    ]);
  });
});

describe("masteryByTopic", () => {
  it("rolls up correct/total/pct per topic present in questions", () => {
    const questions = [
      makeQuestion({ id: "q-bio-1", topic: "biology" }),
      makeQuestion({ id: "q-bio-2", topic: "biology" }),
      makeQuestion({ id: "q-chem-1", topic: "chemistry" }),
    ];
    const attempts = [
      makeAttempt({ id: "a1", questionId: "q-bio-1", topic: "biology", correct: true }),
      makeAttempt({ id: "a2", questionId: "q-bio-2", topic: "biology", correct: false }),
      makeAttempt({ id: "a3", questionId: "q-bio-1", topic: "biology", correct: true }),
    ];

    const result = masteryByTopic(questions, attempts);

    expect(result).toEqual([
      { topic: "biology", correct: 2, total: 3, pct: 67 },
      { topic: "chemistry", correct: 0, total: 0, pct: 0 },
    ]);
  });

  it("sorts topics by name and ignores attempts for topics not in questions", () => {
    const questions = [
      makeQuestion({ id: "q1", topic: "zoology" }),
      makeQuestion({ id: "q2", topic: "algebra" }),
    ];
    const attempts = [
      makeAttempt({ id: "a1", topic: "algebra", correct: true }),
      makeAttempt({ id: "a2", topic: "unrelated-topic", correct: true }),
    ];

    const result = masteryByTopic(questions, attempts);
    expect(result.map((r) => r.topic)).toEqual(["algebra", "zoology"]);
    expect(result.find((r) => r.topic === "algebra")).toEqual({
      topic: "algebra",
      correct: 1,
      total: 1,
      pct: 100,
    });
  });
});

describe("masteryColor", () => {
  it("is red below 50", () => {
    expect(masteryColor(0)).toBe("red");
    expect(masteryColor(49)).toBe("red");
  });

  it("is amber from 50 up to (not including) 80", () => {
    expect(masteryColor(50)).toBe("amber");
    expect(masteryColor(79)).toBe("amber");
  });

  it("is green at 80 and above", () => {
    expect(masteryColor(80)).toBe("green");
    expect(masteryColor(100)).toBe("green");
  });
});

describe("buildCoStudySession defensive guards", () => {
  it("treats undefined progress/review logs as empty (old-server payloads)", () => {
    const questions = [
      makeQuestion({ id: "q-1", state: "review", due: NOW - DAY }),
      makeQuestion({ id: "q-2" }),
    ];
    const empty = buildCoStudySession(questions, DEFAULTS, [], [], [], []);
    const undefinedArgs = buildCoStudySession(
      questions,
      DEFAULTS,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(() => buildCoStudySession(questions, DEFAULTS, undefined as never)).not.toThrow();
    expect(undefinedArgs.total).toBe(empty.total);
    expect(undefinedArgs.due.map((q) => q.id)).toEqual(empty.due.map((q) => q.id));
  });

  it("mergeUserProgress ignores undefined progress", () => {
    const questions = [makeQuestion({ id: "q-1" })];
    expect(mergeUserProgress(questions, undefined as never)).toEqual(questions);
  });
});
