import { useState } from "react";
import { BookOpen, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

interface SourceCitationProps {
  passage: string;
  noteId: string;
  charStart?: number;
  charEnd?: number;
  onOpenSource?: (noteId: string, start: number, end: number) => void;
}

export default function SourceCitation({
  passage,
  noteId,
  charStart,
  charEnd,
  onOpenSource,
}: SourceCitationProps) {
  if (!passage.trim()) return null;

  const [open, setOpen] = useState(false);
  const hasPosition = charStart !== undefined && charEnd !== undefined;
  const isParaphrased = passage.startsWith("[paraphrased]");

  const label = isParaphrased ? "Source · paraphrased" : hasPosition
    ? `Source · chars ${charStart}–${charEnd}`
    : "Source";

  return (
    <div className="mt-3 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-edge bg-card px-3 py-2 text-left hover:bg-card-hover transition-colors"
      >
        <BookOpen className="size-3.5 text-ink-faint shrink-0" />
        <span className="font-display text-xs font-bold text-ink-faint truncate">
          {label}
        </span>
        <span className="ml-auto">
          {open ? (
            <ChevronUp className="size-3.5 text-ink-faint" />
          ) : (
            <ChevronDown className="size-3.5 text-ink-faint" />
          )}
        </span>
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-edge bg-card p-3">
          <p
            className={`italic leading-relaxed text-ink-dim ${
              isParaphrased ? "text-ink-faint" : ""
            }`}
          >
            {isParaphrased
              ? passage.replace(/^\[paraphrased\]\s*/, "")
              : `"${passage}"`}
          </p>
          {hasPosition && onOpenSource && (
            <button
              onClick={() => onOpenSource(noteId, charStart!, charEnd!)}
              className="mt-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-softer"
            >
              <span>View in full source</span>
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
