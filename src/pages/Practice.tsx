/* Practice page: SRS-driven spaced repetition across a class.
   A top-level tab inside the AppShell. Pick a class, then study in
   algorithm mode (auto-suggested due items) or browse mode (by unit/topic).
   All FSRS state is per-user via UserProgress — never mutates shared questions. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Eye,
  EyeOff,
  ListChecks,
  Loader2,
  Lock,
  LockOpen,
  Settings2,
  Users,
} from "lucide-react";
import { deduplicateTopics, normalizeTopic } from "../lib/topics";
import { useApp } from "../lib/app";
import { reviewQuestion, bucketOf, type Rating_ } from "../lib/study/fsrs";
import { buildSession, buildCoStudySession, mergeUserProgress, type Session } from "../lib/study/session";
import { computeDiagnostics, diagnosticsByTopic, type ScopeDiagnostics } from "../lib/study/diagnostics";
import { uuid } from "../lib/ids";
import {
  DEFAULT_STUDY_DEFAULTS,
  type ClassEntity,
  type CoStudySession,
  type Folder,
  type QuizQuestion,
  type ScreenMode,
  type StudyDefaults,
  type PaukenUser,
  type ReviewLog,
  type UserProgress,
} from "../lib/types";
import type { ActivityEvent, Note } from "../lib/types";
import { StudyWsClient } from "../lib/ws";
import { syncSessionStore } from "../lib/sync/sessionStore";
import SourceCitation from "../components/SourceCitation";
import OptionList, { type OptionPick } from "../components/OptionList";

/* Last class used in the solo practice flow — pre-selected on the start
   screen so "Continue" needs no extra clicks (change #3). */
const LAST_CLASS_KEY = "pauken.lastclass";

/* Sentinel value for the synced unit-filter dropdown: SRS-paced mode.
   The algorithm composes the shared queue (due first, all NEW, no cap);
   any other selection (a real unit, or "" = All units) is browse mode,
   which shows the full pool of questions in scope. */
const SYNC_ALGORITHM = "__algorithm__";

function readLastClassId(): string | null {
  try {
    return localStorage.getItem(LAST_CLASS_KEY);
  } catch {
    return null;
  }
}

function writeLastClassId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_CLASS_KEY, id);
    else localStorage.removeItem(LAST_CLASS_KEY);
  } catch {
    /* storage unavailable (private mode) — not fatal */
  }
}

