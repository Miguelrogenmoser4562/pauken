import { describe, expect, it } from "vitest";
import { Repo, COLLECTIONS } from "./index";
import { memoryStore } from "./memory";
import type { ChatTurn, Flashcard, Note, QuizAttempt, QuizQuestion } from "../types";

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: overrides.id ?? "note-1",
    title: "Photosynthesis",
    sourceKind: "text",
    sourceText: "Photosynthesis converts light energy into chemical energy.",
    blocks: [],
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    ...overrides,
  };
}

function makeCard(overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    id: overrides.id ?? "card-1",
    noteId: overrides.noteId ?? "note-1",
    front: "What is photosynthesis?",
    back: "The process by which plants convert light into chemical energy.",
    context: "Photosynthesis is how plants make food from sunlight.",
    topic: "biology",
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: overrides.id ?? "q-1",
    noteId: overrides.noteId ?? "note-1",
    type: "mcq",
    topic: "biology",
    difficulty: "basic",
    question: "What pigment absorbs light in photosynthesis?",
    options: ["Chlorophyll", "Melanin", "Keratin", "Hemoglobin"],
    correctIndex: 0,
    explanation: "Chlorophyll absorbs light for photosynthesis.",
    state: "new",
    due: 4_100_000_000_000,
    stability: 0,
    fsrsDifficulty: 5,
    reps: 0,
    lapses: 0,
    lastReview: undefined,
    firstExposedAt: undefined,
    generatedAt: Date.now(),
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return {
    id: overrides.id ?? "attempt-1",
    noteId: overrides.noteId ?? "note-1",
    questionId: overrides.questionId ?? "q-1",
    topic: "biology",
    correct: true,
    at: Date.now(),
    ...overrides,
  };
}

function makeChatTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: overrides.id ?? "chat-1",
    noteId: overrides.noteId ?? "note-1",
    role: "user",
    content: "Explain photosynthesis simply.",
    at: Date.now(),
    ...overrides,
  };
}

describe("Repo over memoryStore", () => {
  it("puts and gets a note", async () => {
    const repo = new Repo(memoryStore());
    const note = makeNote();

    const put = await repo.putNote(note);
    expect(put).toEqual(note);

    const fetched = await repo.getNote(note.id);
    expect(fetched).toEqual(note);
  });

  it("listNotes sorts by lastOpenedAt descending", async () => {
    const repo = new Repo(memoryStore());
    const oldest = makeNote({ id: "n-old", lastOpenedAt: 100 });
    const newest = makeNote({ id: "n-new", lastOpenedAt: 300 });
    const middle = makeNote({ id: "n-mid", lastOpenedAt: 200 });

    await repo.putNote(oldest);
    await repo.putNote(newest);
    await repo.putNote(middle);

    const notes = await repo.listNotes();
    expect(notes.map((n) => n.id)).toEqual(["n-new", "n-mid", "n-old"]);
  });

  it("putFlashcards + cardsForNote filters by noteId", async () => {
    const repo = new Repo(memoryStore());
    const cardA1 = makeCard({ id: "a-1", noteId: "note-a" });
    const cardA2 = makeCard({ id: "a-2", noteId: "note-a" });
    const cardB1 = makeCard({ id: "b-1", noteId: "note-b" });

    await repo.putFlashcards([cardA1, cardA2, cardB1]);

    const forA = await repo.cardsForNote("note-a");
    expect(forA.map((c) => c.id).sort()).toEqual(["a-1", "a-2"]);

    const forB = await repo.cardsForNote("note-b");
    expect(forB.map((c) => c.id)).toEqual(["b-1"]);
  });

  it("deleteNote cascades to flashcards, quiz, attempts, and chat for that note", async () => {
    const repo = new Repo(memoryStore());
    const targetId = "note-target";
    const otherId = "note-other";

    await repo.putNote(makeNote({ id: targetId }));
    await repo.putNote(makeNote({ id: otherId }));

    await repo.putFlashcards([
      makeCard({ id: "card-target", noteId: targetId }),
      makeCard({ id: "card-other", noteId: otherId }),
    ]);
    await repo.putQuestions([
      makeQuestion({ id: "q-target", noteId: targetId }),
      makeQuestion({ id: "q-other", noteId: otherId }),
    ]);
    await repo.putAttempt(makeAttempt({ id: "attempt-target", noteId: targetId }));
    await repo.putAttempt(makeAttempt({ id: "attempt-other", noteId: otherId }));
    await repo.putChat(makeChatTurn({ id: "chat-target", noteId: targetId }));
    await repo.putChat(makeChatTurn({ id: "chat-other", noteId: otherId }));

    await repo.deleteNote(targetId);

    expect(await repo.getNote(targetId)).toBeUndefined();
    expect(await repo.getNote(otherId)).toBeDefined();

    expect(await repo.cardsForNote(targetId)).toEqual([]);
    expect((await repo.cardsForNote(otherId)).map((c) => c.id)).toEqual(["card-other"]);

    expect(await repo.questionsFor(targetId)).toEqual([]);
    expect((await repo.questionsFor(otherId)).map((q) => q.id)).toEqual(["q-other"]);

    expect(await repo.attemptsFor(targetId)).toEqual([]);
    expect((await repo.attemptsFor(otherId)).map((a) => a.id)).toEqual([
      "attempt-other",
    ]);

    expect(await repo.chatFor(targetId)).toEqual([]);
    expect((await repo.chatFor(otherId)).map((t) => t.id)).toEqual(["chat-other"]);
  });

  it("where() performs a shallow equality match", async () => {
    const store = memoryStore();
    await store.put(COLLECTIONS.flashcards, makeCard({ id: "c-1", noteId: "n-1", topic: "biology" }));
    await store.put(COLLECTIONS.flashcards, makeCard({ id: "c-2", noteId: "n-1", topic: "chemistry" }));
    await store.put(COLLECTIONS.flashcards, makeCard({ id: "c-3", noteId: "n-2", topic: "biology" }));

    const byNote = await store.where<Flashcard>(COLLECTIONS.flashcards, { noteId: "n-1" });
    expect(byNote.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);

    const byTopic = await store.where<Flashcard>(COLLECTIONS.flashcards, { topic: "biology" });
    expect(byTopic.map((c) => c.id).sort()).toEqual(["c-1", "c-3"]);

    const byBoth = await store.where<Flashcard>(COLLECTIONS.flashcards, {
      noteId: "n-1",
      topic: "chemistry",
    });
    expect(byBoth.map((c) => c.id)).toEqual(["c-2"]);
  });

  it("clear() empties a collection", async () => {
    const store = memoryStore();
    await store.put(COLLECTIONS.notes, makeNote({ id: "n-1" }));
    await store.put(COLLECTIONS.notes, makeNote({ id: "n-2" }));

    expect(await store.all(COLLECTIONS.notes)).toHaveLength(2);

    await store.clear(COLLECTIONS.notes);

    expect(await store.all(COLLECTIONS.notes)).toEqual([]);
  });

  it("put/get deep-clone so callers cannot mutate stored state", async () => {
    const store = memoryStore();
    const note = makeNote({ id: "n-mut" });

    const putResult = await store.put(COLLECTIONS.notes, note);
    putResult.title = "mutated after put";
    note.title = "mutated original";

    const fetched = await store.get<Note>(COLLECTIONS.notes, "n-mut");
    expect(fetched?.title).toBe("Photosynthesis");
  });
});
