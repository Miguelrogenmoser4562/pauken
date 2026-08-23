/* Small sliding-pill toggle ("tube"): the knob slides between on/off.
   Optionally renders a visible text label next to the switch so the control
   reads as a labeled option when embedded in a toolbar. */

interface SlidingToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /* Accessible name for the switch. */
  label: string;
  /* Show the label as visible text next to the switch. */
  labelVisible?: boolean;
}

export default function SlidingToggle({ checked, onChange, disabled, label, labelVisible }: SlidingToggleProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ${
          checked ? "bg-accent" : "border border-edge bg-panel"
        } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        <span
          className={`inline-block size-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
      {labelVisible && (
        <span className="text-xs font-semibold text-ink-dim">{label}</span>
      )}
    </span>
  );
}
