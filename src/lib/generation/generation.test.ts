import { describe, expect, it } from "vitest";
import type {
  Engine,
  EngineCapabilities,
  CompletionOptions,
  StructuredOptions,
  TokenHandler,
} from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Note } from "../types";
import { uuid, now } from "../ids";
import {
  generatePracticeItems,
  generateQuiz,
  generateNoteBody,
  generateTitle,
} from "./index";
import { createNoteFromSources } from "./pipeline";

let practiceItemIndex = 0;

/* A deterministic in-memory engine: no network. Returns canned output keyed by
   the structured schemaName, and a fixed markdown doc for completions. */
class FakeEngine implements Engine {
  readonly mode = "cloud" as const;
  calls: string[] = [];
  completeCalls = 0;
  capabilities(): EngineCapabilities {
    return { chat: true, embeddings: true };
  }
  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    this.completeCalls++;
    if ((opts.maxTokens ?? 999) <= 40) {
      onToken?.("Photosynthesis Basics");
      return "Photosynthesis Basics";
    }
    const md = "# Overview\n\nPlants make food.\n\n## Key Takeaways\n\n- Light matters";
    for (const ch of md) onToken?.(ch);
    return md;
  }
  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    this.calls.push(opts.schemaName);
    const items = [
      {
        question: "What molecule absorbs light?",
        options: ["Chlorophyll", "Melanin", "Keratin", "Hemoglobin"],
        correctIndex: 0,
        explanation: "Chlorophyll is the primary pigment.",
        flashcardFront: "What drives photosynthesis?",
        flashcardBack: "Light",
        flashcardContext: "Light energy is captured by chlorophyll pigments.",
        sourcePassage: "Chlorophyll is the primary pigment in plants.",
      },
      {
        question: "What is water's role?",
        options: ["Electron donor", "Energy source", "Waste product", "Catalyst"],
        correctIndex: 0,
        explanation: "Water provides electrons for the light reactions.",
        flashcardFront: "What is a reactant?",
        flashcardBack: "Water",
        flashcardContext: "Water is split to provide electrons.",
        sourcePassage: "Water acts as an electron donor in photosynthesis.",
      },
    ];
    const byName: Record<string, unknown> = {
      concepts: {
        concepts: [
          { title: "Light Absorption", detail: "How plants capture light energy", difficulty: 3 },
          { title: "Water Role", detail: "Water as electron donor", difficulty: 4 },
        ],
      },
      practiceItem: { item: items[practiceItemIndex++ % items.length] },
      quiz: {
        questions: [
          {
            type: "mcq",
            topic: "Light",
            question: "Main energy source?",
            options: ["Light", "Sound", "Heat", "Cold"],
            correctIndex: 0,
            explanation: "Light powers it.",
          },
        ],
      },
    };
    return byName[opts.schemaName] as T;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
  async validate(): Promise<void> {}
}

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: uuid(),
    title: "T",
    sourceKind: "text",
    sourceText: "Plants convert light and water into energy.",
    blocks: [],
    createdAt: now(),
    updatedAt: now(),
    lastOpenedAt: now(),
    ...over,
  };
}

describe("generation tasks", () => {
  it("generateNoteBody parses streamed markdown into blocks", async () => {
    const engine = new FakeEngine();
    let streamed = "";
    const blocks = await generateNoteBody(engine, "src", "English", (d) => (streamed += d));
    expect(streamed.length).toBeGreaterThan(0);
    expect(blocks[0].type).toBe("heading1");
    expect(blocks.some((b) => b.type === "bullet")).toBe(true);
  });

  it("map-reduces a large document with multiple model calls", async () => {
    const engine = new FakeEngine();
    const big = "Photosynthesis is the core process of plants. ".repeat(1400);
    const blocks = await generateNoteBody(engine, big, "English");
    expect(engine.completeCalls).toBeGreaterThan(1);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("generateTitle trims to a clean title", async () => {
    const engine = new FakeEngine();
    expect(await generateTitle(engine, "text")).toBe("Photosynthesis Basics");
  });

  it("generatePracticeItems runs concept extraction + per-concept RAG generation and seeds FSRS state", async () => {
    const engine = new FakeEngine();
    practiceItemIndex = 0;
    const { questions, flashcards } = await generatePracticeItems(engine, makeNote());
    expect(engine.calls).toEqual(["concepts", "practiceItem", "practiceItem"]);
    expect(questions).toHaveLength(2);
    expect(questions[0].state).toBe("new");
    expect(questions[0].noteId).toBeTruthy();
    expect(questions[0].sourcePassage).toBeTruthy();
    expect(flashcards).toHaveLength(2);
    expect(flashcards[0].conceptId).toBeTruthy();
    expect(flashcards[0].context).toBeTruthy();
    expect(flashcards[0].sourcePassage).toBeTruthy();
  });

  it("generateQuiz attaches ids and noteId", async () => {
    const engine = new FakeEngine();
    const note = makeNote();
    const qs = await generateQuiz(engine, note, { count: 1 });
    expect(qs[0].noteId).toBe(note.id);
    expect(qs[0].correctIndex).toBe(0);
  });
});

describe("createNoteFromSources pipeline", () => {
  it("creates a note with blocks + title from a text source", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "text", text: "some lecture text" }],
    });
    const note = await repo.getNote(id);
    expect(note).toBeTruthy();
    expect(note!.title).toBe("Photosynthesis Basics");
    expect(note!.blocks.length).toBeGreaterThan(0);
  });

  it("records per-file status and still succeeds when one source fails", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const jobs: string[][] = [];
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [
        { kind: "text", text: "good source" },
        { kind: "url", url: "https://example.com" },
      ],
      onProgress: (j) => jobs.push((j.files ?? []).map((f) => f.status)),
    });
    const note = await repo.getNote(id);
    expect(note).toBeTruthy();
    const finalStatuses = jobs.at(-1)!;
    expect(finalStatuses).toContain("done");
    expect(finalStatuses).toContain("error");
  });

  it("blank source produces an empty untitled note", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "blank" }],
    });
    const note = await repo.getNote(id);
    expect(note!.title).toBe("Untitled Document");
    expect(note!.blocks).toHaveLength(0);
  });
});
