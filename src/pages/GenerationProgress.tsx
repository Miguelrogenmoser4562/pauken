import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, Check, FileText, Loader2, X } from "lucide-react";
import { useApp } from "../lib/app";
import { createNoteFromSources } from "../lib/generation/pipeline";
import type { IngestInput } from "../lib/ingest";
import type { Job, JobStage } from "../lib/types";

interface LocationState {
  inputs: IngestInput[];
  language?: string;
  generateStudyTools?: boolean;
  classId?: string;
  folderId?: string;
  contentCategory?: "knowledge" | "practice";
  topic?: string;
  contentScope?: "new_topic" | "new_unit" | "additional" | "general";
}

const STAGES: { key: JobStage; label: string }[] = [
  { key: "ingest", label: "Ingest" },
  { key: "transcribe", label: "Transcribe" },
  { key: "ocr", label: "OCR" },
  { key: "notes", label: "Notes" },
  { key: "title", label: "Title" },
  { key: "flashcards", label: "Flashcards" },
  { key: "quiz", label: "Quiz" },
];

function stageOrder(s: JobStage): number {
  return STAGES.findIndex((st) => st.key === s);
}

export default function GenerationProgress() {
  const navigate = useNavigate();
  const location = useLocation();
  const { repo, engine, visionEngine, bump } = useApp();

  const [job, setJob] = useState<Job | null>(null);
  const [done, setDone] = useState(false);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sectionInfo, setSectionInfo] = useState<{ current: number; total: number } | null>(null);
  const [avgSection, setAvgSection] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const abortRef = useRef(new AbortController());
  const startedRef = useRef(false);
  const sectionTimes = useRef<number[]>([]);
  const startedAt = useRef(Date.now());

  const state = location.state as LocationState | null;
  const inputs = state?.inputs;
  const language = state?.language ?? "English";
  const generateStudyTools = state?.generateStudyTools ?? true;
  const classId = state?.classId;
  const folderId = state?.folderId;
  const contentCategory = state?.contentCategory;
  const topic = state?.topic;
  const contentScope = state?.contentScope;

  useEffect(() => {
    if (!repo || !engine) return;
    if (!inputs || inputs.length === 0) { navigate("/", { replace: true }); return; }
    if (startedRef.current) return; // already running

    startedRef.current = true;
    const signal = abortRef.current.signal;
    createNoteFromSources({ repo, engine, ocrEngine: visionEngine ?? undefined, inputs, language, generateStudyTools, classId, folderId, contentCategory, topic, contentScope, signal, onProgress: setJob })
      .then((id) => {
        setNoteId(id);
        setDone(true);
        bump();
      })
      .catch((e) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Generation failed.");
      });
    return () => { abortRef.current.abort(); };
  }, [repo, engine]);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!job || job.stage !== "notes") return;
    const match = job.message?.match(/Writing section (\d+) of (\d+)…/);
    if (!match) return;
    const current = parseInt(match[1]);
    const total = parseInt(match[2]);
    setSectionInfo({ current, total });

    const now = Date.now();
    sectionTimes.current.push(now);
    if (sectionTimes.current.length >= 2) {
      let totalTime = 0;
      for (let i = 1; i < sectionTimes.current.length; i++) {
        totalTime += sectionTimes.current[i] - sectionTimes.current[i - 1];
      }
      const avgMs = totalTime / (sectionTimes.current.length - 1);
      setAvgSection(avgMs / 1000);
      setRemaining((avgMs / 1000) * (total - current + 1));
    }
  }, [job?.message, job?.stage]);

  useEffect(() => {
    if (done && noteId) {
      const t = setTimeout(() => navigate(`/notes/${noteId}/editor`, { replace: true }), 2000);
      return () => clearTimeout(t);
    }
  }, [done, noteId, navigate]);

  const handleCancel = () => {
    abortRef.current.abort();
    navigate("/", { replace: true });
  };

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  if (!inputs || inputs.length === 0) return null;

  if (!repo || !engine) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 py-24 px-10">
        <Loader2 className="size-10 animate-spin text-accent" />
        <h1 className="text-2xl font-bold">Connecting…</h1>
        <p className="max-w-md text-center text-sm text-ink-dim">
          Waiting for repo and engine to become available.
        </p>
      </div>
    );
  }

  const currentOrder = job ? stageOrder(job.stage) : 0;
  const label = inputs[0]?.filename || inputs[0]?.url || "New note";

  if (done && noteId) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 py-24 px-10">
        <span className="flex size-16 items-center justify-center rounded-full bg-green-500/10">
          <Check className="size-8 text-green-600" />
        </span>
        <h1 className="text-2xl font-bold">Generation complete</h1>
        <p className="text-sm text-ink-faint">Redirecting to your note…</p>
        <button
          onClick={() => navigate(`/notes/${noteId}/editor`)}
          className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white shadow-soft hover:opacity-90"
        >
          View note now
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 py-24 px-10">
        <span className="flex size-16 items-center justify-center rounded-full bg-danger-soft">
          <AlertCircle className="size-8 text-danger-ink" />
        </span>
        <h1 className="text-2xl font-bold">Generation failed</h1>
        <p className="max-w-md text-center text-sm text-ink-dim">
          {error.split("\n")[0]}
        </p>
        {error.includes("\n") && (
          <div className="w-full max-w-md rounded-card border border-edge bg-panel p-3 text-left">
            <button
              onClick={() => setShowDetails((s) => !s)}
              className="mb-1 text-xs font-semibold text-accent hover:underline"
            >
              {showDetails ? "Hide" : "Show"} full error details
            </button>
            {showDetails && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/90 p-3 font-mono text-xs text-green-300">
                {error}
              </pre>
            )}
          </div>
        )}
        <button
          onClick={() => navigate("/")}
          className="rounded-xl bg-accent px-6 py-2.5 font-semibold text-white shadow-soft hover:opacity-90"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="px-10 py-8">
      <button
        onClick={() => navigate("/")}
        className="mb-6 flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        Back to Dashboard
      </button>

      <div className="mb-8 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-accent-softer">
          <FileText className="size-5 text-accent" />
        </span>
        <div>
          <h1 className="font-display text-xl font-bold">Generating notes</h1>
          <p className="text-sm text-ink-faint">{label}</p>
        </div>
      </div>

      <div className="mb-8 flex items-center gap-0 overflow-x-auto">
        {STAGES.map((stage, i) => {
          const completed = i < currentOrder;
          const current = i === currentOrder;
          return (
            <div key={stage.key} className="flex shrink-0 items-center">
              {i > 0 && (
                <div className={`mx-1 h-px w-6 ${completed ? "bg-accent" : "bg-edge"}`} />
              )}
              <span
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                  completed
                    ? "bg-accent-softer text-accent"
                    : current
                      ? "bg-accent text-white"
                      : "bg-panel text-ink-faint"
                }`}
              >
                {completed && <Check className="size-3" />}
                {current && <Loader2 className="size-3 animate-spin" />}
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mb-6">
        <div className="h-2 w-full overflow-hidden rounded-full bg-panel">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${(job?.progress ?? 0) * 100}%` }}
          />
        </div>
      </div>

      <p className="mb-6 text-lg font-semibold">{job?.message ?? "Starting…"}</p>

      <div className="space-y-3 rounded-card border border-edge bg-card p-5 shadow-soft">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-dim">Elapsed</span>
          <span className="tabular-nums font-semibold">{formatTime(elapsed)}</span>
        </div>
        {sectionInfo && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-dim">Section</span>
            <span className="tabular-nums font-semibold">
              {sectionInfo.current} of {sectionInfo.total}
            </span>
          </div>
        )}
        {avgSection !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-dim">Avg per section</span>
            <span className="tabular-nums font-semibold">~{formatTime(Math.round(avgSection))}</span>
          </div>
        )}
        {remaining !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-dim">Estimated remaining</span>
            <span className="tabular-nums font-semibold text-accent">
              ~{Math.round(remaining / 60)}min
            </span>
          </div>
        )}
      </div>

      {job?.files && job.files.length > 1 && (
        <div className="mt-6 rounded-card border border-edge bg-card p-5 shadow-soft">
          <p className="mb-2 text-sm font-semibold text-ink-dim">Files</p>
          <ul className="space-y-1.5">
            {job.files.map((f, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="truncate text-ink-dim">{f.name}</span>
                <span
                  className={
                    f.status === "done"
                      ? "text-green-600"
                      : f.status === "error"
                        ? "text-danger-ink"
                        : "text-ink-faint"
                  }
                >
                  {f.status === "done"
                    ? "✓"
                    : f.status === "error"
                      ? f.error || "failed"
                      : f.status === "running"
                        ? "…"
                        : "queued"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={handleCancel}
        className="mt-8 flex items-center gap-2 rounded-xl border border-danger-ink/30 px-4 py-2 text-sm font-semibold text-danger-ink hover:bg-danger-soft"
      >
        <X className="size-4" />
        Cancel generation
      </button>
    </div>
  );
}

