import { useState } from "react";
import {
  AlertCircle,
  Calendar,
  Check,
  CircleHelp,
  FileText,
  Loader2,
  ScrollText,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../lib/app";
import type { SourceKind } from "../lib/types";
import type { SyllabusApplySummary } from "../lib/generation/syllabus";
import {
  epochToDateInput,
  isoToEpoch,
  parseSyllabus,
  applySyllabus,
  type ParsedSyllabus,
} from "../lib/generation/syllabus";
import { formatRange } from "../lib/calendar";
import { ingest } from "../lib/ingest";

function kindForFile(name: string): SourceKind {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  return "text";
}

interface EditRow {
  id: string;
  kind: string;
  title: string;
  date: string;
  /* Original range end ("YYYY-MM-DD") when the syllabus gave a week range. */
  dateEnd: string;
  /* Original range start, kept so "start of week" can be restored. */
  rangeStart: string;
  /* True when the reminder date is just the start of a range (uncertain). */
  uncertain: boolean;
  time: string;
  location: string;
  remind: boolean;
}

type Stage = "upload" | "parsing" | "review" | "applying" | "done" | "error";

const KIND_LABEL: Record<string, string> = {
  exam: "Exam",
  quiz: "Quiz",
  final: "Final",
  homework: "Homework",
  break: "Break",
  other: "Other",
};

export default function SyllabusModal({
  classId,
  className,
  onClose,
  onApplied,
}: {
  classId: string;
  className?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { repo, engine } = useApp();
  const [stage, setStage] = useState<Stage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedSyllabus | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyllabusApplySummary | null>(null);

  async function handleParse() {
    if (!file || !engine) return;
    setError(null);
    setStage("parsing");
    try {
      const res = await ingest({
        kind: kindForFile(file.name),
        file,
        filename: file.name,
      });
      const text = res.text.trim();
      if (!text) throw new Error("No readable content found in that file.");
      const result = await parseSyllabus(engine, text, {
        className,
        termHint: undefined,
      });
      setParsed(result);
      setRows(
        result.assessments.map((a) => {
          const isRange = !!a.dateStart && !!a.dateEnd && a.dateStart !== a.dateEnd;
          return {
            id: a.title,
            kind: a.kind,
            title: a.title,
            date: a.dateStart ?? "",
            dateEnd: isRange ? a.dateEnd : "",
            rangeStart: isRange ? a.dateStart : "",
            uncertain: isRange,
            time: a.time ?? "",
            location: a.location ?? "",
            remind:
              a.kind === "exam" ||
              a.kind === "quiz" ||
              a.kind === "final" ||
              a.kind === "homework",
          };
        }),
      );
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse the syllabus.");
      setStage("error");
    }
  }

  function updateRow(id: string, patch: Partial<EditRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /* Range rows default to the start of the week; this bulk action puts them
     back to that state after the user edited some dates. */
  function placeAllAtWeekStart() {
    setRows((prev) =>
      prev.map((r) =>
        r.rangeStart ? { ...r, date: r.rangeStart, uncertain: true } : r,
      ),
    );
  }

  /* Clicking the "?" on a range row pins the current date; clicking again
     goes back to the start of the week (uncertain). */
  function toggleUncertain(r: EditRow) {
    if (r.uncertain) {
      updateRow(r.id, { uncertain: false });
    } else if (r.rangeStart) {
      updateRow(r.id, { date: r.rangeStart, uncertain: true });
    }
  }

  async function handleApply() {
    if (!repo || !engine || !parsed) return;
    setError(null);
    setStage("applying");
    try {
      const finalParsed: ParsedSyllabus = {
        ...parsed,
        assessments: rows.map((r) => ({
          kind: r.kind as ParsedSyllabus["assessments"][number]["kind"],
          title: r.title,
          dateStart: r.date,
          dateEnd: r.uncertain ? r.dateEnd : "",
          time: r.time,
          location: r.location,
        })),
      };
      const reminders = rows
        .filter((r) => r.remind && r.date)
        .map((r) => ({
          id: r.id,
          kind: r.kind as ParsedSyllabus["assessments"][number]["kind"],
          title: r.title,
          dateStart: isoToEpoch(r.date, r.time),
          dateEnd: r.uncertain && r.dateEnd ? isoToEpoch(r.dateEnd) : undefined,
          time: r.time || undefined,
          location: r.location || undefined,
        }));
      const res = await applySyllabus(repo, finalParsed, classId, "", {
        reminders,
      });
      setSummary(res);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply the syllabus.");
      setStage("error");
    }
  }

  const datedRows = rows.filter((r) => r.date);
  const remindedCount = rows.filter((r) => r.remind && r.date).length;
  const rangeRows = rows.filter((r) => r.rangeStart);
  const uncertainCount = rows.filter((r) => r.uncertain).length;

  const groupOn = (kinds: string[]) => {
    const group = rows.filter((r) => kinds.includes(r.kind));
    return group.length > 0 && group.every((r) => r.remind);
  };
  const toggleGroup = (kinds: string[]) => {
    const group = rows.filter((r) => kinds.includes(r.kind));
    const turnOn = !groupOn(kinds);
    group.forEach((r) => updateRow(r.id, { remind: turnOn }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 transition-opacity"
      onClick={stage === "parsing" || stage === "applying" ? undefined : onClose}
    >
      <div
        className="flex max-h-[90vh] w-[640px] max-w-[92vw] flex-col rounded-modal bg-card p-6 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-accent-softer">
              <ScrollText className="size-5 text-accent" />
            </span>
            <div>
              <h2 className="font-display text-xl font-bold">Syllabus</h2>
              <p className="text-sm text-ink-faint">
                {className ?? "Class"} — extract dates, grading, and topics
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={stage === "parsing" || stage === "applying"}
            className="rounded-lg p-1.5 text-ink-faint hover:bg-card-hover hover:text-ink"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          {stage === "upload" && (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-edge bg-panel px-4 py-8 text-sm text-ink-faint transition hover:border-accent hover:bg-accent-softer"
            >
              <input
                type="file"
                accept=".docx,.doc,.pdf,.txt,.md"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <Upload className="size-5" />
              <span className="font-semibold text-ink-dim">
                {file ? file.name : "Drop the syllabus here, or click to upload"}
              </span>
              <span className="text-xs">DOCX, PDF, or text — like your course syllabus</span>
            </label>
          )}

          {(stage === "parsing" || stage === "applying") && (
            <div className="flex flex-col items-center gap-4 py-16">
              <Loader2 className="size-8 animate-spin text-accent" />
              <p className="text-sm font-semibold text-ink-dim">
                {stage === "parsing"
                  ? "Reading the syllabus…"
                  : "Applying to your class…"}
              </p>
            </div>
          )}

          {stage === "review" && parsed && (
            <div className="space-y-5">
              <div className="rounded-xl border border-edge bg-panel p-4">
                <p className="font-display text-lg font-bold">{parsed.courseTitle || "Course"}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink-dim">
                  {parsed.courseCode && (
                    <span className="rounded bg-accent-softer px-1.5 py-0.5 font-semibold text-accent">
                      {parsed.courseCode}
                    </span>
                  )}
                  {parsed.term && (
                    <span className="rounded bg-panel px-1.5 py-0.5 font-semibold text-ink-faint">
                      {parsed.term}
                    </span>
                  )}
                  {parsed.institution && (
                    <span className="rounded bg-panel px-1.5 py-0.5 font-semibold text-ink-faint">
                      {parsed.institution}
                    </span>
                  )}
                </div>
              </div>

              {rangeRows.length > 0 && (
                <div className="rounded-xl border border-edge bg-callout-bg p-3">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-callout-ink">
                    <CircleHelp className="size-4 shrink-0" />
                    {rangeRows.length} item{rangeRows.length !== 1 ? "s" : ""}{" "}
                    only list a week range, not an exact due date
                  </p>
                  <p className="mt-1 text-xs text-callout-ink/80">
                    {uncertainCount > 0
                      ? "These will be dated at the start of their week and marked with a yellow “?”. "
                      : ""}
                    Edit a date to set an exact day, or place them at the start
                    of the week.
                  </p>
                  <button
                    type="button"
                    onClick={placeAllAtWeekStart}
                    className="mt-2 rounded-lg bg-callout-ink px-2.5 py-1 text-xs font-bold text-callout-bg transition hover:opacity-90"
                  >
                    Use start of week for all
                  </button>
                </div>
              )}

              <div>
                <p className="mb-2 text-sm font-semibold text-ink-faint">
                  Assessments — check the ones to turn into reminders
                </p>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-ink-faint">
                    Enable:
                  </span>
                  {[
                    { label: "Homework", kinds: ["homework"] },
                    { label: "Quizzes", kinds: ["quiz"] },
                    { label: "Tests", kinds: ["exam", "final"] },
                  ].map((g) => (
                    <button
                      key={g.label}
                      type="button"
                      onClick={() => toggleGroup(g.kinds)}
                      className={`rounded-lg px-2 py-0.5 text-xs font-semibold transition ${
                        groupOn(g.kinds)
                          ? "bg-accent-softer text-accent"
                          : "bg-panel text-ink-faint hover:bg-card-hover"
                      }`}
                    >
                      {g.label}
                    </button>
                  ))}
                  <span className="mx-0.5 h-3 w-px bg-edge" />
                  <button
                    type="button"
                    onClick={() =>
                      setRows((prev) => prev.map((r) => ({ ...r, remind: true })))
                    }
                    className="rounded-lg px-2 py-0.5 text-xs font-semibold text-ink-faint transition hover:bg-card-hover"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setRows((prev) => prev.map((r) => ({ ...r, remind: false })))
                    }
                    className="rounded-lg px-2 py-0.5 text-xs font-semibold text-ink-faint transition hover:bg-card-hover"
                  >
                    None
                  </button>
                </div>
                <div className="space-y-1.5">
                  {rows.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={r.remind}
                        onChange={(e) => updateRow(r.id, { remind: e.target.checked })}
                        className="size-4 shrink-0 rounded border-edge text-accent accent-accent"
                      />
                      {r.rangeStart && (
                        <button
                          type="button"
                          onClick={() => toggleUncertain(r)}
                          title={
                            r.uncertain
                              ? `No exact date — using ${formatRange(isoToEpoch(r.rangeStart), isoToEpoch(r.dateEnd))}; click to pin this date`
                              : "Click to place at the start of the range"
                          }
                          aria-label="Date is the start of a range"
                          className={`shrink-0 rounded-full p-0.5 transition ${
                            r.uncertain
                              ? "text-callout-ink"
                              : "text-ink-faint hover:text-callout-ink"
                          }`}
                        >
                          <CircleHelp className="size-4" />
                        </button>
                      )}
                      <span
                        className={`w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold ${
                          r.kind === "exam" ||
                          r.kind === "final" ||
                          r.kind === "homework"
                            ? "bg-accent-softer text-accent"
                            : "bg-panel text-ink-faint"
                        }`}
                      >
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {r.title}
                      </span>
                      <input
                        type="date"
                        value={r.date}
                        onChange={(e) =>
                          updateRow(r.id, { date: e.target.value, uncertain: false })
                        }
                        className="w-36 rounded-lg border border-edge bg-card px-2 py-1 text-xs outline-none text-ink-dim"
                      />
                      <input
                        type="time"
                        value={r.time}
                        onChange={(e) => updateRow(r.id, { time: e.target.value })}
                        className="w-24 rounded-lg border border-edge bg-card px-2 py-1 text-xs outline-none text-ink-dim"
                        aria-label="Time"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {parsed.grading.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-semibold text-ink-faint">Grading</p>
                  <div className="flex flex-wrap gap-1.5">
                    {parsed.grading.map((g) => (
                      <span
                        key={g.category}
                        className="rounded-lg bg-panel px-2 py-1 text-xs text-ink-dim"
                      >
                        <span className="font-semibold text-ink">{g.weightPct}%</span> {g.category}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {stage === "done" && summary && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-green-500/10">
                <Check className="size-7 text-green-600" />
              </span>
              <p className="font-display text-xl font-bold">Syllabus applied</p>
              <div className="mt-2 space-y-1 text-sm text-ink-dim">
                <p>
                  <Calendar className="mr-1 inline size-3.5" />
                  {summary.reminders} reminder{summary.reminders !== 1 ? "s" : ""} created
                  {summary.examDate ? (
                    <>
                      {" · "}exam date{" "}
                      <span className="font-semibold text-ink">
                        {epochToDateInput(summary.examDate)}
                      </span>
                    </>
                  ) : null}
                </p>
                {summary.folders > 0 && (
                  <p>
                    {summary.folders} unit folder{summary.folders !== 1 ? "s" : ""} created from
                    the course topics
                  </p>
                )}
                <p className="text-xs text-ink-faint">
                  {summary.events} events stored · reminders appear on your dashboard
                </p>
              </div>
            </div>
          )}

          {stage === "error" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-danger-soft">
                <AlertCircle className="size-7 text-danger-ink" />
              </span>
              <p className="font-display text-lg font-bold">Couldn't parse the syllabus</p>
              <p className="max-w-sm text-sm text-ink-dim">{error}</p>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          {stage === "review" && (
            <p className="text-xs text-ink-faint">
              {datedRows.length} dated · {remindedCount} will become reminders
              {uncertainCount > 0 && (
                <>
                  {" · "}
                  {uncertainCount} date{uncertainCount !== 1 ? "s" : ""} uncertain
                </>
              )}
            </p>
          )}
          {stage === "done" || stage === "error" ? (
            <button
              onClick={() => {
                onApplied();
                onClose();
              }}
              className="ml-auto rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover"
            >
              {stage === "done" ? "Done" : "Back"}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={stage === "parsing" || stage === "applying"}
                className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              {stage === "upload" && (
                <button
                  onClick={handleParse}
                  disabled={!file || !engine}
                  className="flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  <FileText className="size-4" />
                  Parse Syllabus
                </button>
              )}
              {stage === "review" && (
                <button
                  onClick={handleApply}
                  disabled={remindedCount === 0}
                  className="rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  Apply
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
