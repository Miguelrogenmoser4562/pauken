/* Storage abstraction. The app uses the IndexedDB implementation; tests use the
   in-memory one. A future Rust/SQLite backend implements the same Store. */

import type {
  ActivityEvent,
  ChatTurn,
  ClassEntity,
  ClassMember,
  Flashcard,
  Folder,
  ID,
  Job,
  Note,
  PaukenUser,
  QuizAttempt,
  QuizQuestion,
  Reminder,
  ReviewLog,
  SourceChunk,
  UserProgress,
} from "../types";

/* Collections keyed by id. `by` fields enable cheap filtered reads. */
export interface Store {
  get<T>(collection: string, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: string, value: T): Promise<T>;
  delete(collection: string, id: string): Promise<void>;
  all<T>(collection: string): Promise<T[]>;
  /* Shallow equality filter over top-level fields. */
  where<T>(collection: string, match: Partial<T>): Promise<T[]>;
  clear(collection: string): Promise<void>;
}

export const COLLECTIONS = {
  notes: "notes",
  folders: "folders",
  classes: "classes",
  flashcards: "flashcards",
  quiz: "quiz",
  attempts: "attempts",
  reviewLogs: "review_logs",
  chunks: "chunks",
  users: "users",
  classMembers: "class_members",
  userProgress: "user_progress",
  activityEvents: "activity_events",
  chat: "chat",
  jobs: "jobs",
  reminders: "reminders",
} as const;

/* High-level repository over a Store. This is what generation code and the UI
   use; it never touches the raw Store directly. */
export class Repo {
  constructor(private store: Store) {}

  // notes
  getNote = (id: string) => this.store.get<Note>(COLLECTIONS.notes, id);
  putNote = (n: Note) => this.store.put(COLLECTIONS.notes, n);
  deleteNote = async (id: string) => {
    await this.store.delete(COLLECTIONS.notes, id);
    for (const c of [
      COLLECTIONS.flashcards,
      COLLECTIONS.quiz,
      COLLECTIONS.attempts,
      COLLECTIONS.chat,
    ]) {
      const rows = await this.store.where<{ id: string; noteId: string }>(c, {
        noteId: id,
      } as Partial<{ id: string; noteId: string }>);
      await Promise.all(rows.map((r) => this.store.delete(c, r.id)));
    }
  };
  listNotes = async () =>
    (await this.store.all<Note>(COLLECTIONS.notes)).sort(
      (a, b) => b.lastOpenedAt - a.lastOpenedAt,
    );

  // classes
  listClasses = () => this.store.all<ClassEntity>(COLLECTIONS.classes);
  getClass = (id: string) => this.store.get<ClassEntity>(COLLECTIONS.classes, id);
  putClass = (c: ClassEntity) => this.store.put(COLLECTIONS.classes, c);
  deleteClass = async (id: string) => {
    const folders = await this.store.where<Folder>(COLLECTIONS.folders, { classId: id } as Partial<Folder>);
    for (const f of folders) {
      await this.deleteFolder(f.id);
    }
    await this.store.delete(COLLECTIONS.classes, id);
  };

  // class members
  membersForClass = (classId: string) =>
    this.store.where<ClassMember>(COLLECTIONS.classMembers, { classId } as Partial<ClassMember>);
  membersForUser = (userId: string) =>
    this.store.where<ClassMember>(COLLECTIONS.classMembers, { userId } as Partial<ClassMember>);
  putClassMember = (m: ClassMember) => this.store.put(COLLECTIONS.classMembers, m);
  removeClassMember = (id: string) => this.store.delete(COLLECTIONS.classMembers, id);

  // users
  getUser = (id: string) => this.store.get<PaukenUser>(COLLECTIONS.users, id);
  listUsers = () => this.store.all<PaukenUser>(COLLECTIONS.users);

  // user progress (per-user FSRS state)
  progressFor = (userId: ID, questionId: ID) =>
    this.store.where<UserProgress>(COLLECTIONS.userProgress, { userId, questionId } as Partial<UserProgress>)
      .then((rows) => rows[0]);
  putProgress = (p: UserProgress) => this.store.put(COLLECTIONS.userProgress, p);
  deleteProgress = (id: ID) => this.store.delete(COLLECTIONS.userProgress, id);
  listProgressForUser = (userId: ID) =>
    this.store.where<UserProgress>(COLLECTIONS.userProgress, { userId } as Partial<UserProgress>);
  progressForQuestion = (questionId: ID) =>
    this.store.where<UserProgress>(COLLECTIONS.userProgress, { questionId } as Partial<UserProgress>);

  // folders (units)
  listFolders = () => this.store.all<Folder>(COLLECTIONS.folders);
  putFolder = (f: Folder) => this.store.put(COLLECTIONS.folders, f);
  deleteFolder = async (id: string) => {
    const notes = await this.store.where<Note>(COLLECTIONS.notes, { folderId: id } as Partial<Note>);
    for (const n of notes) {
      const updated = { ...n, folderId: undefined } as Note;
      await this.store.put(COLLECTIONS.notes, updated);
    }
    await this.store.delete(COLLECTIONS.folders, id);
  };
  foldersForClass = (classId: string) =>
    this.store.where<Folder>(COLLECTIONS.folders, { classId } as Partial<Folder>);
  notesForFolder = (folderId: string) =>
    this.store.where<Note>(COLLECTIONS.notes, { folderId } as Partial<Note>);

