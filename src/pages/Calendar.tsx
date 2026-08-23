import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useApp } from "../lib/app";
import { uuid, now } from "../lib/ids";
import {
  classColor,
  formatRange,
  isSameDay,
  isUncertain,
  monthGrid,
  monthLabel,
  startOfDay,
  startOfWeek,
  weekDays,
  weekLabel,
  WEEKDAYS,
} from "../lib/calendar";
import type { ClassEntity, Reminder, Syllabus } from "../lib/types";

const KIND_LABEL: Record<string, string> = {
  exam: "Exam",
  quiz: "Quiz",
  final: "Final",
  homework: "Homework",
  break: "Break",
  other: "Other",
};

const chipClass = (kind: string) =>
  kind === "reminder" || kind === "exam" || kind === "final" || kind === "homework"
    ? "bg-accent-softer text-accent"
    : "bg-panel text-ink-faint";

interface CalendarItem {
  key: string;
  date: number;
  kind: string;
  title: string;
  time?: string;
  /* End of a date range when `date` is just its start (uncertain). */
  dateEnd?: number;
  classId?: string;
  reminder?: Reminder;
}

function timeFromMs(ms: number): string | undefined {
  const d = new Date(ms);
  if (d.getHours() === 0 && d.getMinutes() === 0) return undefined;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dateInput(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dueFromParts(dateInputVal: string, timeInputVal: string): number {
  const [y, m, d] = dateInputVal.split("-").map(Number);
  let hour = 0;
  let minute = 0;
  if (timeInputVal) {
    const [hh, mm] = timeInputVal.split(":").map(Number);
    hour = hh;
    minute = mm;
  }
  return new Date(y, (m ?? 1) - 1, d ?? 1, hour, minute).getTime();
}

export default function CalendarPage() {
  const { repo } = useApp();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [syllabi, setSyllabi] = useState<Syllabus[]>([]);
  const [classes, setClasses] = useState<ClassEntity[]>([]);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [viewMode, setViewMode] = useState<"month" | "week">("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now()));
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  /* Reminder being edited in the popover opened from a chip click. */
  const [editing, setEditing] = useState<Reminder | null>(null);
  /* null = all classes; otherwise the set of selected class ids. */
  const [classFilter, setClassFilter] = useState<Set<string> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = async () => {
    if (!repo) return;
    const [rs, ss, cs] = await Promise.all([
      repo.listReminders(),
      repo.listSyllabi(),
      repo.listClasses(),
    ]);
    setReminders(rs);
    setSyllabi(ss);
    setClasses(cs);
  };

  useEffect(() => {
    reload();
  }, [repo]);

  const classById = useMemo(
    () => new Map(classes.map((c) => [c.id, c.name])),
    [classes],
  );

  const classColorById = useMemo(
    () => new Map(classes.map((c) => [c.id, classColor(c.id)])),
    [classes],
  );

  /* One pass over all data: group items by local-midnight day, dedupe
     syllabus events against reminders, and sort within each day by time. */
  const byDay = useMemo(() => {
    const out = new Map<number, CalendarItem[]>();
    const seen = new Set<string>();
    const add = (i: CalendarItem) => {
      const day = startOfDay(i.date);
      const arr = out.get(day);
      if (arr) arr.push(i);
      else out.set(day, [i]);
    };
    /* Reminders first: they are the actionable items (click to edit/delete).
       A syllabus event that matches an existing reminder is dropped so it
       cannot hide the clickable chip behind a read-only span. */
    for (const r of reminders) {
      if (r.dueDate === undefined) continue;
      if (classFilter && r.classId && !classFilter.has(r.classId)) continue;
      seen.add(`${r.classId ?? ""}|${r.title}|${startOfDay(r.dueDate)}`);
      add({
        key: `rem-${r.id}`,
        date: r.dueDate,
        kind: "reminder",
        title: r.title,
        time: timeFromMs(r.dueDate),
        dateEnd: r.dateEnd,
        classId: r.classId,
        reminder: r,
      });
    }
    for (const s of syllabi) {
      if (classFilter && !classFilter.has(s.classId)) continue;
      for (const e of s.events) {
        if (e.dateStart === undefined) continue;
        const marker = `${s.classId}|${e.title}|${startOfDay(e.dateStart)}`;
        if (seen.has(marker)) continue;
        add({
          key: `evt-${s.id}-${e.id}`,
          date: e.dateStart,
          kind: e.kind,
          title: e.title,
          time: e.time,
          dateEnd: e.dateEnd,
          classId: s.classId,
        });
      }
    }
    for (const arr of out.values()) {
      arr.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    }
    return out;
  }, [syllabi, reminders, classFilter]);

  const cells = monthGrid(view.year, view.month);

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const shiftWeek = (delta: number) => {
    setWeekStart((w) => {
      const d = new Date(w);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta * 7).getTime();
    });
  };

  const shift = (delta: number) => {
    if (viewMode === "week") shiftWeek(delta);
    else shiftMonth(delta);
  };

  const goToday = () => {
    const d = new Date();
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setWeekStart(startOfWeek(d.getTime()));
    setExpandedDay(startOfDay(d.getTime()));
  };

  function applyReminder(next: Reminder) {
    setReminders((rs) => rs.map((x) => (x.id === next.id ? next : x)));
  }

  async function toggleReminder(r: Reminder) {
    if (!repo) return;
    const done = !r.completed;
    const next: Reminder = {
      ...r,
      completed: done,
      completedAt: done ? now() : undefined,
      updatedAt: now(),
    };
    applyReminder(next);
    await repo.putReminder(next);
  }

  function saveReminder(r: Reminder, patch: Partial<Reminder>) {
    if (!repo) return;
    const next = { ...r, ...patch, updatedAt: now() };
    applyReminder(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => repo.putReminder(next), 400);
  }

  async function deleteReminder(r: Reminder) {
    if (!repo) return;
    setReminders((rs) => rs.filter((x) => x.id !== r.id));
    await repo.deleteReminder(r.id);
  }

  /* Popover editing: keep both the list and the open popover in sync. */
  function updateEditingDate(value: string) {
    if (!editing) return;
    if (!value) {
      setEditing({ ...editing, dueDate: undefined, updatedAt: now() });
      saveReminder(editing, { dueDate: undefined, dateEnd: undefined });
    } else {
      const dueDate = dueFromParts(
        value,
        editing.dueDate !== undefined
          ? timeFromMs(editing.dueDate) ?? ""
          : "",
      );
      setEditing({ ...editing, dueDate, updatedAt: now() });
      /* Pinning an exact date resolves the uncertainty. */
      saveReminder(editing, { dueDate, dateEnd: undefined });
    }
  }

  function updateEditingTime(value: string) {
    if (!editing || editing.dueDate === undefined) return;
    const dueDate = dueFromParts(dateInput(editing.dueDate), value);
    setEditing({ ...editing, dueDate, updatedAt: now() });
    saveReminder(editing, { dueDate });
  }

  async function deleteEditing() {
    if (!editing) return;
    const r = editing;
    setEditing(null);
    await deleteReminder(r);
  }

  async function addReminder() {
    if (!repo) return;
    const target = expandedDay ?? startOfDay(Date.now());
    const r: Reminder = {
      id: uuid(),
      title: "New reminder",
      text: "",
      dueDate: target,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
    };
    setReminders((rs) => [...rs, r]);
    setExpandedDay(target);
    await repo.putReminder(r);
  }

  const toggleClassFilter = (id: string) => {
    setClassFilter((cur) => {
      if (cur === null) return new Set([id]);
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size === 0 ? null : next;
    });
  };

  const weekCells = weekDays(weekStart);

  /* Compact chip: color dot + title, plus a meta line. The class name only
     shows in week view where there is room; month view relies on the dot.
     Reminder chips open the edit popover. */
  const renderChip = (i: CalendarItem) => {
    const body = (
      <>
        {i.classId && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: classColorById.get(i.classId) }}
          />
        )}
        {isUncertain(i.date, i.dateEnd) && (
          <CircleHelp
            className="size-3 shrink-0 text-callout-ink"
            aria-label="Date is the start of a range"
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${i.reminder?.completed ? "line-through opacity-50" : ""}`}
        >
          {i.title}
        </span>
      </>
    );
    const chipClassStr = `flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] font-medium ${chipClass(i.kind)}`;
    return (
      <div key={i.key} className="min-w-0">
        {i.reminder ? (
          <button
            type="button"
            onClick={() => setEditing(i.reminder!)}
            title="Edit or delete"
            className={`${chipClassStr} cursor-pointer`}
          >
            {body}
          </button>
        ) : (
          <span className={chipClassStr}>{body}</span>
        )}
        {viewMode === "week" ? (
          (i.time || i.classId) && (
            <span className="flex items-center gap-1 px-1.5 text-[10px] text-ink-faint">
              {i.classId && (
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: classColorById.get(i.classId) }}
                />
              )}
              <span className="min-w-0 truncate">
                {[i.time, i.classId ? classById.get(i.classId) ?? i.classId : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          )
        ) : (
          i.time && (
            <span className="block truncate px-1.5 text-[10px] text-ink-faint">
              {i.time}
            </span>
          )
        )}
      </div>
    );
  };

  /* Editable detail row for an expanded day. Class name is inline in week
     view only; month view keeps just the color dot. */
  const renderExpandedItem = (i: CalendarItem) =>
    i.reminder ? (
      <div
        key={i.key}
        className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-2 py-1.5"
      >
        <button
          onClick={() => toggleReminder(i.reminder!)}
          className={`flex size-4 shrink-0 items-center justify-center rounded border ${
            i.reminder.completed
              ? "bg-accent border-accent text-white"
              : "border-edge bg-card text-transparent hover:text-ink-faint"
          }`}
          aria-label={i.reminder.completed ? "Mark incomplete" : "Mark complete"}
        >
          <Check className="size-3" />
        </button>
        {i.classId && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: classColorById.get(i.classId) }}
          />
        )}
        {isUncertain(i.date, i.dateEnd) && (
          <CircleHelp
            className="size-3.5 shrink-0 text-callout-ink"
            aria-label="Date is the start of a range"
          />
        )}
        <input
          value={i.reminder.title}
          onChange={(e) => saveReminder(i.reminder!, { title: e.target.value })}
          className={`min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-xs font-semibold outline-none ${
            i.reminder.completed ? "text-ink-faint line-through" : "text-ink"
          }`}
        />
        <input
          type="date"
          value={dateInput(i.reminder.dueDate as number)}
          onChange={(e) => {
            if (!e.target.value) {
              saveReminder(i.reminder!, { dueDate: undefined });
            } else {
              saveReminder(i.reminder!, {
                dueDate: dueFromParts(
                  e.target.value,
                  timeFromMs(i.reminder!.dueDate as number) ?? "",
                ),
                /* Pinning an exact date resolves the uncertainty. */
                dateEnd: undefined,
              });
            }
          }}
          className="w-28 rounded border border-edge bg-panel px-1 py-0.5 text-[11px] outline-none text-ink-dim"
        />
        <input
          type="time"
          value={timeFromMs(i.reminder.dueDate as number) ?? ""}
          onChange={(e) =>
            saveReminder(i.reminder!, {
              dueDate: dueFromParts(
                dateInput(i.reminder!.dueDate as number),
                e.target.value,
              ),
            })
          }
          className="w-20 rounded border border-edge bg-panel px-1 py-0.5 text-[11px] outline-none text-ink-dim"
          aria-label="Time"
        />
        <button
          onClick={() => deleteReminder(i.reminder!)}
          className="shrink-0 rounded p-1 text-ink-faint transition hover:bg-danger-soft hover:text-danger-ink"
          aria-label="Delete reminder"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    ) : (
      <div
        key={i.key}
        className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-2 py-1.5"
      >
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${chipClass(i.kind)}`}
        >
          {KIND_LABEL[i.kind] ?? i.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {i.title}
        </span>
        {i.time && (
          <span className="shrink-0 text-[11px] text-ink-faint">{i.time}</span>
        )}
        {isUncertain(i.date, i.dateEnd) && i.dateEnd !== undefined && (
          <span className="shrink-0 text-[11px] font-semibold text-callout-ink">
            {formatRange(i.date, i.dateEnd)}
          </span>
        )}
        {i.classId && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: classColorById.get(i.classId) }}
            />
            {viewMode === "week" && (classById.get(i.classId) ?? i.classId)}
          </span>
        )}
      </div>
    );

  return (
    <div className="flex h-full flex-col px-10 py-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Calendar</h1>
          <p className="mt-1 text-lg text-ink-faint">
            All reminders and syllabus dates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => shift(-1)}
            className="rounded-lg border border-edge bg-card p-2 text-ink-dim shadow-soft transition hover:bg-card-hover"
            aria-label="Previous"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={goToday}
            className="rounded-lg border border-edge bg-card px-3 py-2 text-sm font-semibold text-ink-dim shadow-soft transition hover:bg-card-hover"
          >
            Today
          </button>
          <button
            onClick={() => shift(1)}
            className="rounded-lg border border-edge bg-card p-2 text-ink-dim shadow-soft transition hover:bg-card-hover"
            aria-label="Next"
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            onClick={addReminder}
            className="ml-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-accent-hover"
          >
            <Plus className="size-4" />
            Add reminder
          </button>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between">
        <h2 className="font-display text-2xl font-semibold">
          {viewMode === "month"
            ? monthLabel(view.year, view.month)
            : weekLabel(weekStart)}
        </h2>
        <div className="flex rounded-lg border border-edge bg-card p-0.5">
          <button
            onClick={() => setViewMode("month")}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              viewMode === "month"
                ? "bg-accent text-white"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            Month
          </button>
          <button
            onClick={() => setViewMode("week")}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              viewMode === "week"
                ? "bg-accent text-white"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            Week
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setClassFilter(null)}
          className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
            classFilter === null
              ? "bg-accent text-white"
              : "bg-panel text-ink-faint hover:bg-card-hover hover:text-ink"
          }`}
        >
          All classes
        </button>
        {classes.map((c) => {
          const active = classFilter?.has(c.id) ?? false;
          return (
            <button
              key={c.id}
              onClick={() => toggleClassFilter(c.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                active
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-edge bg-panel text-ink-faint hover:bg-card-hover hover:text-ink"
              }`}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: classColorById.get(c.id) }}
              />
              {c.name}
            </button>
          );
        })}
      </div>

      {viewMode === "month" ? (
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="px-1 py-1 text-center text-xs font-semibold uppercase tracking-wide text-ink-faint"
            >
              {w}
            </div>
          ))}
          {cells.map((cell) => {
            const dayItems = byDay.get(cell.date) ?? [];
            const expanded = expandedDay !== null && isSameDay(cell.date, expandedDay);
            const visible = expanded ? dayItems : dayItems.slice(0, 3);
            const hidden = dayItems.length - visible.length;
            return (
              <div
                key={cell.date}
                className={`flex min-h-28 flex-col rounded-lg border p-1.5 ${
                  cell.inMonth ? "border-edge bg-panel" : "border-edge/50 bg-panel/50"
                } ${expanded ? "ring-2 ring-accent/40" : ""}`}
              >
                <button
                  onClick={() =>
                    setExpandedDay(expanded ? null : startOfDay(cell.date))
                  }
                  className={`self-start rounded px-1.5 py-0.5 text-xs font-semibold ${
                    cell.isToday
                      ? "bg-accent text-white"
                      : cell.inMonth
                        ? "text-ink-dim hover:bg-card-hover"
                        : "text-ink-faint hover:bg-card-hover"
                  }`}
                >
                  {new Date(cell.date).getDate()}
                </button>
                <div className="mt-1 flex min-h-0 flex-col gap-1 overflow-hidden">
                  {visible.map(renderChip)}
                  {hidden > 0 && (
                    <button
                      onClick={() => setExpandedDay(startOfDay(cell.date))}
                      className="self-start rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint hover:bg-card-hover"
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="mt-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto border-t border-edge pt-1.5">
                    {dayItems.map(renderExpandedItem)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 grid flex-1 min-h-0 grid-cols-7 gap-1.5">
          {weekCells.map((cell) => {
            const dayItems = byDay.get(cell.date) ?? [];
            const expanded = expandedDay !== null && isSameDay(cell.date, expandedDay);
            const d = new Date(cell.date);
            return (
              <div
                key={cell.date}
                className={`flex min-h-0 flex-col rounded-lg border p-1.5 ${
                  expanded
                    ? "border-edge bg-panel ring-2 ring-accent/40"
                    : "border-edge bg-panel"
                }`}
              >
                <button
                  onClick={() =>
                    setExpandedDay(expanded ? null : startOfDay(cell.date))
                  }
                  className="flex w-full items-center justify-between rounded px-1 py-0.5"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    {WEEKDAYS[d.getDay()]}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                      cell.isToday ? "bg-accent text-white" : "text-ink-dim"
                    }`}
                  >
                    {d.getDate()}
                  </span>
                </button>
                {expanded ? (
                  <div className="mt-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto border-t border-edge pt-1.5">
                    {dayItems.map(renderExpandedItem)}
                  </div>
                ) : (
                  <div className="mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                    {dayItems.map(renderChip)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-[380px] max-w-[92vw] rounded-modal bg-card p-5 shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-display text-lg font-bold">
                  {editing.title}
                </h3>
                <p className="truncate text-xs text-ink-faint">
                  {editing.classId
                    ? classById.get(editing.classId) ?? editing.classId
                    : "Reminder"}
                  {editing.text ? ` · ${editing.text}` : ""}
                </p>
              </div>
              <button
                onClick={() => setEditing(null)}
                className="shrink-0 rounded-lg p-1 text-ink-faint hover:bg-card-hover hover:text-ink"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <input
                type="date"
                value={editing.dueDate !== undefined ? dateInput(editing.dueDate) : ""}
                onChange={(e) => updateEditingDate(e.target.value)}
                className="w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-xs outline-none text-ink-dim"
              />
              <input
                type="time"
                value={editing.dueDate !== undefined ? timeFromMs(editing.dueDate) ?? "" : ""}
                onChange={(e) => updateEditingTime(e.target.value)}
                className="w-28 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-xs outline-none text-ink-dim"
                aria-label="Time"
              />
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <button
                onClick={deleteEditing}
                className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-danger-ink transition hover:bg-danger-soft"
              >
                <Trash2 className="size-4" />
                Delete
              </button>
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
