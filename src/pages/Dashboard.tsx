import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  Check,
  ChevronRight,
  CircleHelp,
  Clock,
  FileAudio,
  FileText,
  FolderPlus,
  Link2,
  Loader2,
  MoreVertical,
  Play,
  Plus,
  Pencil,
  Search,
  ScrollText,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import CreateNoteModal, { type CreateNoteResult, type NoteSource } from "../components/CreateNoteModal";
import SyllabusModal from "../components/SyllabusModal";
import { deduplicateTopics } from "../lib/topics";
import { useApp } from "../lib/app";
import { fetchActivity } from "../lib/api";
import { exportMarkdown, downloadText } from "../lib/export";
import { uuid, now } from "../lib/ids";
import { isUncertain } from "../lib/calendar";
import { getEnginePrefs } from "../lib/prefs";
import type { ClassEntity, ClassMember, Folder, Job, Note, PaukenUser, Reminder, SourceKind, Syllabus } from "../lib/types";
import type { ActivityEvent } from "../lib/types";

function sourceIcon(kind: SourceKind) {
  if (kind === "audio") return { Icon: FileAudio, color: "text-accent bg-accent-softer" };
  if (kind === "pdf" || kind === "docx") return { Icon: FileText, color: "text-accent bg-accent-softer" };
  if (kind === "url") return { Icon: Link2, color: "text-accent bg-accent-softer" };
  return { Icon: FileText, color: "text-accent bg-accent-softer" };
}

