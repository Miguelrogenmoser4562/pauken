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
import { uuid, now } from "../ids";
import {
  applySyllabus,
  buildSyllabus,
  isoToEpoch,
  parseSyllabus,
  toEvents,
  type ParsedSyllabus,
} from "./syllabus";
import { syllabusSchema } from "../prompts";

/* A deterministic in-memory engine: returns canned syllabus JSON. */
class FakeEngine implements Engine {
  readonly mode = "cloud" as const;
  calls: string[] = [];
  capabilities(): EngineCapabilities {
    return { chat: true, embeddings: true };
  }
  async complete(_opts: CompletionOptions, _onToken?: TokenHandler): Promise<string> {
    return "";
  }
  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    this.calls.push(opts.schemaName);
    return {
      courseTitle: "Calculus III",
      courseCode: "MATH 2650",
      term: "Fall 2026",
      institution: "Iowa State University",
      instructors: [
        { name: "Dr. Mitch Haeuser", email: "mhaeuser@iastate.edu", office: "" },
      ],
      teachingAssistants: [
        { name: "Owen Henderschedt", email: "owenhen@iastate.edu", office: "" },
      ],
      officeHours: "1-5pm MWF drop-in",
      grading: [{ category: "Homework", weightPct: 15, notes: "" }],
      gradeScale: [{ minPct: 93, letter: "A" }],
      topics: [
        { unit: "Geometry of Space; Vectors", items: ["Dot and cross products"] },
        { unit: "Multivariable Differentiation", items: ["Gradient"] },
      ],
      policies: ["No late work without prior arrangements"],
      assessments: [
        {
          kind: "exam",
          title: "Exam 1",
          dateStart: "2026-09-24",
          dateEnd: "",
          time: "18:45",
          location: "",
        },
        {
          kind: "quiz",
          title: "Quiz 1",
          dateStart: "2026-09-01",
          dateEnd: "",
          time: "",
          location: "",
        },
        {
          kind: "final",
          title: "Final Exam",
          dateStart: "2026-12-14",
          dateEnd: "2026-12-18",
          time: "",
          location: "",
        },
        {
          kind: "homework",
          title: "Homework 1A",
          dateStart: "2026-08-24",
          dateEnd: "",
          time: "",
          location: "",
        },
        {
          kind: "break",
          title: "Spring Break",
          dateStart: "2026-11-23",
          dateEnd: "2026-11-27",
          time: "",
          location: "",
        },
        {
          kind: "exam",
          title: "Exam 2",
          dateStart: "",
          dateEnd: "",
          time: "",
          location: "",
        },
      ],
    } as T;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1]);
  }
  async validate(): Promise<void> {}
}

const PARSED: ParsedSyllabus = {
  courseTitle: "Calculus III",
  courseCode: "MATH 2650",
  term: "Fall 2026",
  institution: "Iowa State University",
  instructors: [
    { name: "Dr. Mitch Haeuser", email: "mhaeuser@iastate.edu", office: "" },
  ],
  teachingAssistants: [
    { name: "Owen Henderschedt", email: "owenhen@iastate.edu", office: "" },
  ],
  officeHours: "1-5pm MWF drop-in",
  grading: [{ category: "Homework", weightPct: 15, notes: "" }],
  gradeScale: [{ minPct: 93, letter: "A" }],
  topics: [
    { unit: "Geometry of Space; Vectors", items: ["Dot and cross products"] },
    { unit: "Multivariable Differentiation", items: ["Gradient"] },
  ],
  policies: ["No late work without prior arrangements"],
  assessments: [
    {
      kind: "exam",
      title: "Exam 1",
      dateStart: "2026-09-24",
      dateEnd: "",
      time: "18:45",
      location: "",
    },
    {
      kind: "quiz",
      title: "Quiz 1",
      dateStart: "2026-09-01",
      dateEnd: "",
      time: "",
      location: "",
    },
    {
      kind: "final",
      title: "Final Exam",
      dateStart: "2026-12-14",
      dateEnd: "2026-12-18",
      time: "",
      location: "",
    },
    {
      kind: "homework",
      title: "Homework 1A",
      dateStart: "2026-08-24",
      dateEnd: "",
      time: "",
      location: "",
    },
    {
      kind: "break",
      title: "Spring Break",
      dateStart: "2026-11-23",
      dateEnd: "2026-11-27",
      time: "",
      location: "",
    },
    {
      kind: "exam",
      title: "Exam 2",
      dateStart: "",
      dateEnd: "",
      time: "",
      location: "",
    },
  ],
};

