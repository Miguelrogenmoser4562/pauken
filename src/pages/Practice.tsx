/* Practice page: SRS-driven spaced repetition across a class.
   A top-level tab inside the AppShell. Pick a class, then study in
   algorithm mode (auto-suggested due items) or browse mode (by unit/topic).
   All FSRS state is per-user via UserProgress — never mutates shared questions. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Loader2,
  Settings2,
} from "lucide-react";
import { useApp } from "../lib/app";
import { reviewQuestion, bucketOf, type Rating_ } from "../lib/study/fsrs";
import { buildSession, buildCoStudySession, mergeUserProgress, type Session } from "../lib/study/session";
import { computeDiagnostics, diagnosticsByTopic, type ScopeDiagnostics } from "../lib/study/diagnostics";
import { uuid } from "../lib/ids";
import {
  DEFAULT_STUDY_DEFAULTS,
  type ClassEntity,
  type Folder,
  type QuizQuestion,
  type StudyDefaults,
  type PaukenUser,
  type ReviewLog,
  type UserProgress,
} from "../lib/types";
import type { ActivityEvent, Note } from "../lib/types";
import { StudyWsClient } from "../lib/ws";
import SourceCitation from "../components/SourceCitation";

export default function Practice() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { repo, user, prefs, bump, version } = useApp();
  const initialClassId = searchParams.get("class");

  /* ---- Class selection ---- */
  const [classes, setClasses] = useState<ClassEntity[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(initialClassId || null);
  const [selectedClass, setSelectedClass] = useState<ClassEntity | null>(null);

  /* ---- Mode ---- */
  const [mode, setMode] = useState<"algorithm" | "browse">("algorithm");

  /* ---- Browse selectors ---- */
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [availableTopics, setAvailableTopics] = useState<string[]>([]);

  /* ---- Questions + progress ---- */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allQuestions, setAllQuestions] = useState<QuizQuestion[]>([]);
  const [userProgress, setUserProgress] = useState<UserProgress[]>([]);
  const [reviewLogs, setReviewLogs] = useState<ReviewLog[]>([]);

  /* ---- Session ---- */
  const [session, setSession] = useState<Session | null>(null);
  const [sessionQueue, setSessionQueue] = useState<QuizQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [newCardsPerSession, setNewCardsPerSession] = useState(DEFAULT_STUDY_DEFAULTS.maxNewCardsPerSession);
  const [reviewMode, setReviewMode] = useState(false);

  /* ---- Co-study ---- */
  const [coStudyMode, setCoStudyMode] = useState<"off" | "same-device" | "synced">("off");
  const [coStudyPartner, setCoStudyPartner] = useState<PaukenUser | null>(null);
  const [classMembers, setClassMembers] = useState<PaukenUser[]>([]);
  const [partnerProgress, setPartnerProgress] = useState<UserProgress[]>([]);
  const [partnerReviewLogs, setPartnerReviewLogs] = useState<ReviewLog[]>([]);
  const [wsClient, setWsClient] = useState<StudyWsClient | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [joinSessionId, setJoinSessionId] = useState<string>("");
  const [partnerAnswer, setPartnerAnswer] = useState<number | null>(null);

  const current = sessionQueue[currentIndex] ?? null;
  const sessionTotal = session?.total ?? 0;
  const sessionDone = currentIndex >= sessionQueue.length && sessionQueue.length > 0;

  /* Merge questions with per-user FSRS progress. */
  const mergedQuestions = useMemo(
    () => mergeUserProgress(allQuestions, userProgress),
    [allQuestions, userProgress],
  );

  /* Filter questions for browse mode. */
  const browseQuestions = useMemo(() => {
    if (mode !== "browse") return mergedQuestions;
    let qs = mergedQuestions;
    if (selectedFolderId) {
      const folderNoteIds = new Set(notes.filter((n) => n.folderId === selectedFolderId).map((n) => n.id));
      qs = qs.filter((q) => folderNoteIds.has(q.noteId));
    }
    if (selectedTopic) {
      qs = qs.filter((q) => q.topic === selectedTopic);
    }
    return qs;
  }, [mergedQuestions, mode, selectedFolderId, selectedTopic, notes]);

  /* ---- Load classes ---- */
  useEffect(() => {
    if (!repo) return;
    repo.listClasses().then((cs) => {
      setClasses(cs);
      if (initialClassId && !selectedClassId) {
        setSelectedClassId(initialClassId);
      }
    });
  }, [repo]);

  /* ---- Load questions + progress when class changes ---- */
  useEffect(() => {
    if (!repo || !selectedClassId) {
      setAllQuestions([]);
      setUserProgress([]);
      setReviewLogs([]);
      setSelectedClass(null);
      setFolders([]);
      setAvailableTopics([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      const [cs, qs, fs, ns, prog, rls] = await Promise.all([
        repo.listClasses(),
        repo.questionsForClass(selectedClassId),
        repo.foldersForClass(selectedClassId),
        repo.notesForClass(selectedClassId),
        user?.id ? repo.listProgressForUser(user.id) : Promise.resolve([] as UserProgress[]),
        user?.id ? repo.reviewLogsForUser(user.id) : Promise.resolve([] as ReviewLog[]),
      ]);
      if (!alive) return;
      const c = cs.find((x) => x.id === selectedClassId);
      if (!c) { setError("Class not found."); setLoading(false); return; }
      setSelectedClass(c);
      setAllQuestions(qs);
      setFolders(fs);
      setNotes(ns);
      setUserProgress(prog);
      setReviewLogs(rls);

      /* Collect available topics */
      const topics = new Set(qs.map((q) => q.topic).filter(Boolean));
      setAvailableTopics([...topics].sort());

      /* Pre-select folder if only one */
      if (mode === "browse" && fs.length === 1) {
        setSelectedFolderId(fs[0].id);
      }

      setLoading(false);
    })();
    return () => { alive = false; };
  }, [repo, selectedClassId, user?.id]);

  /* Load class members for co-study. */
  useEffect(() => {
    if (!repo || !selectedClassId) { setClassMembers([]); return; }
    (async () => {
      const [members, users] = await Promise.all([
        repo.membersForClass(selectedClassId),
        repo.listUsers(),
      ]);
      if (!members || !users) return;
      const activeMembers = members.filter((m) => !m.status || m.status === "active");
      const userIds = new Set(activeMembers.map((m) => m.userId));
      setClassMembers(users.filter((u) => userIds.has(u.id) && u.id !== user?.id));
    })();
  }, [repo, selectedClassId, user, version]);

  /* Load partner progress + review logs for co-study. */
  useEffect(() => {
    if (!repo || !coStudyPartner) {
      setPartnerProgress([]);
      setPartnerReviewLogs([]);
      return;
    }
    Promise.all([
      repo.listProgressForUser(coStudyPartner.id),
      repo.reviewLogsForUser(coStudyPartner.id),
    ])
      .then(([prog, rls]) => {
        setPartnerProgress(prog);
        setPartnerReviewLogs(rls);
      })
      .catch(() => {});
  }, [repo, coStudyPartner]);

  /* WS message handlers for synced session. */
  useEffect(() => {
    if (!wsClient) return;
    const unsub = wsClient.onMessage((msg) => {
      switch (msg.type) {
        case "participant_joined":
          setSessionStatus("Partner joined!");
          break;
        case "both_answered": {
          const partner = msg.answers.find((a) => a.userId !== user?.id);
          if (partner) setPartnerAnswer(partner.answer);
          break;
        }
        case "next_question":
          setCurrentIndex(msg.index);
          setFlipped(false);
          setSelectedOption(null);
          setPartnerAnswer(null);
          break;
        case "session_ended":
          setSessionStatus("Session complete!");
          break;
        case "session_joined":
          setSessionStatus("Joined session");
          break;
      }
    });
    return unsub;
  }, [wsClient, user]);

  /* Rebuild session when questions or settings change. */
  useEffect(() => {
    const pool = mode === "browse" ? browseQuestions : mergedQuestions;
    if (pool.length === 0) return;
    const defaults: StudyDefaults = {
      retentionTarget: selectedClass?.retentionTarget ?? DEFAULT_STUDY_DEFAULTS.retentionTarget,
      maxReviewsPerItemPerWeek: DEFAULT_STUDY_DEFAULTS.maxReviewsPerItemPerWeek,
      maxNewCardsPerSession: newCardsPerSession,
    };

    let s: Session;
    if (coStudyMode === "same-device" && coStudyPartner && partnerProgress.length + userProgress.length > 0) {
      s = buildCoStudySession(
        pool,
        defaults,
        userProgress,
        partnerProgress,
        reviewLogs,
        partnerReviewLogs,
      );
    } else {
      s = buildSession(pool, defaults, undefined, undefined, reviewLogs);
    }
    setSession(s);
    if (!reviewMode) {
      setSessionQueue([...s.due, ...s.newItems]);
    }
    setCurrentIndex(0);
    setFlipped(false);
    setSelectedOption(null);
  }, [mergedQuestions, browseQuestions, newCardsPerSession, reviewMode, selectedClass, coStudyMode, coStudyPartner, userProgress, partnerProgress, reviewLogs, partnerReviewLogs, mode]);

  const diagnostics: ScopeDiagnostics | null = useMemo(
    () => {
      const pool = mode === "browse" ? browseQuestions : mergedQuestions;
      return pool.length > 0 ? computeDiagnostics(pool) : null;
    },
    [mergedQuestions, browseQuestions, mode],
  );

  /* ---- handleRate: apply rating, save to UserProgress (never mutate shared question) ---- */
  const handleRate = useCallback(async (rating: Rating_, forUserId?: string, noAdvance?: boolean) => {
    if (!current || !repo) return;
    const nowMs = Date.now();

    /* Compute existing progress (or use question defaults). */
    const existingProg = userProgress.find((p) => p.questionId === current.id);
    const baseQuestion = existingProg
      ? { ...current, ...existingProg, reps: existingProg.reps, lapses: existingProg.lapses, state: existingProg.state }
      : current;
    const updated = reviewQuestion(baseQuestion, rating, nowMs, selectedClass?.examDate);

    /* Save per-user progress. */
    const progressId = existingProg?.id || `${user?.id}-${current.id}`;
    const prog: UserProgress = {
      id: progressId,
      userId: forUserId || user?.id || "",
      questionId: current.id,
      state: updated.state,
      due: updated.due,
      stability: updated.stability,
      fsrsDifficulty: updated.fsrsDifficulty,
      reps: updated.reps,
      lapses: updated.lapses,
      lastReview: updated.lastReview,
      firstExposedAt: updated.firstExposedAt ?? current.firstExposedAt,
    };
    await repo.putProgress(prog);

    if (forUserId && forUserId === user?.id || !forUserId) {
      setUserProgress((prev) => {
        const rest = prev.filter((p) => p.questionId !== current.id);
        return [...rest, prog];
      });
    }
    if (forUserId && coStudyPartner && forUserId === coStudyPartner.id) {
      setPartnerProgress((prev) => {
        const rest = prev.filter((p) => p.questionId !== current.id);
        return [...rest, prog];
      });
    }

    /* Write review log. */
    const stateBefore = existingProg
      ? { state: existingProg.state, due: existingProg.due, stability: existingProg.stability, fsrsDifficulty: existingProg.fsrsDifficulty, reps: existingProg.reps, lapses: existingProg.lapses }
      : { state: current.state, due: current.due, stability: current.stability, fsrsDifficulty: current.fsrsDifficulty, reps: current.reps, lapses: current.lapses };
    const reviewLog: ReviewLog = {
      id: uuid(),
      userId: forUserId || user?.id,
      questionId: current.id,
      rating,
      stateBefore,
      stateAfter: {
        state: updated.state,
        due: updated.due,
        stability: updated.stability,
        fsrsDifficulty: updated.fsrsDifficulty,
        reps: updated.reps,
        lapses: updated.lapses,
      },
      at: nowMs,
    };
    await repo.putReviewLog(reviewLog);
    if (forUserId && forUserId === user?.id || !forUserId) {
      setReviewLogs((prev) => [...prev, reviewLog]);
    }
    if (forUserId && coStudyPartner && forUserId === coStudyPartner.id) {
      setPartnerReviewLogs((prev) => [...prev, reviewLog]);
    }

    /* Save quiz attempt. */
    const attempt = {
      id: uuid(),
      noteId: current.noteId,
      questionId: current.id,
      userId: forUserId || user?.id,
      topic: current.topic,
      correct: rating === "good" || rating === "easy",
      at: nowMs,
    };
    await repo.putAttempt(attempt);

    /* Activity event for partner. */
    if (forUserId && forUserId !== user?.id && selectedClassId) {
      const ev: ActivityEvent = {
        id: uuid(),
        classId: selectedClassId,
        userId: forUserId,
        userName: coStudyPartner?.name || "Partner",
        type: "attempt",
        details: `${rating === "good" || rating === "easy" ? "Answered correctly" : "Got wrong"} on "${current.topic}"`,
        at: nowMs,
      };
      await repo.putActivityEvent(ev);
    }

    if (!noAdvance) {
      setCurrentIndex((i) => i + 1);
      setFlipped(false);
      setSelectedOption(null);
    }
    bump();
  }, [current, repo, selectedClass, user, coStudyPartner, userProgress, selectedClassId, bump]);

  /* Co-study same-device: rate for both users. */
  const handleCoStudyRate = useCallback(async (rating: Rating_) => {
    if (!current || !repo || !coStudyPartner) return;
    await handleRate(rating, user?.id);
    await handleRate(rating, coStudyPartner.id);
  }, [current, repo, coStudyPartner, user, handleRate]);

  const handleStudyAgain = useCallback(() => {
    const pool = mode === "browse" ? browseQuestions : mergedQuestions;
    setReviewMode(true);
    setSessionQueue([...pool].sort(() => Math.random() - 0.5));
    setCurrentIndex(0);
    setFlipped(false);
    setSelectedOption(null);
  }, [mergedQuestions, browseQuestions, mode]);

  /* ---- Class selector ---- */
  function handleClassChange(id: string) {
    setSelectedClassId(id || null);
    setSelectedFolderId(null);
    setSelectedTopic(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-8 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <AlertCircle className="size-10 text-danger-ink" />
        <p className="text-lg font-semibold text-danger-ink">{error}</p>
        <button
          onClick={() => navigate("/")}
          className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-edge px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink"
          >
            <ArrowLeft className="size-4" />
            Dashboard
          </button>

          {/* Class selector */}
          <select
            value={selectedClassId || ""}
            onChange={(e) => handleClassChange(e.target.value)}
            className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim outline-none"
          >
            <option value="">Select a class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          {selectedClassId && (
            <div className="flex rounded-lg border border-edge overflow-hidden">
              <button
                onClick={() => setMode("algorithm")}
                className={`px-3 py-1.5 text-xs font-bold transition ${
                  mode === "algorithm" ? "bg-accent text-white" : "bg-panel text-ink-dim hover:bg-card-hover"
                }`}
              >
                Algorithm
              </button>
              <button
                onClick={() => setMode("browse")}
                className={`px-3 py-1.5 text-xs font-bold transition ${
                  mode === "browse" ? "bg-accent text-white" : "bg-panel text-ink-dim hover:bg-card-hover"
                }`}
              >
                Browse
              </button>
            </div>
          )}

          {diagnostics && (
            <span className="rounded-full bg-accent-softer px-3 py-1 text-xs font-bold text-accent">
              {diagnostics.matureQuestions}/{diagnostics.totalQuestions} mature
            </span>
          )}

          {/* Co-study selector */}
          <select
            value={coStudyMode}
            onChange={(e) => {
              const m = e.target.value as "off" | "same-device" | "synced";
              setCoStudyMode(m);
              if (m !== "same-device") setCoStudyPartner(null);
            }}
            className="rounded-lg border border-edge bg-panel px-2 py-1 text-xs font-semibold text-ink-dim outline-none"
          >
            <option value="off">Solo</option>
            <option value="same-device">Co-study (same device)</option>
            {prefs.serverUrl && <option value="synced">Synced session</option>}
          </select>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className="rounded-lg p-1.5 text-ink-faint hover:bg-card-hover hover:text-ink"
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex flex-1 flex-col items-center px-8 py-6">
          {/* No class selected */}
          {!selectedClassId && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <BookOpen className="size-12 text-ink-faint" />
              <p className="font-display text-xl font-bold text-ink-dim">Select a class to practice</p>
              <p className="max-w-sm text-center text-sm text-ink-faint">
                Pick a class from the dropdown above to start studying. Algorithm mode
                surfaces what you need most; Browse mode lets you pick a unit or topic.
              </p>
            </div>
          )}

          {/* Session settings */}
          {selectedClassId && showSettings && (
            <div className="mb-6 w-full max-w-lg rounded-card border border-edge bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-bold">Session settings</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-xs text-ink-faint hover:text-ink"
                >
                  Done
                </button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs font-semibold text-ink-faint">
                    New cards per session: {newCardsPerSession}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    value={newCardsPerSession}
                    onChange={(e) => setNewCardsPerSession(Number(e.target.value))}
                    className="mt-1 w-full accent-accent"
                  />
                </div>
                <p className="text-xs text-ink-faint">
                  Due: {session?.due.length ?? 0} · New: {session?.newItems.length ?? 0} ·
                  Cap: {newCardsPerSession}/session
                </p>
              </div>
            </div>
          )}

          {/* Browse mode selectors */}
          {selectedClassId && mode === "browse" && (
            <div className="mb-6 flex flex-wrap items-center gap-4">
              <select
                value={selectedFolderId || ""}
                onChange={(e) => setSelectedFolderId(e.target.value || null)}
                className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim outline-none"
              >
                <option value="">All units</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <select
                value={selectedTopic || ""}
                onChange={(e) => setSelectedTopic(e.target.value || null)}
                className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim outline-none"
              >
                <option value="">All topics</option>
                {availableTopics.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              {session && (
                <span className="text-xs font-semibold text-ink-faint">
                  {sessionQueue.length} questions
                </span>
              )}
            </div>
          )}

          {/* No questions state */}
          {selectedClassId && allQuestions.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <BookOpen className="size-12 text-ink-faint" />
              <p className="font-display text-xl font-bold text-ink-dim">No practice questions yet</p>
              <p className="max-w-sm text-sm text-ink-faint">
                Create notes in this class to auto-generate questions and start practicing.
              </p>
              <button
                onClick={() => navigate("/")}
                className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white"
              >
                Back to Dashboard
              </button>
            </div>
          )}

          {/* Session complete */}
          {sessionDone && (
            <div className="flex flex-col items-center gap-4 text-center">
              <BarChart3 className="size-12 text-accent" />
              <p className="font-display text-2xl font-bold">Session complete</p>
              <p className="text-ink-dim">
                Reviewed {currentIndex} question{currentIndex !== 1 ? "s" : ""}.
                {session && session.due.length > 0 && ` ${session.due.length} still due.`}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleStudyAgain}
                  className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white hover:bg-accent-hover"
                >
                  Study all
                </button>
                <button
                  onClick={() => navigate("/")}
                  className="rounded-xl border border-edge px-6 py-2.5 font-semibold text-ink-dim hover:bg-card-hover"
                >
                  Dashboard
                </button>
              </div>
            </div>
          )}

          {/* Active question */}
          {current && !sessionDone && (
            <div className="flex w-full max-w-2xl flex-col items-center">
              {/* Co-study partner selector */}
              {coStudyMode === "same-device" && (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-edge bg-card px-4 py-2">
                  <span className="text-xs font-semibold text-ink-faint">Studying with:</span>
                  <select
                    value={coStudyPartner?.id ?? ""}
                    onChange={(e) => {
                      const partner = classMembers.find((m) => m.id === e.target.value);
                      setCoStudyPartner(partner ?? null);
                    }}
                    className="rounded-lg border border-edge bg-panel px-2 py-1 text-xs font-semibold text-ink-dim outline-none"
                  >
                    <option value="">Select partner</option>
                    {classMembers.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Synced session controls */}
              {coStudyMode === "synced" && (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-card px-4 py-2">
                  <span className="text-xs font-semibold text-ink-faint">
                    {sessionStatus || "Synced session"}
                  </span>
                  {!wsClient?.connected && (
                    <>
                      <button
                        onClick={async () => {
                          const base = prefs.serverUrl || `http://localhost:${window.location.port || 4180}`;
                          const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
                          const wsUrl = `${wsBase}/ws`;
                          const client = new StudyWsClient(wsUrl);
                          try {
                            await client.connect();
                            setWsClient(client);
                            setSessionStatus("Connected");
                            const sid = await client.createSession(selectedClassId!, sessionQueue.map((q) => q.id));
                            setSessionId(sid);
                            setSessionStatus(`Session created: ${sid.slice(0, 8)}...`);
                          } catch {
                            setSessionStatus("Connection failed");
                          }
                        }}
                        className="rounded-lg bg-accent px-3 py-1 text-xs font-bold text-white"
                      >
                        Start session
                      </button>
                      <div className="flex items-center gap-1">
                        <input
                          value={joinSessionId}
                          onChange={(e) => setJoinSessionId(e.target.value)}
                          placeholder="Session ID"
                          className="w-28 rounded border border-edge bg-panel px-2 py-1 text-xs text-ink outline-none"
                        />
                        <button
                          onClick={async () => {
                            if (!joinSessionId) return;
                            const base = prefs.serverUrl || `http://localhost:${window.location.port || 4180}`;
                            const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
                            const wsUrl = `${wsBase}/ws`;
                            const client = new StudyWsClient(wsUrl);
                            try {
                              await client.connect();
                              setWsClient(client);
                              await client.joinSession(joinSessionId, user?.id || "anon", user?.name || "Anonymous");
                              setSessionStatus("Joined session!");
                            } catch {
                              setSessionStatus("Failed to join session");
                            }
                          }}
                          className="rounded-lg border border-edge px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-card-hover"
                        >
                          Join
                        </button>
                      </div>
                    </>
                  )}
                  {wsClient?.connected && sessionId && (
                    <span className="text-xs text-ink-faint">ID: {sessionId.slice(0, 8)}...</span>
                  )}
                  {wsClient?.connected && (
                    <span className="text-xs text-green-600">Live</span>
                  )}
                  {partnerAnswer !== null && (
                    <span className="text-xs font-semibold text-accent">
                      Partner locked in
                    </span>
                  )}
                </div>
              )}

              {/* Progress indicator */}
              <p className="mb-4 text-sm font-semibold text-ink-faint">
                {reviewMode
                  ? `Review ${currentIndex + 1} of ${sessionQueue.length}`
                  : currentIndex < (session?.due.length ?? 0)
                    ? `Review ${currentIndex + 1} of ${sessionTotal}`
                    : `New ${currentIndex - (session?.due.length ?? 0) + 1} of ${session?.newItems.length ?? 0}`
                }
              </p>

              {/* Question card */}
              <div className="w-full rounded-2xl border border-edge bg-card p-8 shadow-soft">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Question
                </span>
                <p className="mt-2 font-display text-xl font-semibold text-ink">
                  {current.question}
                </p>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {current.options.map((opt, i) => {
                    let cls = "border-edge bg-panel hover:bg-card-hover";
                    if (selectedOption !== null) {
                      if (i === current.correctIndex) {
                        cls = "border-transparent bg-success-soft text-ink";
                      } else if (i === selectedOption) {
                        cls = "border-transparent bg-danger-soft text-danger-ink";
                      } else {
                        cls = "border-edge bg-panel text-ink-faint opacity-60";
                      }
                    }
                    /* Highlight partner's answer in synced mode. */
                    if (partnerAnswer !== null && partnerAnswer === i && selectedOption === null) {
                      cls = cls + " ring-2 ring-accent";
                    }
                    return (
                      <button
                        key={i}
                        disabled={selectedOption !== null}
                        onClick={() => {
                          setSelectedOption(i);
                          setFlipped(true);
                        }}
                        className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${cls}`}
                      >
                        <span className="mr-2 font-bold text-ink-faint">
                          {String.fromCharCode(65 + i)}.
                        </span>
                        {opt}
                      </button>
                    );
                  })}
                </div>

                {partnerAnswer !== null && selectedOption === null && (
                  <p className="mt-3 text-xs text-accent font-semibold">
                    Your partner has locked in their answer. Choose yours!
                  </p>
                )}

                {selectedOption !== null && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl bg-accent-softer p-4 text-sm text-ink-dim">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`font-bold ${selectedOption === current.correctIndex ? "text-green-700" : "text-red-700"}`}>
                          {selectedOption === current.correctIndex ? "Correct" : "Incorrect"}
                        </span>
                        {partnerAnswer !== null && (
                          <span className="text-xs text-ink-faint">
                            (Partner chose {String.fromCharCode(65 + partnerAnswer)})
                          </span>
                        )}
                      </div>
                      {current.explanation && (
                        <p className="text-ink-dim mt-1">
                          <span className="font-bold text-ink">Explanation: </span>
                          {current.explanation}
                        </p>
                      )}
                      {current.sourcePassage && (
                        <SourceCitation
                          passage={current.sourcePassage}
                          noteId={current.noteId}
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-ink-faint">
                      <span>Topic: {current.topic}</span>
                      <span>·</span>
                      <span>Bucket: {bucketOf(
                        userProgress.find((p) => p.questionId === current.id)
                          ? { ...current, ...userProgress.find((p) => p.questionId === current.id)! }
                          : current
                      )}</span>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => setFlipped(!flipped)}
                  className="mt-2 text-xs text-ink-faint hover:text-ink"
                >
                  {flipped ? "Hide answer" : "Reveal answer"}
                </button>
              </div>

              {/* Rating buttons */}
              {selectedOption !== null && (
                <div className="mt-6 grid w-full grid-cols-4 gap-3">
                  {([["again", "Again", "bg-danger-soft text-danger-ink hover:opacity-90"],
                    ["hard", "Hard", "bg-callout-bg text-callout-ink hover:opacity-90"],
                    ["good", "Good", "bg-accent-soft text-ink hover:opacity-90"],
                    ["easy", "Easy", "bg-success-soft text-ink hover:opacity-90"],
                  ] as [Rating_, string, string][]).map(([rating, label, cls]) => (
                    <button
                      key={rating}
                      onClick={async () => {
                        if (coStudyMode === "same-device" && coStudyPartner) {
                          await handleCoStudyRate(rating);
                        } else if (coStudyMode === "synced" && wsClient?.connected) {
                          await handleRate(rating, user?.id, true);
                          wsClient.lockAnswer(selectedOption!);
                          setSessionStatus("Answer locked in, waiting for partner...");
                        } else {
                          await handleRate(rating, user?.id);
                        }
                      }}
                      className={`rounded-xl px-4 py-2.5 font-display text-sm font-bold transition ${cls}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Skip button */}
              {selectedOption === null && (
                <button
                  onClick={() => { setCurrentIndex((i) => i + 1); setFlipped(false); setSelectedOption(null); }}
                  className="mt-4 text-sm text-ink-faint hover:text-ink"
                >
                  Skip this question
                </button>
              )}
            </div>
          )}
        </div>

        {/* Diagnostics sidebar */}
        <aside className="hidden w-72 shrink-0 border-l border-edge bg-card p-5 lg:block overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-ink">Diagnostics</h2>
          </div>

          {diagnostics && (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg bg-panel p-3">
                <p className="text-xs font-semibold text-ink-faint">Maturity</p>
                <p className="mt-1 font-display text-lg font-bold">
                  {diagnostics.matureQuestions}
                  <span className="text-sm font-normal text-ink-faint">
                    /{diagnostics.totalQuestions} questions
                  </span>
                </p>
              </div>

              <div className="rounded-lg bg-panel p-3">
                <p className="text-xs font-semibold text-ink-faint">Lapse ratio</p>
                <p className={`mt-1 font-display text-lg font-bold ${
                  diagnostics.lapseRatio > 0.3 ? "text-danger-ink" : "text-green-600"
                }`}>
                  {(diagnostics.lapseRatio * 100).toFixed(0)}%
                </p>
              </div>

              <div className="rounded-lg bg-panel p-3">
                <p className="text-xs font-semibold text-ink-faint">Weak topics</p>
                {diagnostics.weakQuestions.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-faint">None</p>
                ) : (
                  <p className="mt-1 font-display text-lg font-bold text-danger-ink">
                    {diagnostics.weakQuestions.length}
                  </p>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-ink-faint">By topic</p>
                <div className="space-y-2">
                  {(() => {
                    const pool = mode === "browse" ? browseQuestions : mergedQuestions;
                    const byTopic = diagnosticsByTopic(pool);
                    return [...byTopic.entries()].map(([topic, d]) => {
                      const pct = d.matureQuestions / Math.max(1, d.totalQuestions);
                      return (
                        <div key={topic}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="truncate text-ink-dim">{topic}</span>
                            <span className="text-ink-faint">
                              {d.matureQuestions}/{d.totalQuestions}
                            </span>
                          </div>
                          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-panel">
                            <div
                              className={`h-full rounded-full ${
                                pct >= 0.8 ? "bg-green-500" : pct >= 0.5 ? "bg-amber-500" : "bg-red-500"
                              }`}
                              style={{ width: `${pct * 100}%` }}
                            />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}

          {!diagnostics && (
            <p className="mt-4 text-sm text-ink-faint">No data yet.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