export default function Practice() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { repo, user, prefs, savePrefs, bump, version } = useApp();
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
  const [coStudyMode, setCoStudyMode] = useState<"off" | "same-device" | "synced">(
    /* Auto-return to a live session after an app restart (change #3). */
    syncSessionStore.getIdentity() ? "synced" : "off",
  );
  const [coStudyPartner, setCoStudyPartner] = useState<PaukenUser | null>(null);
  const [classMembers, setClassMembers] = useState<PaukenUser[]>([]);
  const [partnerProgress, setPartnerProgress] = useState<UserProgress[]>([]);
  const [partnerReviewLogs, setPartnerReviewLogs] = useState<ReviewLog[]>([]);
  const [wsClient, setWsClient] = useState<StudyWsClient | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("");
  const [joinCode, setJoinCode] = useState<string>("");
  const [partnerAnswer, setPartnerAnswer] = useState<number | null>(null);

  /* ---- Synced session flow ---- */
  const [syncPhase, setSyncPhase] = useState<"lobby" | "waiting" | "studying">("lobby");
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [partnerUser, setPartnerUser] = useState<PaukenUser | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [eliminated, setEliminated] = useState<Set<number>>(new Set());
  const [pendingQueueIds, setPendingQueueIds] = useState<string[] | null>(null);
  const [switchedForSync, setSwitchedForSync] = useState(false);
  const [startWaitStartedAt, setStartWaitStartedAt] = useState<number | null>(null);
  /* QuestionIds already auto-rated in this session — per question, so going
     back and forth never rates a question twice (change #4). */
  const ratedIdsRef = useRef<Set<string>>(new Set());
  const sessionLenRef = useRef(0);

  /* Entry hub: shown before any study starts (solo Continue / synced create /
     join). Skipped when a live session identity exists (auto-rejoin). */
  const [showStart, setShowStart] = useState<boolean>(() => !syncSessionStore.getIdentity());
  /* Connection state of the shared WS client, for the reconnection UX. */
  const [connState, setConnState] = useState<"connected" | "reconnecting">("connected");
  /* Class picked in the synced-create picker (auto-creates on select). */
  const [syncLobbyClass, setSyncLobbyClass] = useState<string>("");
  /* True for the session creator — only they rebuild the shared queue. */
  const [amCreator, setAmCreator] = useState(false);
  /* Partner's FSRS state, retained so the creator can rebuild the combined
     queue mid-session (re-filtering). */
  const [syncedPartnerProgress, setSyncedPartnerProgress] = useState<UserProgress[]>([]);
  const [syncedPartnerReviewLogs, setSyncedPartnerReviewLogs] = useState<ReviewLog[]>([]);
  /* Question browser + re-filter panel in the synced study view. */
  const [showSessionBrowser, setShowSessionBrowser] = useState(false);

  /* Lock model: a single click only stores the pick (sent live to the
     partner); a double-click or the lock button LOCKs it in. */
  const [myLocked, setMyLocked] = useState(false);
  const [partnerLocked, setPartnerLocked] = useState(false);
  const lastClickRef = useRef<{ index: number; at: number } | null>(null);

  /* Screen-follow modes: "follow" (default), "not-follow", "independent". */
  const [screenMode, setScreenMode] = useState<ScreenMode>("follow");
  const [partnerScreenMode, setPartnerScreenMode] = useState<ScreenMode>("follow");
  const [sharedIndex, setSharedIndex] = useState(0);

  /* Browse filters for the synced create panel (#8). Defaults to the
     algorithm sentinel so every new session starts in SRS-paced mode. */
  const [syncFolderId, setSyncFolderId] = useState<string | null>(SYNC_ALGORITHM);
  const [syncTopic, setSyncTopic] = useState<string | null>(null);

  /* Latest full session snapshot received from the server (rejoin /
     navigate); applied once the local questions for the class are loaded. */
  const [sessionStateResume, setSessionStateResume] = useState<CoStudySession | null>(null);

  /* My view is detached from the shared position (partner navigated while I
     am not-follow/independent). */
  const diverged = currentIndex !== sharedIndex;

  const current = sessionQueue[currentIndex] ?? null;
  const sessionTotal = session?.total ?? 0;
  const sessionDone = currentIndex >= sessionQueue.length && sessionQueue.length > 0;

  /* Merge questions with per-user FSRS progress. */
  const mergedQuestions = useMemo(
    () => mergeUserProgress(allQuestions, userProgress),
    [allQuestions, userProgress],
  );

  /* Session defaults shared by local builds and the combined sync queue. */
  const studyDefaults = useMemo<StudyDefaults>(() => ({
    retentionTarget: selectedClass?.retentionTarget ?? DEFAULT_STUDY_DEFAULTS.retentionTarget,
    maxReviewsPerItemPerWeek: DEFAULT_STUDY_DEFAULTS.maxReviewsPerItemPerWeek,
    maxNewCardsPerSession: newCardsPerSession,
  }), [selectedClass, newCardsPerSession]);

  /* Review logs from the last 7 days — enough for the weekly cap, small payload. */
  const recentLogs = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    return reviewLogs.filter((r) => r.at >= weekAgo);
  }, [reviewLogs]);

  /* Filter questions for browse mode. */
  const browseQuestions = useMemo(() => {
    if (mode !== "browse") return mergedQuestions;
    let qs = mergedQuestions;
    if (selectedFolderId) {
      const folderNoteIds = new Set(notes.filter((n) => n.folderId === selectedFolderId).map((n) => n.id));
      qs = qs.filter((q) => folderNoteIds.has(q.noteId));
    }
    if (selectedTopic) {
      const key = normalizeTopic(selectedTopic);
      qs = qs.filter((q) => q.topic && normalizeTopic(q.topic) === key);
    }
    return qs;
  }, [mergedQuestions, mode, selectedFolderId, selectedTopic, notes]);

  const availableTopics = useMemo(() => {
    let topicQuestions: QuizQuestion[];
    if (selectedFolderId) {
      const folderNoteIds = new Set(notes.filter((n) => n.folderId === selectedFolderId).map((n) => n.id));
      topicQuestions = allQuestions.filter((q) => folderNoteIds.has(q.noteId));
    } else {
      topicQuestions = allQuestions;
    }
    return deduplicateTopics(topicQuestions.map((q) => q.topic).filter(Boolean));
  }, [selectedFolderId, allQuestions, notes]);

  /* Filtered question pool for synced-session creation (#8). The sentinel
     means algorithm mode: the pool is the whole (optionally topic-scoped)
     class, and session composition applies the SRS pacing. */
  const syncPool = useMemo(() => {
    let qs = mergedQuestions;
    if (syncFolderId && syncFolderId !== SYNC_ALGORITHM) {
      const folderNoteIds = new Set(notes.filter((n) => n.folderId === syncFolderId).map((n) => n.id));
      qs = qs.filter((q) => folderNoteIds.has(q.noteId));
    }
    if (syncTopic) {
      const key = normalizeTopic(syncTopic);
      qs = qs.filter((q) => q.topic && normalizeTopic(q.topic) === key);
    }
    return qs;
  }, [mergedQuestions, syncFolderId, syncTopic, notes]);

  const syncTopics = useMemo(() => {
    let topicQuestions = allQuestions;
    if (syncFolderId && syncFolderId !== SYNC_ALGORITHM) {
      const folderNoteIds = new Set(notes.filter((n) => n.folderId === syncFolderId).map((n) => n.id));
      topicQuestions = allQuestions.filter((q) => folderNoteIds.has(q.noteId));
    }
    return deduplicateTopics(topicQuestions.map((q) => q.topic).filter(Boolean));
  }, [syncFolderId, allQuestions, notes]);

  /* ---- Load classes ---- */
  useEffect(() => {
    if (!repo) return;
    repo.listClasses().then((cs) => {
      setClasses(cs);
      if (initialClassId && !selectedClassId) {
        setSelectedClassId(initialClassId);
      } else if (!selectedClassId && cs.length > 0) {
        /* Pre-select the last-used class so Continue is one click. */
        const last = readLastClassId();
        if (last && cs.some((c) => c.id === last)) setSelectedClassId(last);
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

  /* Rebuild the shared queue with a new unit/topic filter (change #2). Only
     the creator has both users' FSRS state, so only they build; the joiner
     sends a request_rebuild and the server relays it here. */
  /* Compose the shared synced queue for a filtered pool.
     Algorithm mode (sentinel): SRS-paced — due questions first, then ALL
     NEW questions (no per-session cap, so the whole unit is reachable).
     Browse mode (unit or All units): the full pool as-is. */
  const buildSyncedQueue = useCallback(
    (pool: QuizQuestion[], folderId: string | null, progressOverride?: UserProgress[], reviewLogsOverride?: ReviewLog[]): QuizQuestion[] => {
      if (folderId !== SYNC_ALGORITHM) return pool;
      let s = buildCoStudySession(
        pool,
        studyDefaults,
        userProgress,
        progressOverride ?? syncedPartnerProgress,
        recentLogs,
        reviewLogsOverride ?? syncedPartnerReviewLogs,
        undefined,
        pool.length,
      );
      let items = [...s.due, ...s.newItems];
      if (items.length === 0) {
        s = buildSession(pool, studyDefaults, undefined, undefined, recentLogs, pool.length);
        items = [...s.due, ...s.newItems];
      }
      return items;
    },
    [studyDefaults, userProgress, syncedPartnerProgress, recentLogs, syncedPartnerReviewLogs],
  );

  const rebuildQueue = useCallback(
    (folderId: string | null, topic: string | null, progressOverride?: UserProgress[], reviewLogsOverride?: ReviewLog[]) => {
      if (coStudyMode !== "synced" || !wsClient) return;
      setSyncFolderId(folderId);
      setSyncTopic(topic);
      let pool = mergedQuestions;
      if (folderId && folderId !== SYNC_ALGORITHM) {
        const folderNoteIds = new Set(notes.filter((n) => n.folderId === folderId).map((n) => n.id));
        pool = pool.filter((q) => folderNoteIds.has(q.noteId));
      }
      if (topic) {
        const key = normalizeTopic(topic);
        pool = pool.filter((q) => q.topic && normalizeTopic(q.topic) === key);
      }
      const ids = buildSyncedQueue(pool, folderId, progressOverride, reviewLogsOverride).map((q) => q.id);
      if (ids.length === 0) {
        setSessionStatus("No questions to study in this unit");
        return;
      }
      setPendingQueueIds(ids);
      wsClient.setSessionQueue(ids, { folderIds: folderId ? [folderId] : [], topic: topic ?? undefined });
    },
    [coStudyMode, wsClient, mergedQuestions, notes, buildSyncedQueue],
  );

  /* Randomize the shared queue (browse mode only, creator). */
  const handleShuffleQueue = useCallback(() => {
    if (coStudyMode !== "synced" || !wsClient || !amCreator) return;
    const ids = [...sessionQueue]
      .map((q) => ({ q, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .map(({ q }) => q.id);
    if (ids.length === 0) return;
    setPendingQueueIds(ids);
    wsClient.setSessionQueue(ids, { folderIds: syncFolderId ? [syncFolderId] : [], topic: syncTopic ?? undefined });
  }, [coStudyMode, wsClient, amCreator, sessionQueue, syncFolderId, syncTopic]);

  /* Unit/topic re-filter in the synced study view: the creator rebuilds
     locally, the joiner asks the creator to rebuild. */
  const handleSyncFilterChange = useCallback(
    (folderId: string | null, topic: string | null) => {
      setSyncFolderId(folderId);
      setSyncTopic(topic);
      if (coStudyMode !== "synced" || !wsClient) return;
      if (amCreator) {
        rebuildQueue(folderId, topic);
      } else {
        wsClient.requestRebuild(folderId ? [folderId] : [], topic ?? undefined, userProgress, recentLogs);
      }
    },
    [coStudyMode, wsClient, amCreator, rebuildQueue, userProgress, recentLogs],
  );

  /* Reconnection UX (change #6): surface drops/reconnects of the shared WS
     client so a silent stall shows as a "Reconnecting…" indicator. */
  useEffect(() => {
    if (!wsClient) {
      setConnState("connected");
      return;
    }
    const fn = (connected: boolean) => setConnState(connected ? "connected" : "reconnecting");
    wsClient.setConnectionStateHandler(fn);
    fn(wsClient.connected);
    return () => wsClient.setConnectionStateHandler(null);
  }, [wsClient]);

  /* WS message handlers for synced session. */
  useEffect(() => {
    if (!wsClient) return;
    const unsub = wsClient.onMessage((msg) => {
      switch (msg.type) {
        case "participant_joined": {
          setSessionStatus("Partner joined — building combined session…");
          const p = classMembers.find((m) => m.id === msg.participant.userId);
          setPartnerUser(p ?? { id: msg.participant.userId, name: msg.participant.userName || "Partner", key: "" });
          /* Retain the partner's FSRS state so the queue can be rebuilt
             mid-session when the unit/topic filter changes (change #2). */
          setSyncedPartnerProgress(msg.progress ?? []);
          setSyncedPartnerReviewLogs(msg.reviewLogs ?? []);
          /* Creator builds the combined queue from both users' FSRS state,
             within the filtered pool (change #8). */
          const ids = buildSyncedQueue(syncPool, syncFolderId, msg.progress ?? [], msg.reviewLogs ?? []).map((q) => q.id);
          if (ids.length === 0) {
            setSessionStatus("No questions to study in this session");
            break;
          }
          setPendingQueueIds(ids);
          setStartWaitStartedAt(Date.now());
          wsClient.setSessionQueue(ids);
          break;
        }
        case "session_started": {
          setSessionQueue([]);
          setPendingQueueIds(msg.questionIds);
          setSyncPhase("studying");
          setSessionStatus("Session started");
          setStartWaitStartedAt(null);
          if (msg.filter) {
            setSyncFolderId(msg.filter.folderIds?.[0] ?? null);
            setSyncTopic(msg.filter.topic ?? null);
          }
          break;
        }
        case "progress_updated": {
          /* Creator rebuilds the combined queue with the partner's fresh
             progress (sent after their class auto-switched). Only relevant
             before the session starts. */
          if (sessionCode === null || revealed || syncPhase !== "waiting") break;
          setSyncedPartnerProgress(msg.progress ?? []);
          setSyncedPartnerReviewLogs(msg.reviewLogs ?? []);
          const ids = buildSyncedQueue(syncPool, syncFolderId, msg.progress ?? [], msg.reviewLogs ?? []).map((q) => q.id);
          if (ids.length === 0) {
            setSessionStatus("No questions to study in this session");
            break;
          }
          setPendingQueueIds(ids);
          setStartWaitStartedAt(Date.now());
          wsClient.setSessionQueue(ids);
          break;
        }
        case "session_joined": {
          setShowStart(false);
          setAmCreator(false);
          setSyncPhase("waiting");
          setSessionStatus("Joined! Waiting for the host…");
          setStartWaitStartedAt(Date.now());
          if (msg.session.classId !== selectedClassId) {
            setSwitchedForSync(true);
            setSelectedClassId(msg.session.classId);
            writeLastClassId(msg.session.classId);
          }
          const other = msg.session.participants.find((p) => p.userId !== msg.userId);
          if (other) {
            const p = classMembers.find((m) => m.id === other.userId);
            setPartnerUser(p ?? { id: other.userId, name: other.userName || "Partner", key: "" });
          }
          syncSessionStore.saveIdentity({
            sessionId: msg.session.id,
            code: msg.session.code,
            userId: user?.id || "",
            userName: user?.name || "You",
            classId: msg.session.classId,
          });
          break;
        }
        case "pick_changed":
          /* Live pick: avatar only — no lock, no row highlight. Ignored when
             my screen is detached from the shared position. */
          if (msg.userId !== user?.id && currentIndex === sharedIndex) {
            setPartnerAnswer(msg.answer);
          }
          break;
        case "answer_locked": {
          if (msg.userId === user?.id) {
            setMyLocked(true);
            if (msg.answer !== undefined) setSelectedOption(msg.answer);
          } else {
            setPartnerLocked(true);
            if (msg.answer !== undefined) setPartnerAnswer(msg.answer);
          }
          break;
        }
        case "both_answered":
          if (currentIndex === sharedIndex) {
            setRevealed(true);
            setMyLocked(true);
            setPartnerLocked(true);
            setSessionStatus("Answer revealed");
          } else {
            setMyLocked(true);
            setPartnerLocked(true);
          }
          break;
        case "session_state": {
          /* Full snapshot: shared position, answers, locks, screen modes.
             Navigations only move my screen when I am following the partner
             (or when the move is my own); the snapshot is always recorded so
             follow-mode can snap back. */
          setSharedIndex(msg.session.currentIndex);
          const other = msg.session.participants.find((p) => p.userId !== user?.id);
          if (other) {
            const p = classMembers.find((m) => m.id === other.userId);
            setPartnerUser(p ?? { id: other.userId, name: other.userName || "Partner", key: "" });
          }
          if (msg.reason === "rejoin") {
            setSessionStateResume(msg.session);
            break;
          }
          const shouldApply =
            (screenMode === "follow" && partnerScreenMode !== "independent") ||
            currentIndex === msg.session.currentIndex;
          if (!shouldApply) break;
          /* Restore the stored state for this question instead of clearing it
             (answers survive going back and forth — change #4). */
          setCurrentIndex(msg.session.currentIndex);
          setFlipped(false);
          setEliminated(new Set());
          const me = msg.session.participants.find((p) => p.userId === user?.id);
          setSelectedOption(me?.answer ?? null);
          setMyLocked(!!me?.lockedIn);
          setPartnerAnswer(other?.answer ?? null);
          setPartnerLocked(!!other?.lockedIn);
          setRevealed(msg.session.revealed);
          const qid = sessionQueue[msg.session.currentIndex]?.id;
          if (qid && msg.session.revealed && me?.answer !== undefined && me.lockedIn) {
            ratedIdsRef.current.add(qid);
          }
          break;
        }
        case "screen_mode_changed":
          if (msg.userId !== user?.id) setPartnerScreenMode(msg.mode);
          break;
        case "rebuild_requested": {
          /* A participant re-filtered the session (change #2): the creator
             rebuilds the combined queue with the requester's fresh progress. */
          if (msg.requesterId !== user?.id) {
            setSyncedPartnerProgress(msg.progress ?? []);
            setSyncedPartnerReviewLogs(msg.reviewLogs ?? []);
          }
          setSyncFolderId(msg.folderIds[0] ?? null);
          setSyncTopic(msg.topic ?? null);
          if (msg.requesterId !== user?.id) {
            rebuildQueue(msg.folderIds[0] ?? null, msg.topic ?? null, msg.progress ?? [], msg.reviewLogs ?? []);
          }
          break;
        }
        case "next_question":
          setCurrentIndex(msg.index);
          setSharedIndex(msg.index);
          setFlipped(false);
          setEliminated(new Set());
          setRevealed(msg.revealed ?? false);
          {
            const me = (msg.answers ?? []).find((a) => a.userId === user?.id);
            const other = (msg.answers ?? []).find((a) => a.userId !== user?.id);
            setSelectedOption(me?.answer ?? null);
            setMyLocked(!!me?.lockedIn);
            setPartnerAnswer(other?.answer ?? null);
            setPartnerLocked(!!other?.lockedIn);
            const qid = sessionQueue[msg.index]?.id;
            if (qid && msg.revealed && me?.answer !== undefined && me.lockedIn) {
              ratedIdsRef.current.add(qid);
            }
          }
          setSessionStatus("");
          break;
        case "participant_left":
          setSessionStatus("Partner disconnected");
          break;
        case "session_ended":
          setSessionStatus("Session complete");
          if (sessionLenRef.current > 0) setCurrentIndex(sessionLenRef.current);
          break;
        case "error":
          setSessionStatus(msg.message);
          break;
      }
    });
    return unsub;
  }, [wsClient, user, classMembers, selectedClassId, allQuestions, syncPool, studyDefaults, userProgress, recentLogs, sessionCode, revealed, syncPhase, currentIndex, sharedIndex, screenMode, partnerScreenMode, sessionQueue, rebuildQueue, buildSyncedQueue, syncFolderId, syncTopic]);

  /* Surface WS handler errors in the session status instead of swallowing
     them (previously the spinner could hang forever on a data bug). */
  useEffect(() => {
    if (!wsClient) return;
    wsClient.setHandlerErrorHandler((err) => {
      setSessionStatus(err instanceof Error ? `Sync error: ${err.message}` : `Sync error: ${String(err)}`);
    });
    return () => wsClient.setHandlerErrorHandler(null);
  }, [wsClient]);

  /* Watchdog: if the session never starts after a join/rebuild, surface it.
     The joiner nudges the host (update_progress re-triggers the combined
     queue broadcast); the creator just reports the failure. */
  useEffect(() => {
    if (startWaitStartedAt === null) return;
    const t = setTimeout(() => {
      if (sessionCode === null) {
        setSessionStatus("Still waiting for the host… retrying");
        wsClient?.updateProgress(userProgress, recentLogs);
      } else {
        setSessionStatus("Session failed to start — leave and try again");
      }
    }, 10000);
    return () => clearTimeout(t);
  }, [startWaitStartedAt, sessionCode, wsClient, userProgress, recentLogs]);

  /* Refresh partner details once class members load after a sync join's
     auto class-switch (the session_joined lookup ran too early otherwise). */
  useEffect(() => {
    if (!partnerUser) return;
    const m = classMembers.find((x) => x.id === partnerUser.id);
    if (m) setPartnerUser(m);
  }, [classMembers, partnerUser]);

  /* Resolve the session's question IDs once questions are available locally. */
  useEffect(() => {
    if (!pendingQueueIds || pendingQueueIds.length === 0) return;
    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const qs = pendingQueueIds
      .map((id) => byId.get(id))
      .filter((q): q is QuizQuestion => !!q);
    if (qs.length === 0) return; /* questions for the session class not loaded yet */
    const same =
      qs.length === sessionQueue.length &&
      qs.every((q, i) => sessionQueue[i]?.id === q.id);
    sessionLenRef.current = qs.length;
    if (!same) {
      setSessionQueue(qs);
      setCurrentIndex(0);
      setFlipped(false);
      setSelectedOption(null);
      setPartnerAnswer(null);
      setRevealed(false);
      setEliminated(new Set());
    }
    /* Joiner whose class auto-switched: share freshly loaded progress so the
       creator can rebuild the combined queue with real data. */
    if (switchedForSync) {
      setSwitchedForSync(false);
      wsClient?.updateProgress(userProgress, recentLogs);
    }
  }, [pendingQueueIds, allQuestions, switchedForSync, wsClient, userProgress, recentLogs, sessionQueue]);

  /* Apply a rejoin snapshot once the session's questions are loaded locally.
     Restores position, reveal state, answers, locks and screen modes. */
  useEffect(() => {
    if (!sessionStateResume || allQuestions.length === 0) return;
    const s = sessionStateResume;

    setSessionCode(s.code);
    setSessionStatus("");
    if (s.status === "active" || s.status === "complete") setSyncPhase("studying");
    else setSyncPhase("waiting");

    const me = s.participants.find((p) => p.userId === user?.id);
    const partner = s.participants.find((p) => p.userId !== user?.id);
    if (partner) {
      const p = classMembers.find((m) => m.id === partner.userId);
      setPartnerUser(p ?? { id: partner.userId, name: partner.userName || "Partner", key: "" });
    }

    /* Waiting room: no queue yet — nothing else to restore. */
    if (s.status === "waiting") {
      setSessionStateResume(null);
      return;
    }

    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const qs = s.questionIds.map((id) => byId.get(id)).filter((q): q is QuizQuestion => !!q);
    if (qs.length === 0) return; /* session class questions not loaded yet */

    setSessionQueue(qs);
    sessionLenRef.current = qs.length;
    setPendingQueueIds(null);
    setSharedIndex(s.currentIndex);
    setCurrentIndex(Math.min(s.currentIndex, qs.length - 1));
    setFlipped(false);
    setRevealed(s.revealed);
    setEliminated(new Set());
    setMyLocked(false);
    setPartnerLocked(false);
    setAmCreator(s.createdBy === user?.id);

    /* Seed the per-question rated set so already-answered questions are not
       auto-rated a second time after a rejoin. */
    if (s.answersByQuestion) {
      for (const [qid, byUser] of Object.entries(s.answersByQuestion)) {
        const mine = byUser[user?.id ?? ""];
        if (mine?.lockedIn && s.revealedByQuestion?.[qid]) ratedIdsRef.current.add(qid);
      }
    }

    if (me) {
      setSelectedOption(me.answer ?? null);
      setMyLocked(!!me.lockedIn);
      if (me.screenMode) setScreenMode(me.screenMode);
    }
    if (partner) {
      setPartnerAnswer(partner.answer ?? null);
      setPartnerLocked(!!partner.lockedIn);
      if (partner.screenMode) setPartnerScreenMode(partner.screenMode);
    }
    if (s.filter?.folderIds?.length) setSyncFolderId(s.filter.folderIds[0]);
    if (s.filter?.topic) setSyncTopic(s.filter.topic);

    setSessionStateResume(null);
  }, [sessionStateResume, allQuestions, classMembers, user]);

  /* Auto-rejoin (change #3): the session survives page navigation (module
     store keeps the WS alive) and app restarts (identity is persisted); this
     effect re-attaches whenever Practice mounts with a stored session. */
  useEffect(() => {
    if (!user?.id) return;
    const ident = syncSessionStore.getIdentity();
    if (!ident) return;
    if (wsClient) {
      /* Already attached (navigated away and back): the message handler is
         subscribed again and buffered messages are replayed. */
      return;
    }
    /* coStudyMode starts "off" on a fresh mount — the stored identity is what
       tells us this mount should rejoin the live session. */
    setCoStudyMode("synced");
    setShowStart(false);
    if (sessionCode === null) setSessionCode(ident.code);
    setSyncPhase("studying");
    setSessionStatus("Rejoining session…");
    const base = prefs.serverUrl || `http://localhost:${window.location.port || 4180}`;
    const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    let alive = true;
    (async () => {
      try {
        const client = await syncSessionStore.connect(wsUrl);
        if (!alive) return;
        setWsClient(client);
        const snapshot = await client.rejoinSession(ident.sessionId, ident.userId, ident.userName, userProgress, recentLogs);
        if (!alive) return;
        /* Apply the snapshot here as well — on a fresh mount the shared
           message handler may not be subscribed yet when the rejoin
           response arrives, so relying on it alone can lose the restore. */
        setSessionStateResume(snapshot);
      } catch (e) {
        if (!alive) return;
        setSessionStatus(e instanceof Error ? e.message : "Could not rejoin the session");
        syncSessionStore.clearIdentity();
        setSessionCode(null);
        setSyncPhase("lobby");
        setCoStudyMode("off");
        setShowStart(true);
      }
    })();
    return () => { alive = false; };
  }, [wsClient, sessionCode, user?.id, prefs.serverUrl, userProgress, recentLogs]);

  /* Rebuild session when questions or settings change. */
  useEffect(() => {
    /* Synced sessions own the queue — never rebuild locally while live. */
    if (coStudyMode === "synced" && wsClient?.connected) return;

    const pool = mode === "browse" ? browseQuestions : mergedQuestions;
    if (pool.length === 0) {
      /* The selected class has no questions — clear any leftover session from
         a previously selected class so its questions don't linger. */
      setSessionQueue([]);
      setSession(null);
      setCurrentIndex(0);
      setFlipped(false);
      setSelectedOption(null);
      return;
    }

    if (mode === "browse") {
      setSession({ due: pool, newItems: [], total: pool.length });
      setSessionQueue([...pool].sort(() => Math.random() - 0.5));
      setCurrentIndex(0);
      setFlipped(false);
      setSelectedOption(null);
      return;
    }

    let s: Session;
    if (coStudyMode === "same-device" && coStudyPartner && partnerProgress.length + userProgress.length > 0) {
      s = buildCoStudySession(
        pool,
        studyDefaults,
        userProgress,
        partnerProgress,
        reviewLogs,
        partnerReviewLogs,
      );
    } else {
      s = buildSession(pool, studyDefaults, undefined, undefined, reviewLogs);
    }
    setSession(s);
    if (!reviewMode) {
      setSessionQueue([...s.due, ...s.newItems]);
    }
    setCurrentIndex(0);
    setFlipped(false);
    setSelectedOption(null);
  }, [mergedQuestions, browseQuestions, newCardsPerSession, reviewMode, selectedClass, coStudyMode, coStudyPartner, userProgress, partnerProgress, reviewLogs, partnerReviewLogs, mode, wsClient, studyDefaults]);

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

  /* Auto-FSRS in synced mode: correct -> good, wrong -> again. Applied once
     per question when the answer is revealed (before anyone clicks Next). */
  useEffect(() => {
    if (coStudyMode !== "synced" || !revealed || !current) return;
    if (selectedOption === null) return;
    if (ratedIdsRef.current.has(current.id)) return;
    ratedIdsRef.current.add(current.id);
    void handleRate(selectedOption === current.correctIndex ? "good" : "again", user?.id, true);
  }, [coStudyMode, revealed, selectedOption, current, handleRate, user]);

  /* Leave a synced session and return to the create/join panel. */
  const leaveSyncSession = useCallback(() => {
    syncSessionStore.leave();
    setWsClient(null);
    setSyncPhase("lobby");
    setSessionCode(null);
    setSessionStatus("");
    setPartnerAnswer(null);
    setPartnerUser(null);
    setRevealed(false);
    setPendingQueueIds(null);
    setStartWaitStartedAt(null);
    setEliminated(new Set());
    setSelectedOption(null);
    setFlipped(false);
    setMyLocked(false);
    setPartnerLocked(false);
    setSharedIndex(0);
    ratedIdsRef.current.clear();
    setSyncedPartnerProgress([]);
    setSyncedPartnerReviewLogs([]);
    setShowSessionBrowser(false);
    setAmCreator(false);
    /* Every new session starts in algorithm mode. */
    setSyncFolderId(SYNC_ALGORITHM);
    setSyncTopic(null);
  }, []);

  /* Leave a synced session AND return to the entry hub (base screen). */
  const leaveToStart = useCallback(() => {
    leaveSyncSession();
    setShowStart(true);
    setConnState("connected");
  }, [leaveSyncSession]);

  /* Live picks shown on the option rows: mine (letter -> my avatar) and the
     partner's (letter -> their avatar, toggleable via prefs). */
  const picks = useMemo<OptionPick[]>(() => {
    const arr: OptionPick[] = [];
    if (selectedOption !== null && user?.id) {
      arr.push({ userId: user.id, answer: selectedOption });
    }
    if (partnerAnswer !== null && partnerUser) {
      arr.push({ userId: partnerUser.id, answer: partnerAnswer });
    }
    return arr;
  }, [selectedOption, partnerAnswer, partnerUser, user]);

  /* Single click = select + live pick broadcast; a second click on the SAME
     option within the double-click window LOCKs it in (change #5). */
  const handleOptionSelect = useCallback((i: number) => {
    if (revealed || myLocked || coStudyMode !== "synced" || currentIndex === null) return;
    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.index === i && now - last.at < 350) {
      lastClickRef.current = null;
      setSelectedOption(i);
      setMyLocked(true);
      wsClient?.lockAnswer(i, currentIndex);
      return;
    }
    lastClickRef.current = { index: i, at: now };
    setSelectedOption(i);
    wsClient?.sendPick(i);
  }, [revealed, myLocked, coStudyMode, currentIndex, wsClient]);

  /* Lock button next to Continue — same as double-clicking an option. */
  const lockSelected = useCallback(() => {
    if (selectedOption === null || myLocked || revealed || currentIndex === null) return;
    setMyLocked(true);
    wsClient?.lockAnswer(selectedOption, currentIndex);
  }, [selectedOption, myLocked, revealed, currentIndex, wsClient]);

  /* Skip/Back: moves the shared position. Applied locally right away (so the
     screen never lags), then broadcast; followers snap via session_state. */
  const handleNavigate = useCallback((index: number) => {
    const len = sessionQueue.length;
    if (len === 0) return;
    const clamped = Math.max(0, Math.min(index, len - 1));
    setCurrentIndex(clamped);
    setSharedIndex(clamped);
    setFlipped(false);
    setSelectedOption(null);
    setPartnerAnswer(null);
    setRevealed(false);
    setEliminated(new Set());
    setMyLocked(false);
    setPartnerLocked(false);
    wsClient?.navigateSession(clamped);
  }, [sessionQueue, wsClient]);

  /* Both users press Continue to advance past the revealed question. */
  const handleContinue = useCallback(() => {
    wsClient?.rateQuestion();
  }, [wsClient]);

  /* Follow mode: "follow" (default) follows the partner unless they are
     "independent"; "not-follow" never jumps; "independent" is never followed.
     Switching back to "follow" snaps to the shared position. The choice is
     remembered in prefs and applied to future sessions (change #6). */
  const handleScreenModeChange = useCallback((m: ScreenMode) => {
    setScreenMode(m);
    savePrefs({ ...prefs, screenMode: m });
    wsClient?.setScreenMode(m);
    if (m === "follow") {
      setCurrentIndex(sharedIndex);
      setFlipped(false);
      setSelectedOption(null);
      setPartnerAnswer(null);
      setRevealed(false);
      setEliminated(new Set());
      setMyLocked(false);
      setPartnerLocked(false);
    }
  }, [wsClient, sharedIndex, prefs, savePrefs]);

  /* Sync to partner: jump my screen to the shared position (used when I am
     diverged after a partner navigation while not-following). */
  const syncToPartner = useCallback(() => {
    setCurrentIndex(sharedIndex);
    setFlipped(false);
    setSelectedOption(null);
    setPartnerAnswer(null);
    setRevealed(false);
    setEliminated(new Set());
    setMyLocked(false);
    setPartnerLocked(false);
  }, [sharedIndex]);

  /* Create a synced session (creator shares their progress + recent logs).
     The client lives in the module store so the session survives navigation
     away from this page (change #3). classId defaults to the selected class
     so the start screen's class picker can create in one action. */
  const handleStartSession = useCallback(async (classId?: string) => {
    const cid = classId ?? selectedClassId;
    if (!cid) return;
    const base = prefs.serverUrl || `http://localhost:${window.location.port || 4180}`;
    const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    try {
      const client = await syncSessionStore.connect(wsUrl);
      setWsClient(client);
      /* The base screen can create a session before this class's questions
         have been fetched — load them on demand so the pool is real and the
         in-session unit/topic filter has the full class questions (#8).
         Also reload when the requested class differs from the loaded one,
         so a session never starts with another class's questions. */
      let pool = syncPool;
      if (repo && (pool.length === 0 || cid !== selectedClassId)) {
        const [qs, prog, rls, ns] = await Promise.all([
          repo.questionsForClass(cid),
          user?.id ? repo.listProgressForUser(user.id) : Promise.resolve([] as UserProgress[]),
          user?.id ? repo.reviewLogsForUser(user.id) : Promise.resolve([] as ReviewLog[]),
          repo.notesForClass(cid),
        ]);
        const c = (await repo.listClasses()).find((x) => x.id === cid);
        if (c) setSelectedClass(c);
        setSelectedClassId(cid);
        setAllQuestions(qs);
        setUserProgress(prog);
        setReviewLogs(rls);
        pool = mergeUserProgress(qs, prog);
        if (syncFolderId && syncFolderId !== SYNC_ALGORITHM) {
          const folderNoteIds = new Set(ns.filter((n) => n.folderId === syncFolderId).map((n) => n.id));
          pool = pool.filter((q) => folderNoteIds.has(q.noteId));
        }
        if (syncTopic) {
          const key = normalizeTopic(syncTopic);
          pool = pool.filter((q) => q.topic && normalizeTopic(q.topic) === key);
        }
      }
      const { id, code } = await client.createSession(
        cid,
        pool.map((q) => q.id),
        user?.id,
        user?.name,
        userProgress,
        recentLogs,
        { folderIds: syncFolderId ? [syncFolderId] : [], topic: syncTopic ?? undefined },
      );
      syncSessionStore.saveIdentity({
        sessionId: id,
        code,
        userId: user?.id || "",
        userName: user?.name || "You",
        classId: cid,
      });
      writeLastClassId(cid);
      setSessionCode(code);
      setSyncPhase("waiting");
      setShowStart(false);
      setCoStudyMode("synced");
      setAmCreator(true);
      setSessionStatus("Waiting for your partner to join…");
    } catch (e) {
      setSessionStatus(e instanceof Error ? `Could not connect to the server: ${e.message}` : "Could not connect to the server");
      setWsClient(null);
    }
  }, [prefs, repo, selectedClassId, syncPool, syncFolderId, syncTopic, notes, user, userProgress, recentLogs]);

  /* Join a synced session by 4-digit code. */
  const handleJoinSession = useCallback(async () => {
    if (!joinCode) return;
    const base = prefs.serverUrl || `http://localhost:${window.location.port || 4180}`;
    const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    try {
      const client = await syncSessionStore.connect(wsUrl);
      setWsClient(client);
      const { id, code } = await client.joinSession(
        joinCode,
        user?.id || "anon",
        user?.name || "Anonymous",
        userProgress,
        recentLogs,
      );
      syncSessionStore.saveIdentity({
        sessionId: id,
        code,
        userId: user?.id || "",
        userName: user?.name || "You",
        classId: "",
      });
      setSessionCode(code);
      setSyncPhase("waiting");
      setShowStart(false);
      setCoStudyMode("synced");
      setSessionStatus("Joined! Waiting for the host…");
    } catch (e) {
      setSessionStatus(e instanceof Error ? e.message : "Failed to join session");
      setWsClient(null);
    }
  }, [joinCode, prefs, user, userProgress, recentLogs]);

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
  /* Clear any active session state so a class switch never shows stale
     questions from the previously selected class. */
  function resetSession() {
    setSessionQueue([]);
    setSession(null);
    setCurrentIndex(0);
    setFlipped(false);
    setSelectedOption(null);
  }

  function handleClassChange(id: string) {
    /* Leave a synced session only when switching to a DIFFERENT class than
       the session belongs to (rejoining + re-picking the session's class
       must not kill the session). */
    if (id !== selectedClassId && wsClient && id !== syncSessionStore.getIdentity()?.classId) leaveSyncSession();
    resetSession();
    setSelectedClassId(id || null);
    setSelectedFolderId(null);
    setSelectedTopic(null);
    writeLastClassId(id || null);
    /* Clearing the class returns to the start hub (change #3). */
    if (!id) {
      setShowStart(true);
      setCoStudyMode("off");
      setCoStudyPartner(null);
    }
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

  /* Start hub (change #3): one screen for every way into practice. Solo +
     algorithm is the default with a Continue button; synced creation auto-
     generates a code once a class is picked; joining only needs the code
     (the session's class is applied automatically). */
  if (showStart) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-edge px-6 py-3">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink"
          >
            <ArrowLeft className="size-4" />
            Dashboard
          </button>
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Practice</span>
        </header>

        <div className="flex flex-1 flex-col items-center overflow-y-auto px-8 py-10">
          <div className="flex w-full max-w-xl flex-col gap-5">
            {/* Solo practice — the default */}
            <div className="rounded-2xl border border-edge bg-card p-6 shadow-soft">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-ink">Practice</h2>
                  <div className="mt-1.5 flex gap-1.5">
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-bold text-ink-dim">Solo</span>
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-bold text-ink-dim">Algorithm</span>
                  </div>
                </div>
                <BookOpen className="size-8 text-accent" />
              </div>
              <p className="mt-3 text-sm text-ink-faint">
                Auto-suggested review questions, spaced by your memory curve.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <select
                  value={selectedClassId || ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    resetSession();
                    setSelectedClassId(v || null);
                    if (v) writeLastClassId(v);
                  }}
                  aria-label="class to practice"
                  className="w-full flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm font-semibold text-ink-dim outline-none"
                >
                  <option value="">Select a class</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (!selectedClassId) return;
                    writeLastClassId(selectedClassId);
                    setMode("algorithm");
                    setCoStudyMode("off");
                    setCoStudyPartner(null);
                    setShowStart(false);
                  }}
                  disabled={!selectedClassId}
                  className="rounded-xl bg-accent px-6 py-2.5 font-display text-sm font-bold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue
                </button>
              </div>
              {classes.length === 0 && (
                <p className="mt-3 text-xs text-ink-faint">
                  You don't have any classes yet — create one from the Dashboard.
                </p>
              )}
            </div>

            {/* Create a synced session — picking a class generates the code */}
            <div className="rounded-2xl border border-edge bg-card p-6 shadow-soft">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-ink">Synced session</h2>
                  <div className="mt-1.5 flex gap-1.5">
                    <span className="rounded-full bg-accent-softer px-2 py-0.5 text-[10px] font-bold text-accent">Two players</span>
                  </div>
                </div>
                <Users className="size-8 text-accent" />
              </div>
              <p className="mt-3 text-sm text-ink-faint">
                Practice with a partner in real time. Pick a class and a 4-digit code
                is generated automatically for them to join.
              </p>
              <select
                value={syncLobbyClass}
                onChange={(e) => {
                  const v = e.target.value;
                  setSyncLobbyClass(v);
                  if (v) void handleStartSession(v);
                }}
                aria-label="class for synced session"
                className="mt-4 w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm font-semibold text-ink-dim outline-none"
              >
                <option value="">Select a class to create a session</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {sessionCode && (
                <div className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-accent-softer px-4 py-3">
                  <span className="text-xs font-semibold text-ink-faint">Code:</span>
                  <span className="font-display text-2xl font-bold tracking-[0.25em] text-accent">{sessionCode}</span>
                </div>
              )}
              {sessionStatus && <p className="mt-2 text-xs font-semibold text-danger-ink">{sessionStatus}</p>}
            </div>

            {/* Join a session — no class selection needed */}
            <div className="rounded-2xl border border-edge bg-card p-6 shadow-soft">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-ink">Join a session</h2>
                  <div className="mt-1.5 flex gap-1.5">
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-bold text-ink-dim">By code</span>
                  </div>
                </div>
                <ArrowRight className="size-8 text-accent" />
              </div>
              <p className="mt-3 text-sm text-ink-faint">
                Enter the 4-digit code your partner shares. The class is picked up
                automatically and the join is rejected if you're not in it.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="4-digit code"
                  inputMode="numeric"
                  aria-label="session code"
                  className="w-full flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-center text-sm font-bold tracking-widest text-ink outline-none"
                />
                <button
                  onClick={() => void handleJoinSession()}
                  disabled={joinCode.length !== 4}
                  className="rounded-xl bg-accent px-6 py-2.5 font-display text-sm font-bold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Join
                </button>
              </div>
            </div>
          </div>
        </div>
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

          {/* Synced session info — code / connection / follow mode live here
              (right of the class toggle); the card carries question + partner. */}
          {coStudyMode === "synced" && syncPhase === "studying" && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {sessionCode && (
                <span className="rounded-full bg-accent-softer px-2 py-0.5 text-[11px] font-bold text-accent">
                  Code: {sessionCode}
                </span>
              )}
              {connState === "reconnecting" && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                  Reconnecting…
                </span>
              )}
              <select
                value={screenMode}
                onChange={(e) => handleScreenModeChange(e.target.value as ScreenMode)}
                title="How your screen tracks the partner"
                aria-label="Screen-follow mode"
                className="rounded-lg border border-edge bg-panel px-1.5 py-0.5 text-[11px] font-semibold text-ink-dim outline-none"
              >
                <option value="follow">Follow partner</option>
                <option value="not-follow">Move freely</option>
                <option value="independent">Independent</option>
              </select>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          {selectedClassId && coStudyMode !== "synced" && (
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
              if (m !== "synced" && wsClient) {
                leaveSyncSession();
              }
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
        {/* Scrollable content column — hidden scrollbar so the page can scroll
           past tall questions without a visible bar (change #6). */}
        <div className="scrollbar-hidden flex flex-1 flex-col items-center overflow-y-auto px-8 py-6">
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
          {selectedClassId && mode === "browse" && coStudyMode !== "synced" && (
            <div className="mb-6 flex flex-wrap items-center gap-4">
              <select
                value={selectedFolderId || ""}
                onChange={(e) => { setSelectedFolderId(e.target.value || null); setSelectedTopic(null); }}
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
                {coStudyMode !== "synced" && (
                  <button
                    onClick={handleStudyAgain}
                    className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white hover:bg-accent-hover"
                  >
                    Study all
                  </button>
                )}
                <button
                  onClick={() => navigate("/")}
                  className="rounded-xl border border-edge px-6 py-2.5 font-semibold text-ink-dim hover:bg-card-hover"
                >
                  Dashboard
                </button>
                {coStudyMode === "synced" && (
                  <button
                    onClick={leaveToStart}
                    className="rounded-xl border border-edge px-6 py-2.5 font-semibold text-ink-dim hover:bg-card-hover"
                  >
                    Leave session
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Synced session panels (lobby / waiting) — replace the question */}
          {coStudyMode === "synced" && syncPhase !== "studying" && (
            <div className="flex w-full max-w-md flex-col items-center">
              {syncPhase === "waiting" ? (
                <div className="flex w-full flex-col items-center gap-4 rounded-2xl border border-edge bg-card p-8 text-center shadow-soft">
                  <Loader2 className="size-8 animate-spin text-ink-faint" />
                  <h2 className="font-display text-lg font-bold text-ink">Waiting for your partner…</h2>
                  {sessionCode && (
                    <div>
                      <p className="text-xs font-semibold text-ink-faint">Share this code</p>
                      <p className="mt-1 font-display text-4xl font-bold tracking-[0.3em] text-accent">
                        {sessionCode}
                      </p>
                    </div>
                  )}
                  <p className="text-sm text-ink-faint">{sessionStatus}</p>
                  <button onClick={leaveToStart} className="text-xs text-ink-faint hover:text-ink">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-edge bg-card p-8 text-center shadow-soft">
                  <Users className="size-10 text-accent" />
                  <div>
                    <h2 className="font-display text-lg font-bold text-ink">Synced session</h2>
                    <p className="mt-1 max-w-sm text-sm text-ink-faint">
                      Practice together in real time. Pick a class and a 4-digit code is
                      generated automatically for your partner to join — the combined
                      algorithm picks a shared question and the answer is revealed once
                      you both lock in.
                    </p>
                  </div>

                  <select
                    value={syncLobbyClass || selectedClassId || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSyncLobbyClass(v);
                      if (v) void handleStartSession(v);
                    }}
                    aria-label="class for synced session"
                    className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm font-semibold text-ink-dim outline-none"
                  >
                    <option value="">Select a class to create a session</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>

                  <button
                    onClick={() => handleStartSession((selectedClassId ?? syncLobbyClass) || undefined)}
                    disabled={!selectedClassId && !syncLobbyClass}
                    className="w-full rounded-xl bg-accent px-6 py-3 font-display text-sm font-bold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Create a new session
                  </button>
                  {sessionStatus && <p className="text-xs text-danger-ink">{sessionStatus}</p>}
                </div>
              )}
            </div>
          )}

          {/* Active question */}
          {current && !sessionDone && (coStudyMode !== "synced" || syncPhase === "studying") && (
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

              {/* Progress indicator (synced sessions show it in the card header) */}
              {coStudyMode !== "synced" && (
                <p className="mb-4 text-sm font-semibold text-ink-faint">
                  {mode === "browse"
                    ? `Question ${currentIndex + 1} of ${sessionQueue.length}`
                    : reviewMode
                      ? `Review ${currentIndex + 1} of ${sessionQueue.length}`
                      : currentIndex < (session?.due.length ?? 0)
                        ? `Review ${currentIndex + 1} of ${sessionTotal}`
                        : `New ${currentIndex - (session?.due.length ?? 0) + 1} of ${session?.newItems.length ?? 0}`
                  }
                </p>
              )}

              {/* Question card */}
              <div className="w-full rounded-2xl border border-edge bg-card p-8 shadow-soft">
                {coStudyMode === "synced" ? (
                  <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="font-display text-sm font-bold text-ink">
                      Question {currentIndex + 1}
                      <span className="text-ink-faint"> / {sessionQueue.length}</span>
                    </span>

                    {/* Partner avatar + status (waiting / thinking / locked) */}
                    {partnerUser && (
                      <span className="flex items-center gap-1.5" title={partnerUser.name}>
                        {partnerUser.avatar ? (
                          <img
                            src={partnerUser.avatar}
                            alt={partnerUser.name}
                            className="size-5 rounded-full object-cover"
                          />
                        ) : (
                          <span className="flex size-5 items-center justify-center rounded-full bg-accent-softer text-[9px] font-bold text-accent">
                            {partnerUser.name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className={
                        partnerLocked
                          ? "text-xs font-bold text-accent"
                          : partnerAnswer !== null
                            ? "text-xs font-semibold text-callout-ink"
                            : "text-xs font-semibold text-ink-faint"
                      }
                    >
                      {partnerLocked ? "Locked" : partnerAnswer !== null ? "Thinking" : "Waiting"}
                    </span>

                    <div className="ml-auto flex items-center gap-1">
                      {/* Session question browser (change #2) — icon only */}
                      <button
                        onClick={() => setShowSessionBrowser((v) => !v)}
                        title="Browse session questions"
                        aria-label="Browse session questions"
                        className={`rounded-lg p-1.5 ${
                          showSessionBrowser ? "bg-accent text-white" : "bg-panel text-ink-dim hover:bg-card-hover"
                        }`}
                      >
                        <ListChecks className="size-4" />
                      </button>

                      {/* Show-picks toggle — plain eye / blind-eye icon (change #8) */}
                      <button
                        onClick={() => savePrefs({ ...prefs, showPartnerPick: !(prefs.showPartnerPick !== false) })}
                        title={
                          prefs.showPartnerPick !== false
                            ? "Hide partner's picks"
                            : "Show partner's picks"
                        }
                        aria-label={
                          prefs.showPartnerPick !== false
                            ? "Hide partner's picks"
                            : "Show partner's picks"
                        }
                        aria-pressed={prefs.showPartnerPick !== false}
                        className={`rounded-lg p-1.5 hover:bg-card-hover ${
                          prefs.showPartnerPick !== false ? "text-accent" : "text-ink-faint"
                        }`}
                      >
                        {prefs.showPartnerPick !== false ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                      </button>
                    </div>
                  </div>
                </>
                ) : (
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Question
                  </span>
                )}
                {coStudyMode === "synced" && sessionStatus && (
                  <p className="mt-2 text-xs font-semibold text-ink-faint">{sessionStatus}</p>
                )}
                <p className="mt-2 font-display text-xl font-semibold text-ink">
                  {current.question}
                </p>

                <OptionList
                  options={current.options}
                  correctIndex={current.correctIndex}
                  selected={selectedOption}
                  reveal={coStudyMode === "synced" ? revealed : selectedOption !== null}
                  disabled={
                    coStudyMode === "synced"
                      ? revealed || myLocked
                      : selectedOption !== null
                  }
                  onSelect={(i) => {
                    if (coStudyMode === "synced") {
                      /* Single click stores the pick live; a second click on
                         the same option LOCKs it in (change #5). */
                      handleOptionSelect(i);
                    } else {
                      setSelectedOption(i);
                      setFlipped(true);
                    }
                  }}
                  onToggleEliminate={(i) => {
                    setEliminated((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    });
                  }}
                  eliminated={eliminated}
                  picks={coStudyMode === "synced" ? picks : []}
                  myUserId={coStudyMode === "synced" ? user?.id : undefined}
                  avatarFor={(uid) => (uid === user?.id ? user.avatar : partnerUser?.avatar)}
                  nameFor={(uid) => (uid === user?.id ? user?.name ?? "You" : partnerUser?.name ?? "Partner")}
                  showPicks={prefs.showPartnerPick !== false}
                />

                {coStudyMode === "synced" && partnerLocked && !myLocked && !revealed && (
                  <p className="mt-3 text-xs font-semibold text-accent">
                    Partner locked in — double-click your answer to lock it.
                  </p>
                )}

                {selectedOption !== null && (coStudyMode !== "synced" || revealed) && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl bg-accent-softer p-4 text-sm text-ink-dim">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className={`font-bold ${selectedOption === current.correctIndex ? "text-green-700" : "text-red-700"}`}>
                          {selectedOption === current.correctIndex ? "Correct" : "Incorrect"}
                        </span>
                      </div>
                      {current.explanation && (
                        <p className="mt-1 text-ink-dim">
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

                {coStudyMode !== "synced" && (
                  <button
                    onClick={() => setFlipped(!flipped)}
                    className="mt-2 text-xs text-ink-faint hover:text-ink"
                  >
                    {flipped ? "Hide answer" : "Reveal answer"}
                  </button>
                )}
              </div>

              {/* Rating buttons */}
              {selectedOption !== null && coStudyMode !== "synced" && (
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

              {/* Synced action row: Back / Skip / Sync-to-partner / Lock / Leave
                  and Continue once the answer is revealed (changes #4, #5, #7). */}
              {coStudyMode === "synced" && (
                <div className="mt-6 flex w-full flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleNavigate(currentIndex - 1)}
                    disabled={currentIndex === 0 || revealed}
                    title="Previous question"
                    className="rounded-xl border border-edge px-3 py-2 text-ink-dim hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowLeft className="size-4" />
                  </button>
                  <button
                    onClick={() => handleNavigate(currentIndex + 1)}
                    disabled={currentIndex >= sessionQueue.length - 1 || revealed}
                    title="Skip to next question"
                    className="rounded-xl border border-edge px-3 py-2 text-ink-dim hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowRight className="size-4" />
                  </button>

                  {diverged && (
                    <button
                      onClick={syncToPartner}
                      title="Jump back to the partner's position"
                      className="rounded-lg border border-edge px-3 py-2 text-xs font-semibold text-accent hover:bg-card-hover"
                    >
                      Sync to partner
                    </button>
                  )}

                  <div className="flex-1" />

                  {!revealed && (
                    <button
                      onClick={lockSelected}
                      disabled={selectedOption === null || myLocked}
                      title={myLocked ? "Answer locked" : "Lock your answer (or double-click an option)"}
                      className="flex items-center gap-1.5 rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-ink-dim hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {myLocked ? <Lock className="size-4 text-accent" /> : <LockOpen className="size-4" />}
                      {myLocked ? "Locked" : "Lock"}
                    </button>
                  )}

                  <button
                    onClick={leaveToStart}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-faint hover:text-danger-ink"
                  >
                    Leave
                  </button>

                  {revealed && (
                    <button
                      onClick={handleContinue}
                      className="rounded-xl bg-accent px-6 py-2.5 font-display text-sm font-bold text-white hover:bg-accent-hover"
                    >
                      Continue
                    </button>
                  )}
                </div>
              )}

              {/* Session question browser + unit/topic re-filter (change #2):
                  jump to any question in the queue, or rebuild the shared queue
                  around a specific unit/topic. The creator rebuilds locally
                  (they hold both users' progress); the joiner asks the creator
                  to rebuild via request_rebuild. */}
              {coStudyMode === "synced" && showSessionBrowser && (
                <div className="mt-6 w-full rounded-2xl border border-edge bg-card p-5 shadow-soft">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-sm font-bold text-ink">Session questions</h3>
                    <button
                      onClick={() => setShowSessionBrowser(false)}
                      className="text-xs text-ink-faint hover:text-ink"
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      value={syncFolderId || ""}
                      onChange={(e) => {
                        const v = e.target.value || null;
                        setSyncFolderId(v);
                        setSyncTopic(null);
                        handleSyncFilterChange(v, null);
                      }}
                      aria-label="session unit filter"
                      className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim outline-none"
                    >
                      <option value={SYNC_ALGORITHM}>Algorithm</option>
                      <option value="">All units</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    <select
                      value={syncTopic || ""}
                      onChange={(e) => {
                        const v = e.target.value || null;
                        setSyncTopic(v);
                        handleSyncFilterChange(syncFolderId, v);
                      }}
                      aria-label="session topic filter"
                      className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim outline-none"
                    >
                      <option value="">All topics</option>
                      {syncTopics.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <span className="text-xs font-semibold text-ink-faint">
                      {sessionQueue.length} question{sessionQueue.length !== 1 ? "s" : ""}
                    </span>
                    {amCreator && syncFolderId !== SYNC_ALGORITHM && (
                      <button
                        onClick={handleShuffleQueue}
                        title="Shuffle the shared queue"
                        className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs font-semibold text-ink-dim outline-none hover:text-ink"
                      >
                        Shuffle
                      </button>
                    )}
                    {!amCreator && (
                      <span className="text-[11px] font-medium text-ink-faint">
                        The host rebuilds the shared queue when the filters change.
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-[11px] font-medium text-ink-faint">
                    {syncFolderId === SYNC_ALGORITHM
                      ? "Algorithm mode: the shared queue is SRS-paced — due questions first, then new ones (no session cap)."
                      : syncFolderId
                        ? "Browse mode: every question in this unit."
                        : "Browse mode: every question in the class, shuffled on demand."}
                  </p>

                  <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                    {sessionQueue.map((q, i) => {
                      const answered = ratedIdsRef.current.has(q.id);
                      const isCurrent = i === currentIndex;
                      return (
                        <button
                          key={q.id}
                          onClick={() => handleNavigate(i)}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs ${
                            isCurrent
                              ? "bg-accent text-white"
                              : "bg-panel text-ink-dim hover:bg-card-hover"
                          }`}
                        >
                          <span className="w-6 shrink-0 font-bold">{i + 1}</span>
                          <span className="flex-1 truncate">{q.question}</span>
                          {answered && (
                            <span className={isCurrent ? "font-bold text-white/80" : "font-bold text-green-600"}>
                              ✓
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Skip button */}
              {selectedOption === null && coStudyMode !== "synced" && (
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
                <p className="text-xs font-semibold text-ink-faint">Reviewed</p>
                <p className="mt-1 font-display text-lg font-bold">
                  {diagnostics.studiedQuestions}
                  <span className="text-sm font-normal text-ink-faint">
                    /{diagnostics.totalQuestions} questions
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] font-medium text-ink-faint">
                  {diagnostics.totalReps} total review{diagnostics.totalReps !== 1 ? "s" : ""}
                </p>
              </div>

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

              {current && (
                <div className="rounded-lg bg-panel p-3">
                  <p className="text-xs font-semibold text-ink-faint">Current card</p>
                  <p className="mt-1 text-sm font-bold capitalize text-ink">
                    {current.state}
                    {current.reps > 0 && (
                      <span className="font-normal text-ink-dim">
                        {" "}· {current.reps} review{current.reps !== 1 ? "s" : ""}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium text-ink-faint">
                    Next due:{" "}
                    {current.state === "new"
                      ? "backlog"
                      : new Date(current.due).toLocaleDateString()}
                  </p>
                </div>
              )}

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
