/* Pauken domain model — shared contract for db, engine, generation, and UI.
   Everything persisted lives here. IDs are uuid strings. Timestamps are epoch ms. */

export type ID = string;

export type SourceKind =
  | "blank"
  | "text"
  | "pdf"
  | "docx"
  | "audio"
  | "url";

export type ContentScope = "new_topic" | "new_unit" | "additional" | "general";

export type EngineMode = "cloud";
export type Provider = "openai" | "anthropic" | "deepseek";

/* ---- Notes & content ---------------------------------------------------- */

/* A note is one study document. Its body is an ordered list of blocks
   (our editor model, serializable to/from Markdown). */
export interface Note {
  id: ID;
  title: string;
  sourceKind: SourceKind;
   /* Raw normalized source text (transcript / extracted document text). Used as
      grounding context for chat, flashcards, and quiz generation. */
  sourceText: string;
  /* Optional origin metadata (url, filename, duration). */
  sourceMeta?: Record<string, string | number | undefined>;
  blocks: Block[];
  /* Markdown bullet-list summary (<10 points) for quick review. */
  summary?: string;
  folderId?: ID;
  /* Whether this note is study material (knowledge) or practice problems (practice). */
  contentCategory?: "knowledge" | "practice";
  /* Topic label — what lesson/subject this note covers within its unit. */
  topic?: string;
  /* What kind of content this is: new topic, new unit, additional material, or general. */
  contentScope?: ContentScope;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export type BlockType =
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "callout"
  | "code"
  | "math"
  | "divider"
  | "table";

export interface Block {
  id: ID;
  type: BlockType;
  /* Inline markdown text for text blocks; language for code; latex for math. */
  text: string;
  checked?: boolean; // todo
  emoji?: string; // callout / heading marker
  language?: string; // code
  rows?: string[][]; // table
  /* Source citation range: char offsets into the note's sourceText.
     Used to link note sections back to the original material. */
  citation?: { charStart: number; charEnd: number; label: string };
}

export interface PaukenUser {
  id: ID;
  name: string;
  key: string;
  isAdmin?: boolean;
  avatar?: string;
}

export interface ClassMember {
  id: ID;
  classId: ID;
  userId: ID;
  role: "owner" | "member";
  status?: "pending" | "active";
  joinedAt: number;
}

export interface ClassEntity {
  id: ID;
  name: string;
  description?: string;
  ownerId: ID;
  createdAt: number;
  updatedAt: number;
  /* Study preferences (optional — fall back to global defaults). */
  examDate?: number;
  retentionTarget?: number;
  maxReviewsPerItemPerWeek?: number;
  maxNewCardsPerSession?: number;
}

export interface Folder {
  id: ID;
  name: string;
  classId?: ID;
  createdAt: number;
}

/* ---- Study tools -------------------------------------------------------- */

/* Flashcard — learning-phase content only (no scheduling).
   Shown alongside context/explanation during first exposure to a concept. */
export interface Flashcard {
  id: ID;
  noteId: ID;
  conceptId?: ID;
  front: string;
  back: string;
  context: string;
  topic: string;
  sourcePassage?: string; // passage from source text this card is based on
}

/* SRS state shared by practice items. */
export type PracticeState = "new" | "learning" | "review" | "relearning";

/* QuizQuestion serves double duty:
   1. MCQs / true-false / fill-blank practice questions (the main SRS-tracked item)
   2. FSRS scheduling state for spaced repetition
   Each question maps to one extracted concept from the source material. */
export interface QuizQuestion {
  id: ID;
  noteId: ID;
  conceptId?: ID;
  type: QuizType;
  topic: string;
  /* Display difficulty — how hard the question itself is. */
  difficulty: "basic" | "intermediate" | "exam";
  question: string;
  options: string[];
  correctIndex: number; // index into options; for fill_blank, 0 and options[0] is the answer
  explanation: string;
  /* FSRS scheduling state. */
  state: PracticeState;
  due: number; // epoch ms when next due (far future sentinel for backlogged NEW)
  stability: number;
  fsrsDifficulty: number; // 1–10, seeded at generation, refined by FSRS
  reps: number;
  lapses: number;
  lastReview?: number;
  firstExposedAt?: number; // when first shown to user (NEW→LEARNING)
  generatedAt: number;
  sourcePassage?: string; // passage from source text this question is based on
}

export type QuizType = "mcq" | "true_false" | "fill_blank";

/* Per-user FSRS scheduling state for a question.
   When present, this overrides the default FSRS fields on QuizQuestion. */
export interface UserProgress {
  id: ID;
  userId: ID;
  questionId: ID;
  state: PracticeState;
  due: number;
  stability: number;
  fsrsDifficulty: number;
  reps: number;
  lapses: number;
  lastReview?: number;
  firstExposedAt?: number;
}

export interface QuizAttempt {
  id: ID;
  noteId: ID;
  questionId: ID;
  userId?: ID;
  topic: string;
  correct: boolean;
  at: number;
}

/* ---- Chat --------------------------------------------------------------- */

export interface ChatTurn {
  id: ID;
  noteId: ID;
  role: "user" | "assistant";
  content: string;
  at: number;
}

/* ---- Job pipeline ------------------------------------------------------- */

export type JobStage =
  | "ingest"
  | "transcribe"
  | "notes"
  | "title"
  | "flashcards"
  | "quiz";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobFile {
  name: string;
  status: JobStatus;
  error?: string;
}

export interface Job {
  id: ID;
  noteId?: ID;
  label: string;
  stage: JobStage;
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  files?: JobFile[]; // per-file status for multi-upload
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/* ---- Engine preferences ------------------------------------------------- */

export interface EnginePrefs {
  /* null until the user provides a valid API key. */
  mode: EngineMode | null;
  onboarded: boolean;
  /* Explicit cloud provider selection (stored when ambiguous from key prefix). */
  cloudProvider?: Provider;
  /* Cloud model override; empty string = provider default. */
  cloudModel?: string;
  language: string;
  /* Default reminder time in HH:MM (24-hour). */
  defaultReminderTime: string;
  /* Whether to generate a full written summary (default true). */
  generateSummary?: boolean;
  /* Data-URL (base64) avatar image, or empty string for initial-badge fallback. */
  avatar?: string;
  /* Multi-user server connection. */
  serverUrl?: string;
  userKey?: string;
}

/* ---- Per-user study defaults (overridable per-class) -------------------- */

export interface StudyDefaults {
  retentionTarget: number;
  maxReviewsPerItemPerWeek: number;
  maxNewCardsPerSession: number;
}

export const DEFAULT_STUDY_DEFAULTS: StudyDefaults = {
  retentionTarget: 0.9,
  maxReviewsPerItemPerWeek: 3,
  maxNewCardsPerSession: 10,
};

/* ---- Co-Study (Partner Features) --------------------------------------- */

export interface CoStudySession {
  id: ID;
  classId: ID;
  questionIds: ID[];
  currentIndex: number;
  participants: CoStudyParticipant[];
  status: "waiting" | "active" | "complete";
  createdAt: number;
}

export interface CoStudyParticipant {
  userId: ID;
  userName: string;
  lockedIn: boolean;
  lastAnswerAt?: number;
}

/* WebSocket message types for co-study protocol. */
export type WsMessage =
  | { type: "create_session"; classId: ID; questionIds: ID[] }
  | { type: "session_created"; session: CoStudySession }
  | { type: "join_session"; sessionId: ID; userId?: ID; userName?: string }
  | { type: "session_joined"; session: CoStudySession; userId: ID }
  | { type: "participant_joined"; participant: CoStudyParticipant }
  | { type: "lock_answer"; sessionId: ID; answer: number }
  | { type: "answer_locked"; userId: ID }
  | { type: "both_answered"; answers: { userId: ID; answer: number }[]; nextIndex: number }
  | { type: "next_question"; index: number }
  | { type: "leave_session"; sessionId: ID }
  | { type: "session_ended"; sessionId: ID }
  | { type: "error"; message: string };

/* ---- Source chunks (RAG / source-grounded generation) ------------------- */

export interface SourceChunk {
  id: ID;
  noteId: ID;
  index: number;
  text: string;
  embedding?: number[];
  charStart: number;
  charEnd: number;
  sourceName?: string;
}

/* ---- Append-only review log (accurate weekly caps, history export) ------ */

export type Rating = "again" | "hard" | "good" | "easy";

export interface ReviewLog {
  id: ID;
  userId?: ID;
  questionId: ID;
  rating: Rating;
  stateBefore: {
    state: PracticeState;
    due: number;
    stability: number;
    fsrsDifficulty: number;
    reps: number;
    lapses: number;
  };
  stateAfter: {
    state: PracticeState;
    due: number;
    stability: number;
    fsrsDifficulty: number;
    reps: number;
    lapses: number;
  };
  at: number;
}

/* Activity event for async co-study feed. */
export interface ActivityEvent {
  id: ID;
  classId: ID;
  userId: ID;
  userName: string;
  type: "attempt" | "note_created" | "joined_class";
  details: string;
  at: number;
}

/* ---- Quick Reminders ---------------------------------------------------- */

export interface Reminder {
  id: ID;
  title: string;
  text: string;
  classId?: ID;
  dueDate?: number;
  completed: boolean;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}
