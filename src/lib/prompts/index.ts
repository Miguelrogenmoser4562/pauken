/* Versioned prompt templates + JSON schemas for all generation tasks.
   Structured tasks (flashcards, quiz) use strict JSON-schema output;
   free-form tasks (notes, chat, title) stream markdown/text. No source citations
   are emitted in generated content by design. */

export const PROMPTS_VERSION = 1;

/* ---- Notes -------------------------------------------------------------- */

export function noteSystem(language: string): string {
  return [
    "You are an expert study-note writer. Turn the user's source material into",
    "clear, well-structured study notes in GitHub-flavored Markdown.",
    "",
    "Requirements:",
    "- Open with a one-paragraph overview of what the material covers.",
    "- Use multi-level headings (#, ##, ###) to organize by concept, following the",
    "  source's natural order.",
    "- Use bullet and numbered lists; **bold** key terms and definitions.",
    "- Use Markdown tables for comparisons or structured data.",
    "- Use blockquote callouts `> [!note]` for important definitions or warnings.",
    "- Render math with KaTeX: inline `$x^2$`, display `$$...$$`. Preserve all",
    "  formulas, symbols, and code exactly.",
    "- Genuinely synthesize and explain — do NOT merely reorder the source.",
    "- For each major section or key factual claim, add a source annotation in",
    "  brackets like [§1] to show which part of the original material it draws from.",
    "  Sections are numbered by their order in the source. Use [§N] consistently.",
    "- End with a `## Key Takeaways` list.",
    "- Produce the COMPLETE notes. Never truncate or add a paywall.",
    `- Write in ${language}.`,
    "Output ONLY the raw Markdown notes — no preamble, and do NOT wrap the whole",
    "response in a ``` code fence.",
  ].join("\n");
}

export function noteUser(sourceText: string): string {
  return `Source material:\n\n${sourceText}`;
}

/* For large documents processed in chunks (map step): notes for ONE section. */
export function noteSectionSystem(
  language: string,
  part: number,
  total: number,
): string {
  return [
    `You are writing study notes for section ${part} of ${total} of a longer`,
    `document. Produce clear, well-structured Markdown notes for THIS section`,
    "only. Use ## and ### headings, bullet lists, **bold** key terms, tables, and",
    "KaTeX math ($…$, $$…$$) where relevant. Genuinely explain — do not just",
    "restate. Do NOT add an overall introduction, overview, or conclusion; those",
    `are added once at the end. Add source annotations like [§${part}] after key`,
    `claims to show they draw from section ${part} of the source.`,
    `Write in ${language}. Output only the Markdown.`,
  ].join("\n");
}

/* Reduce step: merge per-section notes into one coherent document. */
export function noteReduceSystem(language: string): string {
  return [
    "You are given study notes assembled from consecutive sections of one",
    "document. Merge them into a single coherent set of notes: open with a short",
    "overview paragraph, keep ALL substantive content, remove duplicated headings",
    "or repeated points, keep a logical order, and close with a `## Key Takeaways`",
    `list. Do not truncate. Write in ${language}. Output only the Markdown.`,
  ].join("\n");
}

/* ---- Title -------------------------------------------------------------- */

export const titleSystem =
  "You write concise, specific document titles. Given study notes or source " +
  "text, reply with a single title of at most 8 words. No quotes, no trailing " +
  'punctuation, no filler like "Notes on" or "Summary of". Title only.';

export function titleUser(text: string): string {
  return `Material:\n\n${text.slice(0, 4000)}`;
}

/* ---- Flashcards (two-phase) --------------------------------------------- */

export const topicsSystem =
  "You identify the main study topics in source material. Return 4–8 concise " +
  "topic labels (2–4 words each) that together cover the material.";

export const topicsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: { type: "array", items: { type: "string" } },
  },
} as const;

export function flashcardsSystem(topics: string[]): string {
  return [
    "You create study flashcards from source material.",
    "Rules: one atomic concept per card; the front is a question or term, the",
    "back is a complete, self-contained answer. Prefer active recall over",
    "recognition. Tag each card with the single most relevant topic from this",
    `list: ${topics.join(", ")}.`,
    "Create thorough coverage — aim for 2–4 cards per topic.",
  ].join("\n");
}

