import { useState } from "react";
import { FileAudio, FileText, Link2, Upload, X } from "lucide-react";
import type { IngestInput } from "../lib/ingest";
import type { ContentScope, SourceKind } from "../lib/types";

export type NoteSource = "link" | "document" | "audio";

export interface CreateNoteResult {
  inputs: IngestInput[];
  generateStudyTools?: boolean;
  contentCategory?: "knowledge" | "practice";
  topic?: string;
  contentScope?: ContentScope;
}

const meta: Record<NoteSource, { icon: typeof Link2; iconBg: string }> = {
  link: { icon: Link2, iconBg: "bg-red-500" },
  document: { icon: FileText, iconBg: "bg-accent" },
  audio: { icon: FileAudio, iconBg: "bg-accent" },
};

function kindForFile(name: string): SourceKind {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  return "text";
}

export default function CreateNoteModal({
  source,
  onGenerate,
  onClose,
  contentCategory: initialCategory,
  classId,
  existingTopics,
  onNewUnit,
}: {
  source: NoteSource;
  onGenerate: (result: CreateNoteResult) => void;
  onClose: () => void;
  contentCategory?: "knowledge" | "practice";
  classId?: string;
  existingTopics?: string[];
  onNewUnit?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [genTools, setGenTools] = useState(true);
  const [category, setCategory] = useState<"knowledge" | "practice">(initialCategory ?? "knowledge");
  const [topicInput, setTopicInput] = useState("");

  const { icon: Icon, iconBg } = meta[source];
  const ready = source === "link" ? url.trim().length > 0 : files.length > 0;

  function submit() {
    if (!ready) return;
    const tools = genTools || undefined;
    const cat = initialCategory ? undefined : category;

    let topic: string | undefined;
    let contentScope: ContentScope | undefined;

    if (classId) {
      const trimmed = topicInput.trim();
      if (trimmed) {
        topic = trimmed;
        contentScope = existingTopics?.includes(trimmed) ? "additional" : "new_topic";
      }
    }

    if (source === "link") {
      onGenerate({
        inputs: [{ kind: "url", url: url.trim() }],
        generateStudyTools: tools,
        contentCategory: cat,
        topic,
        contentScope,
      });
    } else if (source === "document") {
      onGenerate({
        inputs: files.map((f) => ({ kind: kindForFile(f.name), file: f, filename: f.name })),
        generateStudyTools: tools,
        contentCategory: cat,
        topic,
        contentScope,
      });
    } else {
      onGenerate({
        inputs: files.map((f) => ({ kind: "audio", file: f, filename: f.name })),
        generateStudyTools: tools,
        contentCategory: cat,
        topic,
        contentScope,
      });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 transition-opacity"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-modal bg-card p-8 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-ink-faint hover:bg-card-hover hover:text-ink"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 pb-6">
          <span className={`flex size-16 items-center justify-center rounded-2xl ${iconBg}`}>
            <Icon className="size-8 text-white" />
          </span>
          <h2 className="font-display text-2xl font-bold">Create note from source</h2>
        </div>

        {source === "link" && (
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Paste a website link..."
            className="w-full rounded-xl border border-edge bg-panel px-4 py-3.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
          />
        )}

        {source === "document" && (
          <Dropzone
            label="Drag documents here, or click to upload"
            accept=".pdf,.doc,.docx,.txt,.md"
            onFiles={setFiles}
            files={files}
          />
        )}

        {source === "audio" && (
          <Dropzone
            label="Drag an audio file here, or click to upload (MP3, WAV, M4A, etc.)"
            accept="audio/*,video/*"
            onFiles={setFiles}
            files={files}
          />
        )}

        {/* Topic input — shown when inside a class. Scope is auto-detected. */}
        {classId && (
          <div className="mt-4 space-y-3">
            <p className="text-xs font-semibold text-ink-faint">Topic</p>
            <input
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              placeholder="Type a new topic name or select an existing one…"
              list="existing-topics"
              className="w-full rounded-xl border border-edge bg-panel px-4 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
            />
            {existingTopics && existingTopics.length > 0 && (
              <datalist id="existing-topics">
                {existingTopics.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            )}
            {topicInput.trim() && !existingTopics?.includes(topicInput.trim()) && onNewUnit && (
              <button
                onClick={onNewUnit}
                className="text-xs font-semibold text-accent hover:underline"
              >
                + Create a new unit instead
              </button>
            )}
          </div>
        )}

        {!initialCategory && !classId && (
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setCategory("knowledge")}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                category === "knowledge"
                  ? "bg-accent text-white"
                  : "border border-edge bg-panel text-ink-dim hover:bg-card-hover"
              }`}
            >
              Knowledge Base
            </button>
            <button
              onClick={() => setCategory("practice")}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                category === "practice"
                  ? "bg-accent text-white"
                  : "border border-edge bg-panel text-ink-dim hover:bg-card-hover"
              }`}
            >
              Practice Problems
            </button>
          </div>
        )}

        <label className="mt-4 flex items-center gap-2">
          <input
            type="checkbox"
            checked={genTools}
            onChange={(e) => setGenTools(e.target.checked)}
            className="size-4 rounded border-edge text-accent accent-accent"
          />
          <span className="text-sm text-ink-dim">Generate flashcards and quiz</span>
        </label>

        <button
          onClick={submit}
          disabled={!ready}
          className={`mt-4 w-full rounded-xl py-3.5 font-display font-bold transition active:scale-[0.98] ${
            ready
              ? "bg-accent text-white hover:bg-accent-hover"
              : "cursor-not-allowed bg-accent-softer text-ink-faint"
          }`}
        >
          Generate Notes
        </button>
      </div>
    </div>
  );
}

function Dropzone({
  label,
  accept,
  files,
  onFiles,
}: {
  label: string;
  accept: string;
  files: File[];
  onFiles: (f: File[]) => void;
}) {
  const [drag, setDrag] = useState(false);

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles([...files, ...Array.from(e.dataTransfer.files)]);
      }}
      className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-sm ${
        drag ? "border-accent bg-accent-softer" : "border-edge bg-panel text-ink-faint"
      }`}
    >
      <input
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => onFiles([...files, ...Array.from(e.target.files ?? [])])}
      />
      <span className="flex items-center gap-2">
        <Upload className="size-4" />
        {label}
      </span>
      {files.length > 0 && (
        <span className="font-semibold text-ink">
          {files.length} file{files.length > 1 ? "s" : ""} selected
        </span>
      )}
    </label>
  );
}
