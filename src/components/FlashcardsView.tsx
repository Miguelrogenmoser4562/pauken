/* Learning tab — displays learning-phase flashcards (front/back/context).
   Unlike the old FSRS-driven flashcard view, these are just study aids shown
   alongside a concept's first exposure. No scheduling state. */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useApp } from "../lib/app";
import { contentFor, generatePracticeItems } from "../lib/generation";
import { EngineError } from "../lib/engine/types";
import type { Flashcard, Note } from "../lib/types";
import SourceCitation from "./SourceCitation";

export default function FlashcardsView({
  note,
  onOpenSource,
}: {
  note: Note;
  onOpenSource?: (noteId: string, start: number, end: number) => void;
}) {
  const { repo, engine } = useApp();

  const [loaded, setLoaded] = useState(false);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    setCurrentIndex(0);
    setFlipped(false);
    if (!repo) return;
    (async () => {
      const cs = await repo.cardsForNote(note.id);
      if (!alive) return;
      setCards(cs);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [repo, note.id]);

  const content = contentFor(note);
  const isEmpty = !content.trim();

  const current: Flashcard | undefined = cards[currentIndex];

  async function handleGenerate() {
    if (!engine) {
      setError("Set up your engine in Settings first.");
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const result = await generatePracticeItems(engine, note);
      if (repo) {
        await repo.putFlashcards(result.flashcards);
        await repo.putQuestions(result.questions);
      }
      setCards(result.flashcards);
      setCurrentIndex(0);
      setFlipped(false);
    } catch (e) {
      setError(
        e instanceof EngineError
          ? e.message
          : "Could not generate flashcards. Please try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="px-16 py-12">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold">Learning Materials</h1>
        <p className="mt-2 text-ink-faint">Review flashcards tied to each concept.</p>
      </div>

      {isEmpty ? (
        <div className="mx-auto mt-10 max-w-4xl rounded-card bg-callout-bg p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 text-callout-ink" />
            <span className="font-display font-bold">Document is empty!</span>
          </div>
          <p className="mt-3 pl-8 text-ink-dim">
            Add some notes to your document to generate learning materials.
          </p>
        </div>
      ) : !loaded ? (
        <div className="mt-16 flex justify-center text-ink-faint">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={`flex items-center gap-2 rounded-xl px-6 py-3 font-display font-bold transition ${
              !generating
                ? "bg-accent text-white hover:bg-accent-hover"
                : "cursor-not-allowed bg-accent-softer text-ink-faint"
            }`}
          >
            {generating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {generating ? "Building learning materials…" : "Generate learning materials"}
          </button>
          {error && (
            <div className="flex w-full items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto mt-8 max-w-2xl">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-faint">
              {cards.length} card{cards.length !== 1 ? "s" : ""}
            </p>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-ink-dim shadow-soft hover:bg-card-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {generating ? "Regenerating…" : "Regenerate"}
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {current && (
            <div className="mt-6">
              <p className="mb-3 text-center text-sm font-semibold text-ink-faint">
                Card {currentIndex + 1} of {cards.length}
                <span className="ml-2 text-xs text-ink-faint/60">— {current.topic}</span>
              </p>

              <button
                onClick={() => setFlipped((f) => !f)}
                className="flex min-h-64 w-full flex-col items-center justify-center gap-4 rounded-card border border-edge bg-card p-10 text-center shadow-soft transition hover:shadow-md"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  {flipped ? "Answer" : "Question"}
                </span>
                <p className="font-display text-xl font-semibold text-ink">
                  {flipped ? current.back : current.front}
                </p>
                {!flipped && (
                  <p className="text-xs text-ink-faint">Click to reveal answer</p>
                )}
              </button>

              <div className="mt-6 flex items-center justify-between">
                <button
                  onClick={() => { setCurrentIndex((i) => Math.max(0, i - 1)); setFlipped(false); }}
                  disabled={currentIndex === 0}
                  className="flex items-center gap-1 rounded-lg border border-edge px-3 py-1.5 text-sm font-semibold text-ink-dim hover:bg-card-hover disabled:opacity-40"
                >
                  <ChevronLeft className="size-4" />
                  Previous
                </button>

                {flipped && current.context && (
                  <div className="flex-1 mx-4 rounded-card bg-accent-softer p-4 text-sm text-ink-dim">
                    <div className="flex items-center gap-2 mb-1.5">
                      <BookOpen className="size-4 text-accent" />
                      <span className="font-display font-bold text-ink">Context</span>
                    </div>
                    {current.context}
                    {current.sourcePassage && (
                      <div className="mt-3">
                        <SourceCitation
                          passage={current.sourcePassage}
                          noteId={current.noteId}
                          onOpenSource={onOpenSource}
                        />
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={() => { setCurrentIndex((i) => Math.min(cards.length - 1, i + 1)); setFlipped(false); }}
                  disabled={currentIndex >= cards.length - 1}
                  className="flex items-center gap-1 rounded-lg border border-edge px-3 py-1.5 text-sm font-semibold text-ink-dim hover:bg-card-hover disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
