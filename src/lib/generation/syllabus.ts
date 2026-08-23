/* Syllabus parsing + application. One structured LLM call extracts the course
   structure (metadata, grading, topics, assessments); deterministic JS maps
   ISO dates to epoch timestamps, filters the events worth reminding about, and
   applies everything to a class (exam date for FSRS, reminders, unit folders). */

import type { Engine } from "../engine/types";
import type { Repo } from "../db";
import type {
  ClassEntity,
  Folder,
  Reminder,
  Syllabus,
  SyllabusEvent,
  SyllabusEventKind,
} from "../types";
import { now, uuid } from "../ids";
import { syllabusSchema, syllabusSystem } from "../prompts";

/* Raw LLM output shape — ISO date strings, un-filtered. The strict-mode schema
   requires every field; unknown values arrive as "". */
export interface ParsedSyllabus {
  courseTitle: string;
  courseCode: string;
  term: string;
  institution: string;
  instructors: { name: string; email: string; office: string }[];
  teachingAssistants: { name: string; email: string; office: string }[];
  officeHours: string;
  grading: { category: string; weightPct: number; notes: string }[];
  gradeScale: { minPct: number; letter: string }[];
  topics: { unit: string; items: string[] }[];
  policies: string[];
  assessments: {
    kind: SyllabusEventKind;
    title: string;
    dateStart: string;
    dateEnd: string;
    time: string;
    location: string;
  }[];
}

/* "":  string → undefined sentinel (strict schemas can't emit null). */
function str(s?: string): string | undefined {
  return s && s.trim() ? s.trim() : undefined;
}

export interface SyllabusHints {
  className?: string;
  termHint?: string;
}

export interface SyllabusApplySummary {
  syllabusId: string;
  events: number;
  reminders: number;
  folders: number;
  examDate?: number;
}

export async function parseSyllabus(
  engine: Engine,
  text: string,
  hints: SyllabusHints = {},
): Promise<ParsedSyllabus> {
  return engine.structured<ParsedSyllabus>({
    system: syllabusSystem(hints),
    messages: [
      {
        role: "user",
        content: `Syllabus document:\n\n${text.slice(0, 60_000)}`,
      },
    ],
    schema: syllabusSchema as unknown as Record<string, unknown>,
    schemaName: "syllabus",
    tier: "strong",
  });
}

/* "2026-08-24" → epoch ms at local midnight; "18:45" → local time. */
export function isoToEpoch(date: string, time?: string): number {
  const [y, m, d] = date.split("-").map(Number);
  let hour = 0;
  let minute = 0;
  if (time) {
    const match = time.match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      hour = Number(match[1]);
      minute = Number(match[2]);
    }
  }
  return new Date(y, (m ?? 1) - 1, d ?? 1, hour, minute).getTime();
}