  // review logs
  putReviewLog = (r: ReviewLog) => this.store.put(COLLECTIONS.reviewLogs, r);
  reviewLogsForQuestion = (questionId: string) =>
    this.store.where<ReviewLog>(COLLECTIONS.reviewLogs, { questionId } as Partial<ReviewLog>);
  reviewLogsForUser = (userId?: string) =>
    userId
      ? this.store.where<ReviewLog>(COLLECTIONS.reviewLogs, { userId } as Partial<ReviewLog>)
      : this.store.all<ReviewLog>(COLLECTIONS.reviewLogs);
  /* Recent review logs for weekly cap calculation. */
  recentReviewLogs = async (userId: string | undefined, sinceMs: number): Promise<ReviewLog[]> => {
    const all = await this.reviewLogsForUser(userId);
    return all.filter((r) => r.at >= sinceMs);
  };

  /* All review logs for every question in a note. */
  reviewLogsForNote = async (noteId: string): Promise<ReviewLog[]> => {
    const questions = await this.questionsFor(noteId);
    const all = await Promise.all(questions.map((q) => this.reviewLogsForQuestion(q.id)));
    return all.flat().sort((a, b) => a.at - b.at);
  };

  // source chunks (RAG)
  chunksForNote = (noteId: string) =>
    this.store.where<SourceChunk>(COLLECTIONS.chunks, { noteId } as Partial<SourceChunk>);
  putChunk = (c: SourceChunk) => this.store.put(COLLECTIONS.chunks, c);
  putChunks = (cs: SourceChunk[]) => Promise.all(cs.map((c) => this.store.put(COLLECTIONS.chunks, c)));

  // flashcards — learning-phase content only (no scheduling state)
  cardsForNote = (noteId: string) =>
    this.store.where<Flashcard>(COLLECTIONS.flashcards, { noteId });
  putFlashcard = (c: Flashcard) => this.store.put(COLLECTIONS.flashcards, c);
  putFlashcards = (cs: Flashcard[]) =>
    Promise.all(cs.map((c) => this.store.put(COLLECTIONS.flashcards, c)));

  // quiz questions — main SRS-tracked practice items
  questionsFor = (noteId: string) =>
    this.store.where<QuizQuestion>(COLLECTIONS.quiz, { noteId });
  putQuestion = (q: QuizQuestion) => this.store.put(COLLECTIONS.quiz, q);
  putQuestions = (qs: QuizQuestion[]) =>
    Promise.all(qs.map((q) => this.store.put(COLLECTIONS.quiz, q)));
  allQuestions = () => this.store.all<QuizQuestion>(COLLECTIONS.quiz);
  questionsForTopic = (topic: string) =>
    this.store.where<QuizQuestion>(COLLECTIONS.quiz, { topic } as Partial<QuizQuestion>);
  questionsForClass = async (classId: string) => {
    const folders = await this.foldersForClass(classId);
    const notes = (
      await Promise.all(folders.map((f) => this.notesForFolder(f.id)))
    ).flat();
    const noteIds = notes.map((n) => n.id);
    const all = await this.store.all<QuizQuestion>(COLLECTIONS.quiz);
    return all.filter((q) => noteIds.includes(q.noteId));
  };
  questionsForClassAndTopic = async (classId: string, topic: string) => {
    const classQs = await this.questionsForClass(classId);
    return classQs.filter((q) => q.topic === topic);
  };
  topicsInUnit = async (folderId: string) => {
    const notes = await this.notesForFolder(folderId);
    const topicSet = new Set<string>();
    for (const n of notes) {
      if (n.topic) topicSet.add(n.topic);
    }
    return [...topicSet].sort();
  };
  notesForClass = async (classId: string) => {
    const folders = await this.foldersForClass(classId);
    return (await Promise.all(folders.map((f) => this.notesForFolder(f.id)))).flat();
  };

  // attempts
  attemptsFor = (noteId: string) =>
    this.store.where<QuizAttempt>(COLLECTIONS.attempts, { noteId });
  putAttempt = (a: QuizAttempt) => this.store.put(COLLECTIONS.attempts, a);
  resetQuiz = async (noteId: string) => {
    const rows = await this.attemptsFor(noteId);
    await Promise.all(
      rows.map((r) => this.store.delete(COLLECTIONS.attempts, r.id)),
    );
  };

  // activity events
  putActivityEvent = (e: ActivityEvent) =>
    this.store.put(COLLECTIONS.activityEvents, e);
  activityForClass = async (classId: string): Promise<ActivityEvent[]> => {
    const all = await this.store.all<ActivityEvent>(COLLECTIONS.activityEvents);
    return all
      .filter((e) => e.classId === classId)
      .sort((a, b) => b.at - a.at)
      .slice(0, 20);
  };

  // chat
  chatFor = async (noteId: string) =>
    (await this.store.where<ChatTurn>(COLLECTIONS.chat, { noteId })).sort(
      (a, b) => a.at - b.at,
    );
  putChat = (t: ChatTurn) => this.store.put(COLLECTIONS.chat, t);
  clearChat = async (noteId: string) => {
    const rows = await this.store.where<ChatTurn>(COLLECTIONS.chat, { noteId });
    await Promise.all(rows.map((r) => this.store.delete(COLLECTIONS.chat, r.id)));
  };

  // jobs
  listJobs = () => this.store.all<Job>(COLLECTIONS.jobs);
  putJob = (j: Job) => this.store.put(COLLECTIONS.jobs, j);
  activeJobs = async () =>
    (await this.store.all<Job>(COLLECTIONS.jobs)).filter(
      (j) => j.status === "running" || j.status === "queued",
    );

  // reminders
  listReminders = () => this.store.all<Reminder>(COLLECTIONS.reminders);
  putReminder = (r: Reminder) => this.store.put(COLLECTIONS.reminders, r);
  deleteReminder = (id: string) => this.store.delete(COLLECTIONS.reminders, id);
  remindersForClass = (classId: string) =>
    this.store.where<Reminder>(COLLECTIONS.reminders, { classId } as Partial<Reminder>);
}
