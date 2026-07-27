import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, Search, X } from "lucide-react";

interface SourceModalProps {
  sourceText: string;
  highlightRange?: { start: number; end: number } | null;
  onClose: () => void;
}

const CHUNK = 80;
const TOP_BUFFER = 40;
const BOTTOM_BUFFER = 40;

export default function SourceModal({
  sourceText,
  highlightRange,
  onClose,
}: SourceModalProps) {
  const allLines = useMemo(() => sourceText.split("\n"), [sourceText]);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState("");
  const [currentSection, setCurrentSection] = useState<{ start: number; end: number } | null>(
    highlightRange ?? null,
  );

  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(() => Math.min(CHUNK, allLines.length));
  const [searchTerm, setSearchTerm] = useState(""); // term to highlight in text view

  /* reset view window when section changes externally */
  useEffect(() => {
    if (highlightRange) {
      setCurrentSection(highlightRange);
    }
  }, [highlightRange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  /* scroll to current section highlight */
  useEffect(() => {
    if (currentSection && highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [currentSection]);

  /* build char-offset -> line-index map (memoized) */
  const charToLine = useMemo(() => {
    const offsets: number[] = [];
    let pos = 0;
    for (const line of allLines) {
      offsets.push(pos);
      pos += line.length + 1;
    }
    return offsets;
  }, [allLines]);

  /* when a citation section is clicked, jump to the matching line range */
  const handleSectionClick = (ref: string) => {
    const regex = new RegExp(
      `\\[§${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
    );
    const match = regex.exec(sourceText);
    if (!match) return;
    const startChar = match.index;
    const endChar = match.index + match[0].length;

    /* find which line contains this range */
    let lineIdx = 0;
    for (let i = 0; i < charToLine.length; i++) {
      if (charToLine[i] > startChar) break;
      lineIdx = i;
    }
    const contextStart = Math.max(0, lineIdx - 10);
    const contextEnd = Math.min(allLines.length, lineIdx + 20);
    setViewStart(contextStart);
    setViewEnd(contextEnd);
    setCurrentSection({ start: startChar, end: endChar });
    setSearch("");
    setSearchTerm("");
  };

  /* scroll handler for lazy loading */
  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 200;
    const nearTop = scrollTop < 200;

    if (nearBottom && viewEnd < allLines.length) {
      setViewEnd((prev) => Math.min(allLines.length, prev + CHUNK));
      setViewStart((prev) => Math.max(0, prev - TOP_BUFFER));
    }
    if (nearTop && viewStart > 0) {
      setViewStart((prev) => Math.max(0, prev - CHUNK));
      setViewEnd((prev) => Math.min(allLines.length, prev + BOTTOM_BUFFER));
    }
  }, [viewEnd, viewStart, allLines.length]);

  /* search results */
  const searchResults = useMemo(() => {
    if (!search.trim()) return null;
    const term = search.toLowerCase();
    return allLines
      .map((line, i) => ({ line, index: i }))
      .filter(({ line }) => line.toLowerCase().includes(term));
  }, [search, allLines]);

  const handleResultClick = (lineIdx: number) => {
    const contextStart = Math.max(0, lineIdx - 10);
    const contextEnd = Math.min(allLines.length, lineIdx + 21);
    setViewStart(contextStart);
    setViewEnd(contextEnd);
    setSearch("");
    setSearchTerm(search.trim());
    /* scroll to the target line after render */
    requestAnimationFrame(() => {
      const el = document.getElementById(`src-line-${lineIdx}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  };

  /* highlight search term in a line */
  const highlightLine = (text: string, term: string) => {
    if (!term) return text;
    const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return parts.map((p, i) =>
      p.toLowerCase() === term.toLowerCase() ? (
        <mark key={i} className="rounded-sm bg-yellow-300/30 text-yellow-200">
          {p}
        </mark>
      ) : (
        p
      ),
    );
  };

  /* build search result snippet centered on the match */
  const snippet = (line: string, maxLen = 120) => {
    if (line.length <= maxLen) return line;
    const idx = line.toLowerCase().indexOf(search.trim().toLowerCase());
    if (idx < 0) return line.slice(0, maxLen) + "...";
    const half = Math.floor((maxLen - 3) / 2);
    const s = Math.max(0, idx - half);
    const e = Math.min(line.length, idx + half);
    return (s > 0 ? "..." : "") + line.slice(s, e) + (e < line.length ? "..." : "");
  };

  /* visible lines slice */
  const visibleLines = allLines.slice(viewStart, viewEnd);

  /* check if a char range falls within this line's slice of the source text */
  const inSection = (lineIdx: number): boolean => {
    if (!currentSection) return false;
    const lineStart = charToLine[lineIdx] ?? 0;
    const lineEnd = lineIdx < allLines.length - 1 ? charToLine[lineIdx + 1] - 1 : sourceText.length;
    return currentSection.start < lineEnd && currentSection.end > lineStart;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[10vh]">
      <div className="flex max-h-[80vh] w-full max-w-[900px] flex-col rounded-2xl border border-edge bg-card shadow-modal">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <span className="font-display text-sm font-bold text-ink">
            Original Source
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-1.5">
              <Search className="size-3.5 text-ink-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search source text..."
                className="w-48 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
              />
            </div>
            <button
              onClick={onClose}
              className="rounded-xl bg-accent-soft p-2 text-ink hover:opacity-90"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Section quick-nav */}
        {!search.trim() && (
          <div className="flex flex-wrap gap-1.5 border-b border-edge px-5 py-2.5">
            {Array.from(sourceText.matchAll(/\[§(\d+)\]/g)).map(([full, ref]) => (
              <button
                key={ref}
                onClick={() => handleSectionClick(ref)}
                className={`rounded-md px-2 py-0.5 text-xs font-semibold transition-colors ${
                  currentSection &&
                  sourceText.slice(currentSection.start, currentSection.end).includes(full)
                    ? "bg-accent-soft text-ink"
                    : "bg-panel text-ink-faint hover:bg-card-hover hover:text-ink"
                }`}
              >
                §{ref}
              </button>
            ))}
            {allLines.length > 0 && (
              <button
                onClick={() => {
                  setViewStart(0);
                  setViewEnd(Math.min(CHUNK, allLines.length));
                  setCurrentSection(null);
                  setSearch("");
                  setSearchTerm("");
                }}
                className="ml-auto rounded-md px-2 py-0.5 text-xs font-semibold bg-panel text-ink-faint hover:bg-card-hover hover:text-ink transition-colors"
              >
                <ArrowUpDown className="inline size-3 mr-0.5" />
                Top
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-3 font-mono text-xs leading-6"
        >
          {search.trim() ? (
            <div className="space-y-1 px-3">
              {searchResults && searchResults.length === 0 ? (
                <p className="text-ink-faint italic">No matches.</p>
              ) : (
                searchResults?.map(({ line, index }) => (
                  <button
                    key={index}
                    onClick={() => handleResultClick(index)}
                    className="flex w-full gap-3 rounded px-2 py-1 text-left hover:bg-card-hover transition-colors"
                  >
                    <span className="w-10 shrink-0 text-right tabular-nums text-ink-faint">
                      {index + 1}
                    </span>
                    <span className="min-w-0 truncate text-ink-dim">
                      {highlightLine(snippet(line), search.trim())}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div>
              {viewStart > 0 && (
                <div className="px-3 py-1 text-center text-ink-faint text-xs">
                  ↑ {viewStart} lines above · scroll up to load more
                </div>
              )}
              {visibleLines.map((line, i) => {
                const lineIdx = viewStart + i;
                const highlighted = inSection(lineIdx);
                return (
                  <div
                    key={lineIdx}
                    id={`src-line-${lineIdx}`}
                    className={`flex gap-3 rounded-sm px-3 ${
                      highlighted ? "bg-accent-softer/30" : ""
                    }`}
                  >
                    <span className="w-10 shrink-0 select-none text-right tabular-nums text-ink-faint">
                      {lineIdx + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-all text-ink-dim">
                      {highlighted ? (
                        <span ref={highlightRef}>{line || "\u00A0"}</span>
                      ) : searchTerm ? (
                        <span>{highlightLine(line || "\u00A0", searchTerm)}</span>
                      ) : (
                        line || "\u00A0"
                      )}
                    </span>
                  </div>
                );
              })}
              {viewEnd < allLines.length && (
                <div className="px-3 py-1 text-center text-ink-faint text-xs">
                  ↓ {allLines.length - viewEnd} lines below · scroll down to load more
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