export const flashcardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["front", "back", "topic"],
        properties: {
          front: { type: "string" },
          back: { type: "string" },
          topic: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---- Quiz --------------------------------------------------------------- */

export function quizSystem(opts: {
  count: number;
  types: string[];
  category?: "knowledge" | "practice";
}): string {
  const lines = [
    `Create a ${opts.count}-question${opts.category === "practice" ? " practice problem" : ""} quiz from the source material.`,
    `Use these question types: ${opts.types.join(", ")}.`,
  ];
  if (opts.category === "practice") {
    lines.push(
      "Generate new practice problems based on the concepts in the material —",
      "e.g., similar math/physics problems, or analysis prompts for humanities.",
      "Do NOT ask recall questions about the source text itself; create fresh",
      "problems the student must solve using the concepts learned.",
    );
  } else {
    lines.push("Create exam-level hard questions that test understanding of the material.");
  }
  lines.push(
    "For mcq: exactly 4 plausible options, one correct. For true_false: options",
    'are ["True","False"]. For fill_blank: options is a single-element array with',
    "the exact answer, and correctIndex is 0; write the question with a ___ blank.",
    "correctIndex is the 0-based index of the correct option. Every question needs",
    "a one-sentence explanation of why the answer is correct. Tag each with a topic.",
    "For each question, include sourcePassage: the exact verbatim passage from the",
    "source material the question is based on. Quote directly. If no single passage",
    "applies, summarize the relevant section in your own words and label it [paraphrased].",
  );
  return lines.join("\n");
}

export const quizSchema = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "topic",
          "question",
          "options",
          "correctIndex",
          "explanation",
          "sourcePassage",
        ],
        properties: {
          type: { type: "string", enum: ["mcq", "true_false", "fill_blank"] },
          topic: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
          sourcePassage: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---- Chat --------------------------------------------------------------- */

export function chatSystem(noteTitle: string, sourceText: string): string {
  return [
    `You are a study assistant helping with the document "${noteTitle}".`,
    "Answer questions using the source material below. Be clear and concise, and",
    "use Markdown (headings, lists, **bold**) when helpful. For ANY math, symbols,",
    "or formulas, use KaTeX delimiters — inline `$E = mc^2$` and display `$$…$$` —",
    "never plain parentheses like ( F ). Base your answers strictly on the source",
    "material provided. When you draw from a specific passage, cite it in brackets",
    "like [§2] (referring to the relevant section heading). If the answer is not",
    "in the material, say so plainly rather than guessing. Do not use external",
    "knowledge beyond the source material to answer.",
    "",
    "--- SOURCE MATERIAL ---",
    sourceText.slice(0, 100_000),
    "--- END SOURCE MATERIAL ---",
  ].join("\n");
}

/* ---- Concept extraction (Step 1 of the practice-item pipeline) ---------- */

export const conceptsSystem =
  "You are an expert at decomposing study material into atomic, " +
  "individually-testable concepts. Each concept should be one independently " +
  "checkable fact or idea. For each concept provide:\n" +
  "- `title`: short label (2-6 words)\n" +
  "- `detail`: one-sentence explanation of what the concept covers\n" +
  "- `difficulty`: a 1-10 estimate (1 = definition recall, 10 = complex " +
  "multi-step reasoning)\n" +
  "Cover the material thoroughly. Do NOT include concepts about the source " +
  "format or structure — only substantive content.";

export const conceptsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["concepts"],
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "difficulty"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          difficulty: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
    },
  },
} as const;

/* ---- Bundled content generation (Step 2+3: MCQ + flashcard per concept) -- */

export const flashcardContentSystem =
  "You create study materials from source material. For each concept provided, " +
  "generate:\n" +
  "1. An **MCQ** — exam-level multiple choice question with exactly 4 options " +
  "and one correct answer. Write the question to test genuine understanding, " +
  "not trivial recall. Include a one-sentence explanation of why the answer " +
  "is correct.\n" +
  "2. A **learning flashcard** — `flashcardFront` is a question or prompt; " +
  "`flashcardBack` is a complete, self-contained answer; `flashcardContext` " +
  "is a short explanatory note (2-4 sentences) that helps someone learn the " +
  "concept for the first time.\n" +
  "3. **Source citation** — for each item, provide `sourcePassage`, the exact " +
  "sentence or passage from the source material that the question/flashcard is " +
  "based on. Quote verbatim. If no single passage applies, summarize the relevant " +
  "section in your own words but label it as `[paraphrased]`.\n" +
  "Output one item per concept, in the same order as the concept list. The " +
  "`conceptIndex` field must match the 0-based index of the concept in the " +
  "list provided.";

export const flashcardContentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "conceptIndex",
          "question",
          "options",
          "correctIndex",
          "explanation",
          "flashcardFront",
          "flashcardBack",
          "flashcardContext",
          "sourcePassage",
        ],
        properties: {
          conceptIndex: { type: "integer" },
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 4,
            maxItems: 4,
          },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
          flashcardFront: { type: "string" },
          flashcardBack: { type: "string" },
          flashcardContext: { type: "string" },
          sourcePassage: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---- Per-concept generation (D/E.3 + D/E.4) — single concept per LLM call ---- */

export const perConceptSystem =
  "You create one MCQ and one learning flashcard from source material for a single " +
  "concept. Given a concept description and relevant source passages, generate:\n" +
  "1. An **MCQ** — exam-level multiple choice question with exactly 4 options " +
  "and one correct answer. Write the question to test genuine understanding, " +
  "not trivial recall. Include a one-sentence explanation of why the answer " +
  "is correct.\n" +
  "2. A **learning flashcard** — `flashcardFront` is a question or prompt; " +
  "`flashcardBack` is a complete, self-contained answer; `flashcardContext` " +
  "is a short explanatory note (2-4 sentences) that helps someone learn the " +
  "concept for the first time.\n" +
  "3. **Source citation** — provide `sourcePassage`, the exact " +
  "sentence or passage from the source material that the question/flashcard is " +
  "based on. Quote verbatim. If no single passage applies, summarize the relevant " +
  "section in your own words but label it as `[paraphrased]`.\n" +
  "Relevant passages are labeled with position info like " +
  "[Passage N — chars X–Y]. Use these to identify the exact source location. " +
  "Focus strictly on the concept described. Do NOT include content from outside " +
  "the provided source passages.";