describe("syllabus parsing", () => {
  it("parseSyllabus returns the structured extraction", async () => {
    const engine = new FakeEngine();
    const parsed = await parseSyllabus(engine, "Fall 2026 syllabus text", {
      className: "Calc III",
    });
    expect(engine.calls).toEqual(["syllabus"]);
    expect(parsed.courseCode).toBe("MATH 2650");
    expect(parsed.assessments).toHaveLength(6);
  });

  it("isoToEpoch parses local dates and times", () => {
    const d = new Date(2026, 8, 24, 18, 45);
    expect(isoToEpoch("2026-09-24", "18:45")).toBe(d.getTime());
    expect(isoToEpoch("2026-09-24")).toBe(new Date(2026, 8, 24).getTime());
  });

  it("toEvents keeps every exam/quiz/final/homework event, dated or not", () => {
    const events = toEvents(PARSED);
    expect(events.map((e) => e.title)).toEqual([
      "Exam 1",
      "Quiz 1",
      "Final Exam",
      "Homework 1A",
      "Exam 2",
    ]);
    expect(events[0].time).toBe("18:45");
    expect(events[2].dateEnd).toBe(new Date(2026, 11, 18).getTime());
    expect(events[3].dateStart).toBe(new Date(2026, 7, 24).getTime());
    expect(events.find((e) => e.title === "Exam 2")!.dateStart).toBeUndefined();
  });

  it("buildSyllabus keeps all assessments including undated ones", () => {
    const syllabus = buildSyllabus(PARSED, "c1", "raw");
    expect(syllabus.classId).toBe("c1");
    expect(syllabus.events).toHaveLength(6);
    expect(syllabus.rawText).toBe("raw");
  });
});

