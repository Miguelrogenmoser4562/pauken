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
  /* Course metadata, populated from an uploaded syllabus. */
  courseCode?: string;
  term?: string;
  institution?: string;
  syllabusId?: ID;
}

/* ---- Syllabus ----------------------------------------------------------- */

export type SyllabusEventKind =
  | "exam"
  | "quiz"
  | "final"
  | "homework"
  | "break"
  | "other";

export interface SyllabusContact {
  name: string;
  email?: string;
  office?: string;
}

export interface SyllabusGradingItem {
  category: string;
  weightPct: number;
  notes?: string;
}

export interface SyllabusTopicUnit {
  unit: string;
  items: string[];
}

/* A dated assessment extracted from the syllabus. Stored inside the Syllabus
   record; reminders are created from these when applying. */
export interface SyllabusEvent {
  id: ID;
  kind: SyllabusEventKind;
  title: string;
  /* Epoch ms; for week-range events this is the Monday of the week.
     Undefined when the syllabus gives no date. */
  dateStart?: number;
  dateEnd?: number;
  /* "18:45" style local time, when stated. */
  time?: string;
  location?: string;
}

/* Full structured extraction of an uploaded syllabus, persisted per class. */
export interface Syllabus {
  id: ID;
  classId: ID;
  courseTitle: string;
  courseCode?: string;
  term?: string;
  institution?: string;
  instructors: SyllabusContact[];
  teachingAssistants: SyllabusContact[];
  officeHours?: string;
  grading: SyllabusGradingItem[];
  gradeScale?: { minPct: number; letter: string }[];
  topics: SyllabusTopicUnit[];
  policies: string[];
  events: SyllabusEvent[];
  /* Raw normalized syllabus text, kept for re-parsing / future features. */
  rawText: string;
  createdAt: number;
  updatedAt: number;
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
  | "ocr"
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
  /* Show the partner's pick on answer choices during synced sessions. */
  showPartnerPick?: boolean;
  /* Preferred screen mode for synced sessions (applied as the default). */
  screenMode?: ScreenMode;
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

/* How this user's screen tracks the partner's position during a synced
 * session: "follow" (default, follow unless the partner is independent),
 * "not-follow" (never jump), or "independent" (never followed by others). */
export type ScreenMode = "follow" | "not-follow" | "independent";

export interface CoStudySession {
  id: ID;
  code: string;
  classId: ID;
  createdBy?: ID;
  questionIds: ID[];
  currentIndex: number;
  participants: CoStudyParticipant[];
  status: "waiting" | "active" | "complete";
  createdAt: number;
  /* True when every participant has locked an answer for the current question. */
  revealed: boolean;
  /* Browse-mode filter the creator applied when building the queue. */
  filter?: { folderIds: ID[]; topic?: string };
  /* Per-question answers, keyed by questionId (survives navigation). */
  answersByQuestion?: Record<string, Record<string, CoStudyAnswer>>;
  revealedByQuestion?: Record<string, boolean>;
}

export interface CoStudyParticipant {
  userId: ID;
  userName: string;
  lockedIn: boolean;
  /* Live pick (set on click AND on lock). */
  answer?: number;
  lastAnswerAt?: number;
  screenMode?: ScreenMode;
  /* False once the socket drops; set again on reconnect (grace period). */
  connected?: boolean;
}

export interface CoStudyAnswer {
  answer?: number;
  lockedIn: boolean;
  lastAnswerAt?: number;
}

/* WebSocket message types for co-study protocol. */
export type WsMessage =
  | { type: "create_session"; classId: ID; questionIds: ID[]; userId?: ID; userName?: string; progress: UserProgress[]; reviewLogs?: ReviewLog[]; filter?: { folderIds: ID[]; topic?: string } }
  | { type: "session_created"; session: CoStudySession }
  | { type: "join_session"; code: string; userId?: ID; userName?: string; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "session_joined"; session: CoStudySession; userId: ID }
  | { type: "participant_joined"; participant: CoStudyParticipant; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "answer_picked"; sessionId: ID; answer: number }
  | { type: "pick_changed"; userId: ID; answer: number }
  | { type: "lock_answer"; sessionId: ID; answer: number; index: number }
  | { type: "answer_locked"; userId: ID; answer: number }
  | { type: "both_answered"; answers: { userId: ID; answer: number }[] }
  | { type: "set_session_queue"; sessionId: ID; questionIds: ID[]; filter?: { folderIds: ID[]; topic?: string } }
  | { type: "session_started"; sessionId: ID; questionIds: ID[]; index: number; filter?: { folderIds: ID[]; topic?: string } }
  | { type: "update_progress"; sessionId: ID; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "progress_updated"; userId: ID; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "rate_question"; sessionId: ID }
  | { type: "next_question"; index: number; answers: { userId: ID; answer?: number; lockedIn: boolean }[]; revealed: boolean }
  | { type: "rejoin_session"; sessionId: ID; userId: ID; userName?: string; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "session_state"; session: CoStudySession; reason: "rejoin" | "navigate" }
  | { type: "navigate_session"; sessionId: ID; index: number }
  | { type: "set_screen_mode"; sessionId: ID; mode: ScreenMode }
  | { type: "screen_mode_changed"; userId: ID; mode: ScreenMode }
  | { type: "leave_session"; sessionId: ID }
  | { type: "participant_left"; userId: ID }
  | { type: "session_ended"; sessionId: ID }
  | { type: "request_rebuild"; sessionId: ID; folderIds: ID[]; topic?: string; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "rebuild_requested"; folderIds: ID[]; topic?: string; requesterId: ID; progress: UserProgress[]; reviewLogs?: ReviewLog[] }
  | { type: "ping" }
  | { type: "pong" }
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
  /* End of a date range when `dueDate` is only the start of it (e.g. a week
     from the syllabus). The date is then uncertain; cleared once the user
     pins an exact date. */
  dateEnd?: number;
  completed: boolean;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  /* "syllabus" when auto-created from an uploaded syllabus. */
  source?: "syllabus";
}