export const perConceptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["item"],
  properties: {
    item: {
      type: "object",
      additionalProperties: false,
      required: [
        "question",
        "options",
        "correctIndex",
        "explanation",
        "flashcardFront",
        "flashcardBack",
        "flashcardContext",
        "sourcePassage",
      ],
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 4,
          maxItems: 4,
        },
        correctIndex: { type: "integer" },
        explanation: { type: "string" },
        flashcardFront: { type: "string" },
        flashcardBack: { type: "string" },
        flashcardContext: { type: "string" },
        sourcePassage: { type: "string" },
      },
    },
  },
} as const;

/* ---- Syllabus ----------------------------------------------------------- */

export function syllabusSystem(hints: {
  className?: string;
  termHint?: string;
}): string {
  const hintLines: string[] = [];
  if (hints.className) hintLines.push(`The class name is "${hints.className}".`);
  if (hints.termHint) hintLines.push(`The class term appears to be "${hints.termHint}".`);
  const hintBlock = hintLines.length > 0 ? hintLines.join("\n") + "\n" : "";
  return [
    "You extract structured information from a university course syllabus.",
    hintBlock,
    "Return course metadata, instructors, grading, topics, policies, and EVERY dated",
    "assessment (exams, quizzes, homeworks, final exams, breaks) listed in the",
    "document — including dates found in a course-calendar table.",
    "",
    "Date handling:",
    "- Convert every date to an explicit ISO date string (YYYY-MM-DD), using the",
    "  year stated by the term (e.g. 'Fall 2026' → 2026). If no year is derivable,",
    "  use an empty string for the date fields rather than guessing.",
    "- For a week range like 'Aug 24-28', use the first day of the stated range",
    "  as dateStart and the last day as dateEnd. The exact due date is then",
    "  unknown — the user is warned and may fix it.",
    "- For a specific date like 'Thursday, September 24', use that exact date for",
    "  both dateStart and dateEnd, and put the time (e.g. '18:45') in `time` if",
    "  stated.",
    "- When the same assessment appears in both prose and the calendar table,",
    "  prefer the explicit date in prose.",
    "- Never invent dates, times, or rooms that are not in the document.",
    "",
    "Assessment rules:",
    "- `kind` is one of: exam, quiz, final, homework, break, other.",
    "- Keep titles exactly as written ('Exam 1', 'Quiz 7', 'Final Exam').",
    "- List each homework separately: 'Homeworks 1ABC' becomes Homework 1A,",
    "  Homework 1B, Homework 1C.",
    "",
    "Other rules:",
    "- `grading` lists each grade category with its weight as a number (e.g. 15).",
    "- `gradeScale` lists letter-grade cutoffs as minimum percentages.",
    "- `topics` groups the course's learning objectives by unit.",
    "- `policies` is short bullet summaries (late work, makeup, retakes, AI usage,",
    "  attendance).",
    "- `instructors` and `teachingAssistants` are people with name, email, and",
    "  office when present.",
    "- Be precise and complete; omission is better than hallucination.",
    "",
    "Output format (strict):",
    "- Use \"\" (empty string) for any unknown or missing value: dates, times,",
    "  rooms, emails, offices, grade-scale entries.",
    "- Use [] for empty arrays. Never output null, and never omit a field — every",
    "  field in the JSON schema must be present.",
  ].join("\n");
}

export const syllabusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "courseTitle",
    "courseCode",
    "term",
    "institution",
    "instructors",
    "teachingAssistants",
    "officeHours",
    "grading",
    "gradeScale",
    "topics",
    "policies",
    "assessments",
  ],
  properties: {
    courseTitle: { type: "string" },
    courseCode: { type: "string" },
    term: { type: "string" },
    institution: { type: "string" },
    instructors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "office"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          office: { type: "string" },
        },
      },
    },
    teachingAssistants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "office"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          office: { type: "string" },
        },
      },
    },
    officeHours: { type: "string" },
    grading: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "weightPct", "notes"],
        properties: {
          category: { type: "string" },
          weightPct: { type: "number" },
          notes: { type: "string" },
        },
      },
    },
    gradeScale: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["minPct", "letter"],
        properties: {
          minPct: { type: "number" },
          letter: { type: "string" },
        },
      },
    },
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["unit", "items"],
        properties: {
          unit: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
    policies: { type: "array", items: { type: "string" } },
    assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "dateStart", "dateEnd", "time", "location"],
        properties: {
          kind: {
            type: "string",
            enum: ["exam", "quiz", "final", "homework", "break", "other"],
          },
          title: { type: "string" },
          dateStart: { type: "string" },
          dateEnd: { type: "string" },
          time: { type: "string" },
          location: { type: "string" },
        },
      },
    },
  },
} as const;