function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d > 1 ? "s" : ""} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo > 1 ? "s" : ""} ago`;
  return `${Math.floor(mo / 12)} year${mo >= 24 ? "s" : ""} ago`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 7);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  if (d < soon) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { repo, engine, prefs, user, version, bump } = useApp();
  const [modal, setModal] = useState<NoteSource | null>(null);
  const [modalCategory, setModalCategory] = useState<"knowledge" | "practice" | undefined>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [classes, setClasses] = useState<ClassEntity[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const [showNewClass, setShowNewClass] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [showReminderForm, setShowReminderForm] = useState(false);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [reminderTime, setReminderTime] = useState(() => getEnginePrefs().defaultReminderTime);
  const [reminderClass, setReminderClass] = useState("");
  const [showFlagDate, setShowFlagDate] = useState(false);
  const [showFlagTime, setShowFlagTime] = useState(false);
  const [showFlagClass, setShowFlagClass] = useState(false);
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [showSyllabus, setShowSyllabus] = useState(false);
  const [showAllReminders, setShowAllReminders] = useState(false);
  const [showAllPolicies, setShowAllPolicies] = useState(false);
  const [showDeleteClass, setShowDeleteClass] = useState(false);
  const [syllabus, setSyllabus] = useState<Syllabus | null>(null);
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [serverUsers, setServerUsers] = useState<PaukenUser[]>([]);
  const [selectedAddUser, setSelectedAddUser] = useState("");
  const [pendingInvites, setPendingInvites] = useState<(ClassMember & { className: string })[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const activeClassId = searchParams.get("class");
  const activeFolderId = searchParams.get("folder");

  const activeClass = useMemo(
    () => classes.find((c) => c.id === activeClassId),
    [classes, activeClassId],
  );
  const activeFolder = useMemo(
    () => folders.find((f) => f.id === activeFolderId),
    [folders, activeFolderId],
  );
  const unitFolders = useMemo(
    () =>
      folders
        .filter((f) => f.classId === activeClassId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [folders, activeClassId],
  );
  const activeUnitNotes = useMemo(
    () => (activeFolderId ? notes.filter((n) => n.folderId === activeFolderId) : []),
    [notes, activeFolderId],
  );
  const knowledgeNotes = useMemo(
    () => activeUnitNotes.filter((n) => n.contentCategory !== "practice"),
    [activeUnitNotes],
  );
  const practiceNotes = useMemo(
    () => activeUnitNotes.filter((n) => n.contentCategory === "practice"),
    [activeUnitNotes],
  );

  const filteredNotes = useMemo(() => {
    if (activeFolderId) return activeUnitNotes;
    if (activeClassId) {
      const classFolderIds = new Set(unitFolders.map((f) => f.id));
      return notes.filter((n) => n.folderId && classFolderIds.has(n.folderId));
    }
    return notes;
  }, [notes, activeClassId, activeFolderId, unitFolders]);

  const searched = filteredNotes.filter((n) =>
    n.title.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    if (repo) {
      Promise.all([
        repo.listNotes(),
        repo.listClasses(),
        repo.listFolders(),
        repo.listReminders(),
      ]).then(([ns, cs, fs, rs]) => {
        setNotes(ns);
        setClasses(cs);
        setFolders(fs);
        const classIds = new Set(cs.map((c) => c.id));
        setReminders(
          rs.filter(
            (r) =>
              (!r.classId || classIds.has(r.classId)) &&
              (!r.completed || (r.completedAt && Date.now() - r.completedAt < 86400000)),
          ),
        );
        setReady(true);
      });
    }
  }, [repo, version]);

  useEffect(() => {
    if (!repo) return;
    repo.activeJobs().then(setActiveJobs).catch(() => {});
  }, [repo, version]);

  /* Load activity for the current class */
  useEffect(() => {
    if (!repo || !activeClassId) { setActivity([]); return; }
    let alive = true;
    (async () => {
      if (prefs.serverUrl && prefs.userKey) {
        const events = await fetchActivity(prefs.serverUrl, prefs.userKey, activeClassId);
        if (alive) setActivity(events);
      } else {
        const events = await repo.activityForClass(activeClassId);
        if (alive) setActivity(events);
      }
    })();
    return () => { alive = false; };
  }, [repo, activeClassId, prefs.serverUrl, prefs.userKey, version]);

  useEffect(() => {
    if (!repo || !activeClassId) { setMembers([]); setSyllabus(null); return; }
    repo.membersForClass(activeClassId).then(setMembers).catch(() => {});
    repo.listUsers().then(setServerUsers).catch(() => {});
    repo.syllabusForClass(activeClassId).then(setSyllabus).catch(() => setSyllabus(null));
  }, [repo, activeClassId, version]);

  /* Load pending invitations for the current user */
  useEffect(() => {
    if (!repo || !user) { setPendingInvites([]); return; }
    let alive = true;
    (async () => {
      const members = await repo.membersForUser(user.id);
      if (!alive) return;
      const pending = members.filter((m) => m.status === "pending" && m.role !== "owner");
      const withNames = await Promise.all(
        pending.map(async (m) => {
          const cls = await repo.getClass(m.classId);
          return { ...m, className: cls?.name ?? "Unknown class" };
        }),
      );
      if (alive) setPendingInvites(withNames);
    })();
    return () => { alive = false; };
  }, [repo, user, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleGenerate(result: CreateNoteResult) {
    if (!repo || !activeClassId) return;
    if (!engine) {
      navigate("/settings", { state: { msg: "Set up your API key before generating notes." } });
      return;
    }
    setErr(null);
    setModal(null);

    let folderId = activeFolderId || undefined;
    if (!folderId) {
      const existing = unitFolders;
      if (existing.length > 0) {
        folderId = existing[0].id;
      } else {
        try {
          const unit: Folder = { id: uuid(), name: "Unit 1", classId: activeClassId, createdAt: now() };
          await repo.putFolder(unit);
          folderId = unit.id;
        } catch {
          setErr("Could not create a unit folder. Check your server connection.");
          return;
        }
      }
    }

    navigate("/generation", {
      state: {
        inputs: result.inputs,
        language: prefs.language,
        generateStudyTools: result.generateStudyTools,
        contentCategory: result.contentCategory,
        topic: result.topic,
        contentScope: result.contentScope,
        classId: activeClassId,
        folderId,
      },
    });
  }

  async function createUnit() {
    if (!repo || !activeClassId) return;
    const count = folders.filter((f) => f.classId === activeClassId).length;
    const f: Folder = { id: uuid(), name: `Unit ${count + 1}`, classId: activeClassId, createdAt: now() };
    await repo.putFolder(f);
    setFolders((prev) => [...prev, f]);
  }

  async function createClass() {
    if (!repo || !newClassName.trim() || !user) return;
    const c: ClassEntity = {
      id: uuid(),
      name: newClassName.trim(),
      ownerId: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.putClass(c);
    const ownerMember: ClassMember = {
      id: `${c.id}-${user.id}-owner`,
      classId: c.id,
      userId: user.id,
      role: "owner",
      status: "active",
      joinedAt: now(),
    };
    await repo.putClassMember(ownerMember);
    setClasses((prev) => [...prev, c]);
    setNewClassName("");
    setShowNewClass(false);
  }

  async function addReminder() {
    if (!repo || !reminderTitle.trim()) return;
    let dueDate: number | undefined;
    if (reminderDue && showFlagDate) {
      const dt = new Date(
        `${reminderDue}T${showFlagTime ? reminderTime : "08:00"}:00`
      );
      dueDate = dt.getTime();
    }
    const r: Reminder = {
      id: uuid(),
      title: reminderTitle.trim(),
      text: "",
      classId: showFlagClass && reminderClass ? reminderClass : undefined,
      dueDate,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.putReminder(r);
    setReminders((prev) => [r, ...prev]);
    setReminderTitle("");
    setReminderDue("");
    setReminderTime(getEnginePrefs().defaultReminderTime);
    setReminderClass("");
    setShowFlagDate(false);
    setShowFlagTime(false);
    setShowFlagClass(false);
    setShowReminderForm(false);
  }

  async function acceptInvite(m: ClassMember & { className: string }) {
    if (!repo) return;
    await repo.putClassMember({ ...m, status: "active" });
    setPendingInvites((prev) => prev.filter((x) => x.id !== m.id));
    bump();
  }

  async function declineInvite(m: ClassMember & { className: string }) {
    if (!repo) return;
    await repo.removeClassMember(m.id);
    setPendingInvites((prev) => prev.filter((x) => x.id !== m.id));
  }

  async function toggleReminder(r: Reminder) {
    if (!repo) return;
    const next = { ...r, completed: !r.completed, completedAt: r.completed ? undefined : now(), updatedAt: now() };
    await repo.putReminder(next);
    setReminders((prev) => prev.map((x) => (x.id === r.id ? next : x)));
  }

  async function deleteReminder(id: string) {
    if (!repo) return;
    await repo.deleteReminder(id);
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }

  function openModal(source: NoteSource, category: "knowledge" | "practice") {
    setModalCategory(category);
    setModal(source);
  }

  async function moveNoteToFolder(noteId: string, targetFolderId: string) {
    if (!repo) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note || note.folderId === targetFolderId) return;
    const updated = { ...note, folderId: targetFolderId, updatedAt: now() };
    await repo.putNote(updated);
    setNotes((prev) => prev.map((n) => (n.id === noteId ? updated : n)));
  }

  function onDragStart(noteId: string) {
    setDraggedNoteId(noteId);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function onDrop(targetFolderId: string) {
    if (draggedNoteId) {
      moveNoteToFolder(draggedNoteId, targetFolderId);
      setDraggedNoteId(null);
    }
  }

  const inClassView = !!activeClassId;
  const canDeleteClass = !!activeClass && (!user || activeClass.ownerId === user.id);
  const headerTitle = activeFolder
    ? activeFolder.name
    : activeClass
      ? activeClass.name
      : "Dashboard";
  const headerSub = activeFolder
    ? `${activeFolder.name} — ${activeClass?.name || "class"}`
    : activeClass
      ? "Class"
      : "Pauken";

  return (
    <div className="px-10 py-8">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          {inClassView && (
            <button
              onClick={() => navigate("/")}
              className="rounded-lg p-1.5 text-ink-faint hover:bg-card-hover hover:text-ink"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
          <div>
            <h1 className="text-4xl font-bold tracking-tight">{headerTitle}</h1>
            <p className="mt-1 text-lg text-ink-faint">{headerSub}</p>
          </div>
        </div>
        {!inClassView && (
          <label className="flex w-72 items-center gap-2 rounded-lg border border-edge bg-card px-3 py-2 text-ink-faint shadow-soft">
            <Search className="size-4" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search (⌘K)"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
          </label>
        )}
        {activeJobs.length > 0 && (
          <div className="flex items-center gap-2 rounded-card border border-edge bg-card px-4 py-2 shadow-soft">
            <Loader2 className="size-4 animate-spin text-accent" />
            <span className="text-sm font-medium text-ink-dim">
              Generating {activeJobs.length === 1 ? "note" : `${activeJobs.length} notes`}&hellip;
            </span>
          </div>
        )}
      </div>

      {!ready ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="size-6 animate-spin text-accent" />
        </div>
      ) : (
        <>
      {inClassView && (
        <>
          {syllabus && !activeFolderId && (
            <div className="mt-6 rounded-card border border-edge bg-card p-5 shadow-soft">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-lg font-bold">
                      {syllabus.courseTitle || activeClass?.name}
                    </h2>
                    {syllabus.courseCode && (
                      <span className="rounded bg-accent-softer px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                        {syllabus.courseCode}
                      </span>
                    )}
                    {syllabus.term && (
                      <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
                        {syllabus.term}
                      </span>
                    )}
                    {syllabus.institution && (
                      <span className="text-xs text-ink-faint">{syllabus.institution}</span>
                    )}
                  </div>
                  {(syllabus.grading.length > 0 || syllabus.officeHours) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {syllabus.grading.map((g) => (
                        <span key={g.category} className="rounded-lg bg-panel px-2 py-1 text-xs text-ink-dim">
                          <span className="font-semibold text-ink">{g.weightPct}%</span> {g.category}
                        </span>
                      ))}
                      {syllabus.officeHours && (
                        <span className="rounded-lg bg-panel px-2 py-1 text-xs text-ink-dim">
                          <Clock className="mr-1 inline size-3" />
                          {syllabus.officeHours}
                        </span>
                      )}
                    </div>
                  )}
                  {syllabus.instructors.length > 0 && (
                    <div className="mt-2 space-y-0.5 text-xs text-ink-faint">
                      {syllabus.instructors.slice(0, 2).map((i) => (
                        <p key={i.name} className="truncate">
                          {i.name}
                          {i.email ? ` · ${i.email}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                  {syllabus.policies.length > 0 && (
                    <div className="mt-2 text-xs text-ink-faint">
                      {showAllPolicies ? (
                        <ul className="list-inside list-disc space-y-0.5">
                          {syllabus.policies.map((p) => (
                            <li key={p} className="truncate">{p}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="truncate">{syllabus.policies.slice(0, 2).join(" · ")}</p>
                      )}
                      <button
                        onClick={() => setShowAllPolicies((v) => !v)}
                        className="mt-1 font-semibold text-accent hover:underline"
                      >
                        {showAllPolicies
                          ? "Hide policies"
                          : `Show all policies (${syllabus.policies.length})`}
                      </button>
                    </div>
                  )}
                </div>
                <UpcomingEvents events={syllabus.events} />
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-lg font-bold">Units</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSyllabus(true)}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:bg-card-hover active:scale-[0.98]"
              >
                <ScrollText className="size-4" />
                Syllabus
              </button>
              <button
                onClick={() => setShowMembers(true)}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:bg-card-hover active:scale-[0.98]"
              >
                <Users className="size-4" />
                Members
              </button>
              <button
                onClick={activeFolderId ? () => openModal("document", "knowledge") : createUnit}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:bg-card-hover active:scale-[0.98]"
              >
                {activeFolderId ? <BookOpen className="size-4" /> : <Plus className="size-4" />}
                {activeFolderId ? "Add Knowledge" : "New Unit"}
              </button>
              {canDeleteClass && (
                <button
                  onClick={() => setShowDeleteClass(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-danger-ink/30 bg-card px-4 py-2 text-sm font-semibold text-danger-ink shadow-soft transition hover:bg-danger-soft"
                >
                  <Trash2 className="size-4" />
                  Delete Class
                </button>
              )}
            </div>
          </div>

          {activeFolderId ? (
            <div className="mt-4 space-y-6">
              {/* Knowledge Base section */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BookOpen className="size-4 text-accent" />
                    <h3 className="font-display font-bold">Knowledge Base</h3>
                  </div>
                  <button
                    onClick={() => openModal("document", "knowledge")}
                    className="flex items-center gap-1 rounded-lg border border-edge bg-card px-3 py-1.5 text-xs font-semibold text-ink-dim shadow-soft hover:bg-card-hover"
                  >
                    <Plus className="size-3" /> Add
                  </button>
                </div>
                {knowledgeNotes.length === 0 && (
                  <p className="mt-2 text-sm text-ink-faint">No study material yet.</p>
                )}
                <div className="mt-2 space-y-2">
                  {knowledgeNotes.map((n) => (
                    <NoteRow
                      key={n.id}
                      note={n}
                      onDragStart={onDragStart}
                      repo={repo}
                      bump={bump}
                      navigate={navigate}
                    />
                  ))}
                </div>
              </div>

              {/* Practice section */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Pencil className="size-4 text-accent" />
                    <h3 className="font-display font-bold">Practice Problems</h3>
                  </div>
                  <button
                    onClick={() => openModal("document", "practice")}
                    className="flex items-center gap-1 rounded-lg border border-edge bg-card px-3 py-1.5 text-xs font-semibold text-ink-dim shadow-soft hover:bg-card-hover"
                  >
                    <Plus className="size-3" /> Add
                  </button>
                </div>
                {practiceNotes.length === 0 && (
                  <p className="mt-2 text-sm text-ink-faint">No practice problems yet.</p>
                )}
                <div className="mt-2 space-y-2">
                  {practiceNotes.map((n) => (
                    <NoteRow
                      key={n.id}
                      note={n}
                      onDragStart={onDragStart}
                      repo={repo}
                      bump={bump}
                      navigate={navigate}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => navigate(`/practice?class=${activeClassId}`)}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:bg-accent-hover"
                >
                  <Play className="size-4" />
                  Practice
                </button>
              </div>
              {unitFolders.length === 0 && !activeFolderId && (
                <p className="mt-4 text-sm text-ink-faint">No units yet. Upload material to create one.</p>
              )}
              <div className="mt-4 space-y-3">
                {unitFolders.map((f) => (
                  <div key={f.id}>
                    <button
                      onClick={() => navigate(`/?class=${activeClassId}&folder=${f.id}`)}
                      className="flex w-full items-center gap-3 rounded-card border border-edge bg-card p-4 text-left shadow-soft transition hover:-translate-y-0.5 hover:bg-card-hover"
                    >
                      <FolderPlus className="size-5 shrink-0 text-accent" />
                      <span className="font-display font-bold">{f.name}</span>
                      <ChevronRight className="ml-auto size-4 shrink-0 text-ink-faint" />
                    </button>
                    <div
                      className="ml-6 mt-1 min-h-[2px] rounded"
                      onDragOver={onDragOver}
                      onDrop={() => onDrop(f.id)}
                    >
                      {notes
                        .filter((n) => n.folderId === f.id)
                        .slice(0, 3)
                        .map((n) => (
                          <button
                            key={n.id}
                            onClick={() => navigate(`/notes/${n.id}/editor`)}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-ink-faint hover:bg-card-hover hover:text-ink"
                          >
                            <FileText className="size-3.5 shrink-0" />
                            <span className="truncate">{n.title}</span>
                            {n.contentCategory === "practice" && (
                              <span className="shrink-0 rounded bg-accent-softer px-1.5 py-0.5 text-[10px] font-semibold text-accent">P</span>
                            )}
                          </button>
                        ))}
                      {notes.filter((n) => n.folderId === f.id).length > 3 && (
                        <p className="px-3 py-1 text-xs text-ink-faint">
                          +{notes.filter((n) => n.folderId === f.id).length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {activity.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-bold text-ink-faint">Partner Activity</h3>
              <div className="mt-2 space-y-1.5">
                {activity.slice(0, 5).map((e) => (
                  <div key={e.id} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-softer text-[10px] font-bold text-accent">
                      {e.userName.charAt(0).toUpperCase()}
                    </span>
                    <span className="text-ink-dim">
                      <span className="font-semibold text-ink">{e.userName}</span> {e.details}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-ink-faint">
                      {relTime(e.at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {err && (
            <div className="mt-4 rounded-lg border border-danger-ink/30 bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-ink">
              {err}
            </div>
          )}
        </>
      )}

      {!inClassView && (
        <>
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Your Classes</h2>
              <button
                onClick={() => { setNewClassName(""); setShowNewClass(true); }}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:bg-card-hover"
              >
                <Plus className="size-4" />
                New Class
              </button>
            </div>

            {showNewClass && (
              <div className="mt-3 flex gap-2">
                <input
                  autoFocus
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createClass()}
                  placeholder="Class name…"
                  className="flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
                />
                <button
                  onClick={createClass}
                  disabled={!newClassName.trim()}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowNewClass(false); setNewClassName(""); }}
                  className="rounded-lg px-3 py-2 text-sm text-ink-faint hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            )}

            {classes.length > 0 ? (
              <div className="mt-4 grid grid-cols-2 gap-4 xl:grid-cols-3">
                {classes.map((c) => {
                  const classFolderCount = folders.filter((f) => f.classId === c.id).length;
                  const classNoteCount = notes.filter((n) => {
                    const classFolderIds = new Set(folders.filter((f) => f.classId === c.id).map((f) => f.id));
                    return n.folderId && classFolderIds.has(n.folderId);
                  }).length;
                  return (
                    <button
                      key={c.id}
                      onClick={() => navigate(`/?class=${c.id}`)}
                      className="group flex flex-col gap-2 rounded-card border border-edge bg-card p-5 text-left shadow-soft transition hover:-translate-y-0.5 hover:bg-card-hover"
                    >
                      <span className="flex size-10 items-center justify-center rounded-lg bg-accent-softer">
                        <BookOpen className="size-5 text-accent" />
                      </span>
                      <span className="font-display text-lg font-bold">{c.name}</span>
                      <span className="text-sm text-ink-faint">
                        {classFolderCount} unit{classFolderCount !== 1 ? "s" : ""} · {classNoteCount} note{classNoteCount !== 1 ? "s" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-8 flex flex-col items-center gap-3 py-12 text-center">
                <BookOpen className="size-12 text-ink-faint" />
                <p className="font-display text-lg font-semibold text-ink-dim">No classes yet</p>
                <p className="max-w-md text-sm text-ink-faint">
                  Create a class to organize your notes, study material, and practice problems —
                  everything lives inside a class.
                </p>
                <button
                  onClick={() => { setNewClassName(""); setShowNewClass(true); }}
                  className="mt-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-bold text-white hover:bg-accent-hover"
                >
                  Create your first class
                </button>
              </div>
            )}
          </div>

          {/* Pending Invitations */}
          {pendingInvites.length > 0 && (
            <div className="mt-10">
              <h2 className="text-lg font-bold">Pending Invitations</h2>
              <div className="mt-3 space-y-2">
                {pendingInvites.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 rounded-card border border-edge bg-card p-4 shadow-soft"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                      ?
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">
                        Invitation to <strong>{m.className}</strong>
                      </p>
                      <p className="text-xs text-ink-faint">
                        You've been invited to join this class
                      </p>
                    </div>
                    <button
                      onClick={() => acceptInvite(m)}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-hover"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => declineInvite(m)}
                      className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-ink-faint hover:text-ink"
                    >
                      Decline
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick Reminders */}
          <div className="mt-10">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Quick Reminders</h2>
              <button
                onClick={() => setShowReminderForm(true)}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:bg-card-hover"
              >
                <Plus className="size-4" />
                Add Reminder
              </button>
            </div>

            {showReminderForm && (
              <div
                className="mt-3 rounded-card border border-edge bg-card p-4 shadow-soft"
              >
                <div
                  className="flex gap-2"
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addReminder(); } }}
                >
                  <input
                    autoFocus
                    value={reminderTitle}
                    onChange={(e) => setReminderTitle(e.target.value)}
                    placeholder="Reminder title… press Enter to save"
                    className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
                  />
                  <button
                    onClick={addReminder}
                    disabled={!reminderTitle.trim()}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                  >
                    Save
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setShowFlagDate(!showFlagDate)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      showFlagDate
                        ? "border-accent bg-accent text-white"
                        : "border-edge text-ink-faint hover:text-ink"
                    }`}
                  >
                    Date
                  </button>
                  <button
                    onClick={() => setShowFlagTime(!showFlagTime)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      showFlagTime
                        ? "border-accent bg-accent text-white"
                        : "border-edge text-ink-faint hover:text-ink"
                    }`}
                  >
                    Time
                  </button>
                  <button
                    onClick={() => setShowFlagClass(!showFlagClass)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      showFlagClass
                        ? "border-accent bg-accent text-white"
                        : "border-edge text-ink-faint hover:text-ink"
                    }`}
                  >
                    Class
                  </button>
                  <div className="ml-auto flex gap-2">
                    <button
                      onClick={() => { setShowReminderForm(false); setReminderTitle(""); setReminderDue(""); setReminderTime(getEnginePrefs().defaultReminderTime); setReminderClass(""); setShowFlagDate(false); setShowFlagTime(false); setShowFlagClass(false); }}
                      className="rounded-lg border border-edge px-2.5 py-1 text-xs font-semibold text-ink-faint hover:text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {(showFlagDate || showFlagTime) && (
                  <div className="mt-2 flex items-center gap-3">
                    {showFlagDate && (
                      <input
                        type="date"
                        value={reminderDue}
                        onChange={(e) => setReminderDue(e.target.value)}
                        className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs outline-none text-ink-dim"
                      />
                    )}
                    {showFlagTime && (
                      <input
                        type="time"
                        value={reminderTime}
                        onChange={(e) => setReminderTime(e.target.value)}
                        className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs outline-none text-ink-dim"
                        aria-label="Reminder time"
                      />
                    )}
                  </div>
                )}
                {showFlagClass && classes.length > 0 && (
                  <div className="mt-2">
                    <select
                      value={reminderClass}
                      onChange={(e) => setReminderClass(e.target.value)}
                      className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs outline-none text-ink-dim"
                    >
                      <option value="">No class</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 space-y-2">
              {(() => {
                const incomplete = reminders
                  .filter((r) => !r.completed)
                  .sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
                const visible = showAllReminders ? incomplete : incomplete.slice(0, 5);
                if (visible.length === 0 && !showReminderForm) {
                  return <p className="text-sm text-ink-faint">No reminders</p>;
                }
                return visible.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-start gap-3 rounded-card border border-edge bg-card p-3 shadow-soft"
                  >
                    <button
                      onClick={() => toggleReminder(r)}
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                        r.completed ? "border-accent bg-accent" : "border-edge"
                      }`}
                    >
                      {r.completed && <Check className="size-3 text-white" />}
                    </button>
                    {isUncertain(r.dueDate, r.dateEnd) && (
                      <CircleHelp
                        className="mt-0.5 size-4 shrink-0 text-callout-ink"
                        aria-label="Due date is only the start of a range"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm font-semibold ${r.completed ? "text-ink-faint line-through" : "text-ink"}`}>
                        {r.title}
                      </p>
                      {r.text && (
                        <p className={`mt-0.5 truncate text-xs ${r.completed ? "text-ink-faint" : "text-ink-dim"}`}>
                          {r.text}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-2">
                        {r.dueDate && (
                          <span className="inline-flex items-center gap-1 rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
                            <Calendar className="size-3" />
                            {formatDate(r.dueDate)}
                            {isUncertain(r.dueDate, r.dateEnd) &&
                              r.dateEnd && ` – ${formatDate(r.dateEnd)}`}
                          </span>
                        )}
                        {r.classId && (() => {
                          const cl = classes.find((c) => c.id === r.classId);
                          return cl ? (
                            <span className="rounded bg-accent-softer px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                              {cl.name}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteReminder(r.id)}
                      className="shrink-0 rounded p-1 text-ink-faint hover:text-danger-ink"
                      aria-label="Delete reminder"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ));
              })()}
              {reminders.filter((r) => !r.completed).length > 5 && (
                <button
                  onClick={() => setShowAllReminders((v) => !v)}
                  className="w-full rounded-lg border border-edge bg-card px-3 py-1.5 text-xs font-semibold text-ink-dim shadow-soft transition hover:bg-card-hover"
                >
                  {showAllReminders
                    ? "Show less"
                    : `Show more (${reminders.filter((r) => !r.completed).length - 5})`}
                </button>
              )}
            </div>
          </div>

          {/* Recent notes across all classes */}
          {searched.length > 0 && (
            <div className="mt-6 space-y-6">
              {searched.some((n) => Date.now() - n.lastOpenedAt < 86400000) && (
                <Group
                  label="Today"
                  notes={searched.filter((n) => Date.now() - n.lastOpenedAt < 86400000)}
                  repo={repo}
                  bump={bump}
                  navigate={navigate}
                />
              )}
              {searched.some((n) => Date.now() - n.lastOpenedAt >= 86400000) && (
                <Group
                  label="Earlier"
                  notes={searched.filter((n) => Date.now() - n.lastOpenedAt >= 86400000)}
                  repo={repo}
                  bump={bump}
                  navigate={navigate}
                />
              )}
            </div>
          )}

          {searched.length === 0 && classes.length > 0 && (
            <Empty
              title={query ? "No matching notes" : "No recent notes"}
              sub={
                query
                  ? "Try a different search."
                  : "Open a class to create study material."
              }
            />
          )}
        </>
      )}

      {modal && (
        <CreateNoteModal
          source={modal}
          contentCategory={modalCategory}
          onGenerate={handleGenerate}
          onClose={() => { setModal(null); setModalCategory(undefined); }}
          classId={activeClassId || undefined}
          existingTopics={unitFolders.length > 0 && activeFolderId ? (() => {
            const unitNotes = notes.filter((n) => n.folderId === activeFolderId);
            return deduplicateTopics(unitNotes.map((n) => n.topic).filter(Boolean) as string[]);
          })() : undefined}
          onNewUnit={() => { setModal(null); createUnit(); }}
        />
      )}

      {showSyllabus && activeClass && (
        <SyllabusModal
          classId={activeClass.id}
          className={activeClass.name}
          onClose={() => setShowSyllabus(false)}
          onApplied={() => {
            setShowSyllabus(false);
            bump();
          }}
        />
      )}

      {showMembers && activeClass && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 transition-opacity"
          onClick={() => { setShowMembers(false); setSelectedAddUser(""); }}
        >
          <div
            className="w-[480px] max-w-[90vw] rounded-modal bg-card p-6 shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-bold text-ink">Class Members</h2>
              <button
                onClick={() => { setShowMembers(false); setSelectedAddUser(""); }}
                className="rounded-lg p-1.5 text-ink-faint hover:bg-card-hover hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </div>
            <p className="mt-1 text-sm text-ink-faint">{activeClass.name}</p>

            <div className="mt-4 space-y-2">
              {members.map((m) => {
                const u = serverUsers.find((su) => su.id === m.userId);
                const name = u?.name ?? m.userId.slice(0, 8);
                const isOwner = m.role === "owner";
                const isSelf = user && m.userId === user.id;
                return (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 rounded-xl border border-edge bg-panel px-4 py-3"
                  >
                    {u?.avatar ? (
                      <img src={u.avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-softer text-xs font-bold text-accent">
                        {name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-semibold">{name}</span>
                      {isSelf && <span className="ml-2 text-xs text-ink-faint">(you)</span>}
                    </div>
                    {(m.status === "pending") && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        Pending
                      </span>
                    )}
                    <span className="rounded bg-accent-softer px-2 py-0.5 text-[10px] font-semibold text-accent">
                      {isOwner ? "Owner" : "Member"}
                    </span>
                    {!isOwner && !isSelf && repo && (
                      <button
                        onClick={async () => {
                          await repo.removeClassMember(m.id);
                          setMembers((prev) => prev.filter((x) => x.id !== m.id));
                        }}
                        className="rounded-lg p-1.5 text-ink-faint hover:text-danger-ink"
                        aria-label="Remove member"
                      >
                        <UserMinus className="size-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {user && user.id === activeClass.ownerId && serverUsers.length > members.length && (
              <div className="mt-4 flex items-center gap-2 border-t border-edge pt-4">
                <select
                  value={selectedAddUser}
                  onChange={(e) => setSelectedAddUser(e.target.value)}
                  className="flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none text-ink-dim"
                >
                  <option value="">Add a user…</option>
                  {serverUsers
                    .filter((su) => !members.some((m) => m.userId === su.id))
                    .map((su) => (
                      <option key={su.id} value={su.id}>{su.name}</option>
                    ))}
                </select>
                <button
                  disabled={!selectedAddUser}
                  onClick={async () => {
                    if (!repo || !activeClassId) return;
                    const newMember: ClassMember = {
                      id: uuid(),
                      classId: activeClassId,
                      userId: selectedAddUser,
                      role: "member",
                      status: "pending",
                      joinedAt: now(),
                    };
                    await repo.putClassMember(newMember);
                    setMembers((prev) => [...prev, newMember]);
                    setSelectedAddUser("");
                  }}
                  className="flex items-center gap-1 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  <UserPlus className="size-4" />
                  Invite
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showDeleteClass && activeClass && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 transition-opacity"
          onClick={() => setShowDeleteClass(false)}
        >
          <div
            className="w-[400px] max-w-[92vw] rounded-modal bg-card p-6 shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-xl font-bold text-ink">Delete class?</h2>
            <p className="mt-2 text-sm text-ink-dim">
              This permanently deletes <strong>{activeClass.name}</strong> and everything in it —
              notes, practice problems, syllabus, and reminders. This cannot be undone.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDeleteClass(false)}
                className="rounded-lg border border-edge px-4 py-2 text-sm font-semibold text-ink-dim hover:bg-card-hover"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!repo || !activeClass) return;
                  await repo.deleteClass(activeClass.id);
                  setShowDeleteClass(false);
                  bump();
                  navigate("/");
                }}
                className="flex items-center gap-1.5 rounded-lg bg-danger-ink px-4 py-2 text-sm font-bold text-white hover:opacity-90"
              >
                <Trash2 className="size-4" />
                Delete class
              </button>
            </div>
          </div>
        </div>
      )}


      </>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onDragStart,
  repo,
  bump,
  navigate,
}: {
  note: Note;
  onDragStart: (id: string) => void;
  repo: ReturnType<typeof useApp>["repo"];
  bump: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { Icon, color } = sourceIcon(note.sourceKind);

  return (
    <div
      draggable
      onDragStart={() => onDragStart(note.id)}
      onClick={() => navigate(`/notes/${note.id}/editor`)}
      className="group flex cursor-grab items-center gap-4 rounded-card border border-edge bg-card p-3 shadow-soft transition hover:-translate-y-0.5 hover:bg-card-hover active:cursor-grabbing"
    >
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display font-bold">{note.title}</p>
        <p className="text-sm text-ink-faint">Last opened {relTime(note.lastOpenedAt)}</p>
      </div>
      <RowMenu
        onExport={() =>
          downloadText(`${note.title}.md`, exportMarkdown(note), "text/markdown")
        }
        onDelete={async () => {
          await repo?.deleteNote(note.id);
          bump();
        }}
      />
    </div>
  );
}

function Group({
  label,
  notes,
  repo,
  bump,
  navigate,
}: {
  label: string;
  notes: Note[];
  repo: ReturnType<typeof useApp>["repo"];
  bump: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-ink-faint">{label}</p>
      <div className="space-y-3">
        {notes.map((n) => {
          const { Icon, color } = sourceIcon(n.sourceKind);
          return (
            <div
              key={n.id}
              onClick={() => navigate(`/notes/${n.id}/editor`)}
              className="group flex cursor-pointer items-center gap-4 rounded-card border border-edge bg-card p-4 shadow-soft transition hover:-translate-y-0.5 hover:bg-card-hover"
            >
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${color}`}>
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display font-bold">{n.title}</p>
                <p className="text-sm text-ink-faint">Last opened {relTime(n.lastOpenedAt)}</p>
              </div>
              <RowMenu
                onExport={() =>
                  downloadText(`${n.title}.md`, exportMarkdown(n), "text/markdown")
                }
                onDelete={async () => {
                  await repo?.deleteNote(n.id);
                  bump();
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowMenu({ onExport, onDelete }: { onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-2 text-ink-faint opacity-0 transition hover:bg-card-hover hover:text-ink group-hover:opacity-100"
        aria-label="More"
      >
        <MoreVertical className="size-4.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-edge bg-card p-1 shadow-modal">
            <button
              onClick={() => {
                onExport();
                setOpen(false);
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-card-hover"
            >
              Export Markdown
            </button>
            <button
              onClick={() => {
                onDelete();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger-ink hover:bg-danger-soft"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mt-10 flex flex-col items-center gap-1 py-16 text-center">
      <p className="font-display text-lg font-semibold text-ink-dim">{title}</p>
      <p className="text-sm text-ink-faint">{sub}</p>
    </div>
  );
}

/* Next few dated assessments from the syllabus, newest first list. */
function UpcomingEvents({ events }: { events: Syllabus["events"] }) {
  const upcoming = events
    .filter(
      (e): e is Syllabus["events"][number] & { dateStart: number } =>
        e.dateStart !== undefined && e.dateStart >= Date.now() - 86400000,
    )
    .sort((a, b) => a.dateStart - b.dateStart)
    .slice(0, 3);

  if (upcoming.length === 0) return null;

  return (
    <div className="w-full space-y-1.5 rounded-xl bg-panel p-3 lg:max-w-none">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">
        Upcoming
      </p>
      {upcoming.map((e) => (
        <div
          key={e.id}
          className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs shadow-soft"
        >
          <Calendar className="size-3.5 shrink-0 text-accent" />
          {isUncertain(e.dateStart, e.dateEnd) && (
            <CircleHelp className="size-3.5 shrink-0 text-callout-ink" />
          )}
          <span className="truncate font-semibold text-ink-dim">{e.title}</span>
          <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
            {formatDate(e.dateStart)}
            {isUncertain(e.dateStart, e.dateEnd) && e.dateEnd
              ? ` – ${formatDate(e.dateEnd)}`
              : ""}
            {e.time ? ` · ${e.time}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
