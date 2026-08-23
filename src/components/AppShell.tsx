import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CalendarDays,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Palette,
  PenLine,
  Pencil,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import { useApp } from "../lib/app";
import { toggleTheme } from "../lib/theme";
import { uuid, now } from "../lib/ids";
import type { ClassEntity, ClassMember, Folder as FolderType, Note } from "../lib/types";

const navItems = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/practice", label: "Practice", icon: Pencil },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function AppShell() {
  const { repo, user, prefs } = useApp();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [classes, setClasses] = useState<ClassEntity[]>([]);
  const [folders, setFolders] = useState<FolderType[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [newClassName, setNewClassName] = useState("");
  const [showNewClass, setShowNewClass] = useState(false);

  useEffect(() => {
    if (!repo) return;
    Promise.all([
      repo.listClasses(),
      repo.listFolders(),
      repo.listNotes(),
    ]).then(([cs, fs, ns]) => {
      setClasses(cs);
      setFolders(fs);
      setNotes(ns);
    });
  }, [repo]);

  async function createClass() {
    if (!repo || !newClassName.trim()) return;
    const c: ClassEntity = {
      id: uuid(),
      name: newClassName.trim(),
      ownerId: user?.id ?? "",
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.putClass(c);
    const ownerMember: ClassMember = {
      id: `${c.id}-${user?.id ?? ""}-owner`,
      classId: c.id,
      userId: user?.id ?? "",
      role: "owner",
      status: "active",
      joinedAt: now(),
    };
    await repo.putClassMember(ownerMember);
    setClasses((prev) => [...prev, c]);
    setNewClassName("");
    setShowNewClass(false);
  }

  function foldersForClass(classId: string) {
    return folders
      .filter((f) => f.classId === classId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function notesForFolder(folderId: string) {
    return notes.filter((n) => n.folderId === folderId);
  }

  return (
    <div className="flex h-full bg-bg">
      <aside
        className={`flex shrink-0 flex-col border-r border-edge bg-panel transition-all ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-5">
          {!collapsed && (
            <div className="flex items-center gap-2">
              <PenLine className="size-5 text-accent" />
              <span className="font-display text-lg font-semibold tracking-tight">
                pauken
              </span>
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-lg p-1.5 text-ink-dim hover:bg-card-hover hover:text-ink"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${
                  isActive
                    ? "bg-card-hover text-ink"
                    : "text-ink-dim hover:bg-card-hover hover:text-ink"
                }`
              }
            >
              <Icon className="size-4.5 shrink-0" />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>

        {!collapsed && (
          <div className="mt-4 px-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Classes
              </span>
              <button
                onClick={() => { setNewClassName(""); setShowNewClass(true); }}
                className="rounded-lg p-0.5 text-ink-faint hover:text-ink"
                aria-label="New class"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {showNewClass && (
              <div className="mt-2 flex gap-1">
                <input
                  autoFocus
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createClass()}
                  placeholder="Class name…"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-card px-2 py-1 text-xs outline-none focus:border-accent"
                />
                <button
                  onClick={() => { setShowNewClass(false); setNewClassName(""); }}
                  className="rounded-lg px-1.5 text-xs text-ink-faint hover:text-ink"
                >
                  Esc
                </button>
              </div>
            )}
            <div className="mt-2 space-y-0.5">
              {classes.map((c) => {
                const isExpanded = expandedClasses.has(c.id);
                const unitFolders = foldersForClass(c.id);
                return (
                  <div key={c.id}>
                    <button
                      onClick={() => {
                        setExpandedClasses((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        });
                        navigate(`/?class=${c.id}`);
                      }}
                      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${
                        isExpanded ? "bg-card-hover text-ink" : "text-ink-dim hover:bg-card-hover hover:text-ink"
                      }`}
                    >
                      {unitFolders.length > 0 ? (
                        <ChevronDown className={`size-3.5 shrink-0 transition ${isExpanded ? "" : "-rotate-90"}`} />
                      ) : (
                        <span className="size-3.5 shrink-0" />
                      )}
                      <Folder className="size-4 shrink-0" />
                      <span className="truncate">{c.name}</span>
                    </button>
                    {isExpanded && (
                      <div className="ml-4 space-y-0.5 border-l border-edge pl-2">
                        {unitFolders.map((f) => {
                          const isFolderExpanded = expandedFolders.has(f.id);
                          const topicNotes = notesForFolder(f.id);
                          return (
                            <div key={f.id}>
                              <button
                                onClick={() => {
                                  setExpandedFolders((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(f.id)) next.delete(f.id);
                                    else next.add(f.id);
                                    return next;
                                  });
                                  navigate(`/?class=${c.id}&folder=${f.id}`);
                                }}
                                className={`flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium ${
                                  isFolderExpanded ? "text-ink" : "text-ink-dim hover:text-ink"
                                }`}
                              >
                                {topicNotes.length > 0 ? (
                                  <ChevronDown className={`size-3 shrink-0 transition ${isFolderExpanded ? "" : "-rotate-90"}`} />
                                ) : (
                                  <span className="size-3 shrink-0" />
                                )}
                                <FolderPlus className="size-3.5 shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </button>
                              {isFolderExpanded && topicNotes.map((n) => (
                                <button
                                  key={n.id}
                                  onClick={() => navigate(`/notes/${n.id}/editor`)}
                                  className="ml-4 flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-sm text-ink-faint hover:bg-card-hover hover:text-ink"
                                >
                                  <FileText className="size-3.5 shrink-0" />
                                  <span className="truncate">{n.title}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {classes.length === 0 && (
                <p className="px-3 py-2 text-xs text-ink-faint">No classes yet</p>
              )}
            </div>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-1 px-3 pb-4">
          <button
            onClick={() => toggleTheme()}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-dim hover:bg-card-hover hover:text-ink"
          >
            <Palette className="size-4.5 shrink-0" />
            {!collapsed && "Theme"}
          </button>
          <button
            onClick={() => navigate("/settings")}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-ink-dim hover:bg-card-hover hover:text-ink"
          >
            {prefs.avatar ? (
              <img src={prefs.avatar} alt="" className="size-7 rounded-full object-cover" />
            ) : (
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-softer font-display text-xs font-bold text-accent">
                {user ? user.name.charAt(0).toUpperCase() : "?"}
              </div>
            )}
            {!collapsed && <span className="truncate text-sm font-semibold">{user?.name ?? "Offline"}</span>}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
