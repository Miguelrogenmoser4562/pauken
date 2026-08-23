/* Shared answer-choice list: vertical 4x1 rows with a letter circle on the
   left (replaced by avatars once someone locks in a pick during synced
   sessions) and a strikethrough/eliminate control on the right. */

import { Strikethrough } from "lucide-react";

export interface OptionPick {
  userId: string;
  answer: number;
}

interface OptionListProps {
  options: string[];
  /* Correct index; correctness colors only render when `reveal` is true. */
  correctIndex: number | null;
  /* This user's locked-in pick (letter circle becomes their avatar). */
  selected: number | null;
  /* Live picks from all participants. */
  picks?: OptionPick[];
  myUserId?: string;
  /* userId -> avatar data-URL; undefined falls back to an initials circle. */
  avatarFor?: (userId: string) => string | undefined;
  /* userId -> display name used for the initials fallback (defaults to
     "You"/"Partner", which renders a P/Y circle when no avatar exists). */
  nameFor?: (userId: string) => string;
  /* Hide other users' picks (mine always shows). */
  showPicks?: boolean;
  /* Eliminated (struck-through) options, reset per question. */
  eliminated?: ReadonlySet<number>;
  onToggleEliminate?: (index: number) => void;
  onSelect: (index: number) => void;
  /* Render correctness coloring. */
  reveal: boolean;
  /* Lock the whole list (revealed, or answer already locked in). */
  disabled?: boolean;
}

function CircleAvatar({
  src,
  name,
  ring,
  mini,
}: {
  src?: string;
  name: string;
  ring?: boolean;
  mini?: boolean;
}) {
  const cls = mini
    ? "size-5 text-[9px]"
    : "size-8 text-xs";
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${cls} shrink-0 rounded-full object-cover ${ring ? "ring-2 ring-accent" : ""}`}
      />
    );
  }
  return (
    <span
      className={`${cls} shrink-0 rounded-full bg-accent-softer font-bold text-accent ${ring ? "ring-2 ring-accent" : ""} flex items-center justify-center`}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

export default function OptionList({
  options,
  correctIndex,
  selected,
  picks = [],
  myUserId,
  avatarFor,
  nameFor = (userId: string) => (userId === myUserId ? "You" : "Partner"),
  showPicks = true,
  eliminated,
  onToggleEliminate,
  onSelect,
  reveal,
  disabled = false,
}: OptionListProps) {
  const myPicks = picks.filter((p) => p.userId === myUserId);
  const partnerPicks = showPicks
    ? picks.filter((p) => p.userId !== myUserId)
    : [];

  return (
    <div className="mt-4 flex flex-col gap-2">
      {options.map((opt, i) => {
        const isMine = selected === i || myPicks.some((p) => p.answer === i);
        const partnerPick = partnerPicks.find((p) => p.answer === i);
        const isEliminated = eliminated?.has(i) ?? false;
        const locked = disabled || isEliminated;

        let rowCls = "border-edge bg-panel";
        if (reveal) {
          if (i === correctIndex) {
            rowCls = "border-transparent bg-success-soft";
          } else if (isMine) {
            rowCls = "border-transparent bg-danger-soft";
          } else {
            rowCls = "border-edge bg-panel opacity-60";
          }
        } else if (isMine) {
          rowCls = "border-accent bg-accent-softer ring-1 ring-accent";
        }
        if (isEliminated && !reveal) {
          rowCls = "border-edge bg-panel opacity-50";
        }

        const textCls = reveal
          ? i === correctIndex
            ? "text-ink"
            : isMine
              ? "text-danger-ink"
              : "text-ink-faint"
          : isMine
            ? "text-ink"
            : isEliminated
              ? "text-ink-faint line-through"
              : "text-ink";

        return (
          <div key={i} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${rowCls}`}>
            {isMine && partnerPick ? (
              /* Both picked the same option: partner's avatar first, mine
                 overlapping slightly on top with a ring. */
              <div className="flex shrink-0 items-center">
                <CircleAvatar src={avatarFor?.(partnerPick.userId)} name={nameFor(partnerPick.userId)} mini />
                <span className="-ml-2">
                  <CircleAvatar src={avatarFor?.(myUserId ?? "")} name={nameFor(myUserId ?? "")} mini ring />
                </span>
              </div>
            ) : isMine ? (
              <CircleAvatar src={avatarFor?.(myUserId ?? "")} name={nameFor(myUserId ?? "")} />
            ) : partnerPick ? (
              <CircleAvatar src={avatarFor?.(partnerPick.userId)} name={nameFor(partnerPick.userId)} />
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-edge bg-panel text-xs font-bold text-ink-dim">
                {String.fromCharCode(65 + i)}
              </span>
            )}

            <button
              type="button"
              disabled={locked}
              onClick={() => onSelect(i)}
              className={`flex-1 rounded-lg px-1 py-1 text-left text-sm font-semibold transition disabled:cursor-not-allowed ${textCls}`}
            >
              {opt}
            </button>

            {!reveal && onToggleEliminate && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onToggleEliminate(i)}
                title={isEliminated ? "Restore answer" : "Eliminate this answer"}
                className={`rounded-lg p-1.5 transition disabled:opacity-40 ${
                  isEliminated
                    ? "bg-danger-soft text-danger-ink"
                    : "text-ink-faint hover:bg-card-hover hover:text-ink"
                }`}
              >
                <Strikethrough className="size-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