/* Epoch ms → "YYYY-MM-DD" for date inputs. */
export function epochToDateInput(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/* Map parsed assessments (ISO strings) to typed SyllabusEvents. Keep every
   assessment (dated or not) so the stored record is complete; callers that
   need reminders filter on dateStart themselves. */
export function toEvents(
  parsed: ParsedSyllabus,
  kinds: SyllabusEventKind[] = ["exam", "quiz", "final", "homework"],
): SyllabusEvent[] {
  return parsed.assessments
    .filter((a) => kinds.includes(a.kind))
    .map((a) => ({
      id: uuid(),
      kind: a.kind,
      title: a.title,
      dateStart:
        a.dateStart && !Number.isNaN(isoToEpoch(a.dateStart, a.time))
          ? isoToEpoch(a.dateStart, a.time)
          : undefined,
      dateEnd: a.dateEnd ? isoToEpoch(a.dateEnd) : undefined,
      time: str(a.time),
      location: str(a.location),
    }));
}

/* Build the persisted Syllabus record (keeps ALL assessments + raw text). */
export function buildSyllabus(
  parsed: ParsedSyllabus,
  classId: string,
  rawText: string,
): Syllabus {
  const nowMs = now();
  return {
    id: uuid(),
    classId,
    courseTitle: parsed.courseTitle || "Course",
    courseCode: str(parsed.courseCode),
    term: str(parsed.term),
    institution: str(parsed.institution),
    instructors: parsed.instructors.map((i) => ({
      name: i.name,
      email: str(i.email),
      office: str(i.office),
    })),
    teachingAssistants: parsed.teachingAssistants.map((t) => ({
      name: t.name,
      email: str(t.email),
      office: str(t.office),
    })),
    officeHours: str(parsed.officeHours),
    grading: parsed.grading.map((g) => ({
      category: g.category,
      weightPct: g.weightPct,
      notes: str(g.notes),
    })),
    gradeScale: parsed.gradeScale.length > 0 ? parsed.gradeScale : undefined,
    topics: parsed.topics ?? [],
    policies: parsed.policies ?? [],
    events: toEvents(parsed, [
      "exam",
      "quiz",
      "final",
      "homework",
      "break",
      "other",
    ]),
    rawText,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

/* Nearest upcoming exam/final date (fallback: earliest overall). */
function pickExamDate(
  events: SyllabusEvent[],
  existing?: number,
): number | undefined {
  const candidates = events
    .filter((e) => e.kind === "exam" || e.kind === "final")
    .map((e) => e.dateStart)
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);
  if (candidates.length === 0) return existing;
  const today = now();
  const upcoming = candidates.find((c) => c >= today);
  return upcoming ?? candidates[0];
}

/* Persist the syllabus and apply its consequences to the class:
   1. Syllabus record (full structured extraction + raw text) — replaces any
      previous syllabus record and its auto-generated reminders.
   2. ClassEntity course metadata + examDate (drives FSRS exam-date ceiling).
   3. Reminder per dated event in `opts.reminders` (default: exams/quizzes/
      final/homework).
   4. Folder per syllabus topic unit (only when the class has no folders yet). */
export async function applySyllabus(
  repo: Repo,
  parsed: ParsedSyllabus,
  classId: string,
  rawText: string,
  opts: { reminders?: SyllabusEvent[] } = {},
): Promise<SyllabusApplySummary> {
  const syllabus = buildSyllabus(parsed, classId, rawText);

  /* Replace any previous syllabus + its auto-generated reminders. */
  const previous = await repo.syllabusForClass(classId);
  if (previous) await repo.deleteSyllabus(previous.id);
  const previousReminders = await repo.remindersForClass(classId);
  await Promise.all(
    previousReminders
      .filter((r) => r.source === "syllabus")
      .map((r) => repo.deleteReminder(r.id)),
  );

  await repo.putSyllabus(syllabus);

  const klass = await repo.getClass(classId);
  const examDate = pickExamDate(syllabus.events, klass?.examDate);
  if (klass) {
    const updated: ClassEntity = {
      ...klass,
      courseCode: str(parsed.courseCode) ?? klass.courseCode,
      term: str(parsed.term) ?? klass.term,
      institution: str(parsed.institution) ?? klass.institution,
      syllabusId: syllabus.id,
      examDate,
      updatedAt: now(),
    };
    await repo.putClass(updated);
  }

  /* Reminders for the events worth surfacing. */
  const reminderEvents = (
    opts.reminders ?? toEvents(parsed, ["exam", "quiz", "final", "homework"])
  )
    .filter((e): e is SyllabusEvent => e.dateStart !== undefined);
  const reminders = reminderEvents.map((e) => {
    const parts = [e.time, e.location].filter(Boolean).join(" · ");
    const r: Reminder = {
      id: uuid(),
      title: e.title,
      text: parts,
      classId,
      dueDate: e.dateStart,
      /* Keep the range end so the reminder is flagged as uncertain. */
      dateEnd:
        e.dateEnd !== undefined && e.dateEnd !== e.dateStart
          ? e.dateEnd
          : undefined,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
      source: "syllabus",
    };
    return r;
  });
  await Promise.all(reminders.map((r) => repo.putReminder(r)));

  /* Unit folders from syllabus topics — only when the class is still empty. */
  let foldersCreated = 0;
  const existingFolders = await repo.foldersForClass(classId);
  if (existingFolders.length === 0) {
    for (const t of syllabus.topics.slice(0, 8)) {
      const name = t.unit.trim().slice(0, 80) || "Unit";
      const f: Folder = {
        id: uuid(),
        name,
        classId,
        createdAt: now(),
      };
      await repo.putFolder(f);
      foldersCreated++;
    }
  }

  return {
    syllabusId: syllabus.id,
    events: syllabus.events.length,
    reminders: reminders.length,
    folders: foldersCreated,
    examDate,
  };
}