describe("applySyllabus", () => {
  it("persists syllabus, sets class metadata + exam date, creates reminders and folders", async () => {
    const repo = new Repo(memoryStore());
    const classId = uuid();
    await repo.putClass({
      id: classId,
      name: "Calc III",
      ownerId: "u1",
      createdAt: now(),
      updatedAt: now(),
    });

    const summary = await applySyllabus(repo, PARSED, classId, "raw text");

    expect(summary.reminders).toBe(4);
    expect(summary.folders).toBe(2);
    expect(summary.events).toBe(6);

    const klass = await repo.getClass(classId);
    expect(klass!.courseCode).toBe("MATH 2650");
    expect(klass!.term).toBe("Fall 2026");
    expect(klass!.institution).toBe("Iowa State University");
    expect(klass!.syllabusId).toBeTruthy();

    const syllabus = await repo.syllabusForClass(classId);
    expect(syllabus).toBeTruthy();
    expect(syllabus!.events.some((e) => e.kind === "homework")).toBe(true);

    const reminders = await repo.remindersForClass(classId);
    expect(reminders).toHaveLength(4);
    expect(reminders.every((r) => r.source === "syllabus")).toBe(true);
    expect(reminders.find((r) => r.title === "Exam 1")!.dueDate).toBe(
      new Date(2026, 8, 24, 18, 45).getTime(),
    );
    expect(reminders.find((r) => r.title === "Homework 1A")!.dueDate).toBe(
      new Date(2026, 7, 24).getTime(),
    );
    expect(reminders.find((r) => r.title === "Homework 1A")!.dateEnd).toBeUndefined();
    /* Week-range items keep the range end so the date is flagged uncertain. */
    expect(reminders.find((r) => r.title === "Final Exam")!.dateEnd).toBe(
      new Date(2026, 11, 18).getTime(),
    );

    const folders = await repo.foldersForClass(classId);
    expect(folders.map((f) => f.name)).toEqual([
      "Geometry of Space; Vectors",
      "Multivariable Differentiation",
    ]);
  });

  it("exam date is the nearest upcoming exam/final", async () => {
    const repo = new Repo(memoryStore());
    const classId = uuid();
    await repo.putClass({
      id: classId,
      name: "C",
      ownerId: "u1",
      createdAt: now(),
      updatedAt: now(),
    });

    const past: ParsedSyllabus = {
      ...PARSED,
      assessments: [
        { kind: "exam", title: "Exam 1", dateStart: "2020-09-24", dateEnd: "", time: "", location: "" },
        { kind: "final", title: "Final", dateStart: "2020-12-14", dateEnd: "", time: "", location: "" },
      ],
    };
    const summary = await applySyllabus(repo, past, classId, "");
    const klass = await repo.getClass(classId);
    expect(klass!.examDate).toBe(new Date(2020, 8, 24).getTime());
    expect(summary.examDate).toBe(klass!.examDate);
  });

  it("re-applying replaces the previous syllabus and its reminders", async () => {
    const repo = new Repo(memoryStore());
    const classId = uuid();
    await repo.putClass({
      id: classId,
      name: "C",
      ownerId: "u1",
      createdAt: now(),
      updatedAt: now(),
    });
    await applySyllabus(repo, PARSED, classId, "");
    await repo.putReminder({
      id: uuid(),
      title: "Manual",
      text: "",
      classId,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
    });

    const v2: ParsedSyllabus = {
      ...PARSED,
      courseCode: "MATH 2650",
      assessments: [
        { kind: "quiz", title: "Quiz 1", dateStart: "2026-09-01", dateEnd: "", time: "", location: "" },
        { kind: "quiz", title: "Quiz 2", dateStart: "2026-09-08", dateEnd: "", time: "", location: "" },
      ],
    };
    await applySyllabus(repo, v2, classId, "");

    const syllabus = await repo.syllabusForClass(classId);
    const reminders = await repo.remindersForClass(classId);
    expect(syllabus!.events).toHaveLength(2);
    expect(reminders).toHaveLength(3); // 2 new + the manual one survives
    expect(reminders.filter((r) => r.source === "syllabus")).toHaveLength(2);
  });

  it("does not create folders when the class already has units", async () => {
    const repo = new Repo(memoryStore());
    const classId = uuid();
    await repo.putClass({
      id: classId,
      name: "C",
      ownerId: "u1",
      createdAt: now(),
      updatedAt: now(),
    });
    await repo.putFolder({ id: uuid(), name: "Unit 1", classId, createdAt: now() });

    const summary = await applySyllabus(repo, PARSED, classId, "");
    expect(summary.folders).toBe(0);
    const folders = await repo.foldersForClass(classId);
    expect(folders).toHaveLength(1);
  });

  it("honors a custom reminders list from the review screen", async () => {
    const repo = new Repo(memoryStore());
    const classId = uuid();
    await repo.putClass({
      id: classId,
      name: "C",
      ownerId: "u1",
      createdAt: now(),
      updatedAt: now(),
    });

    const summary = await applySyllabus(repo, PARSED, classId, "", {
      reminders: [
        {
          id: uuid(),
          kind: "exam",
          title: "Exam 1",
          dateStart: new Date(2026, 8, 25, 8, 0).getTime(),
          time: "08:00",
        },
      ],
    });
    expect(summary.reminders).toBe(1);
    const reminders = await repo.remindersForClass(classId);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].title).toBe("Exam 1");
    expect(reminders[0].dueDate).toBe(new Date(2026, 8, 25, 8, 0).getTime());
  });
});

describe("syllabusSchema strict-mode conformance", () => {
  /* OpenAI/DeepSeek strict structured output requires every `properties` key to
     be in `required` at every object level, and forbids type unions. */
  function walk(node: Record<string, unknown>, path: string): string[] {
    const problems: string[] = [];
    if (node.properties) {
      const props = Object.keys(node.properties as Record<string, unknown>);
      const required = (node.required as string[]) ?? [];
      const missing = props.filter((p) => !required.includes(p));
      if (missing.length > 0) {
        problems.push(`${path}: [${missing.join(", ")}] missing from required`);
      }
      for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
        problems.push(...walk(child as Record<string, unknown>, `${path}.${key}`));
      }
    }
    if (Array.isArray(node.type)) {
      problems.push(`${path}: union type ${JSON.stringify(node.type)}`);
    }
    if (node.items) {
      problems.push(...walk(node.items as Record<string, unknown>, `${path}[]`));
    }
    return problems;
  }

  it("every object's required covers all its properties; no type unions", () => {
    const problems = walk(syllabusSchema as unknown as Record<string, unknown>, "$");
    expect(problems).toEqual([]);
  });
});
