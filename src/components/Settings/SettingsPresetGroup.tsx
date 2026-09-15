import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SettingsPresetOption<T extends string | number> {
  value: T;
  label: string;
  /** Rendered as the option's accessible name when the visible label is an abbreviation. */
  ariaLabel?: string;
  disabled?: boolean;
}

interface SettingsPresetGroupProps<T extends string | number> {
  /** Visible group label. Associated with the radiogroup, not left floating beside it. */
  label: string;
  options: readonly SettingsPresetOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Applied to the labelled wrapper so deep links can still scroll to the group. */
  id?: string;
  disabled?: boolean;
  /** Help text under the row, associated with the group for assistive tech. */
  description?: string;
}

/**
 * A horizontal row of mutually-exclusive preset chips — update channel, idle thresholds.
 *
 * These were four separate hand-rolled runs of plain `<button>`s whose only expression of
 * "this one is selected" was a background colour: nothing in the accessibility tree said
 * which was current, the group had no name, and Tab walked through every option instead of
 * entering the group once. This is the same set of chips with the radiogroup contract the
 * WAI-ARIA Radio Group pattern asks for — one tab stop, arrows to move and select, and the
 * selection exposed as `aria-checked`.
 */
export function SettingsPresetGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
  id,
  disabled,
  description,
}: SettingsPresetGroupProps<T>) {
  const labelId = useId();
  const descriptionId = useId();
  // One element per option, keyed by value, so keyboard movement focuses the button
  // directly instead of rebuilding an attribute selector from the value. That is what
  // makes a quote or a backslash in a value a non-event, and it keeps the component off
  // `CSS.escape`, which not every test DOM provides.
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());
  /**
   * Where the keyboard actually is, which is not always where `value` is. A save can be
   * rejected and rolled back — `PrivacyDataTab` does exactly this — leaving the selection
   * back at its old option while focus stays on the one the user tried. Deriving movement
   * from `value` then walks from the wrong place, and the next arrow re-attempts the
   * option that just failed instead of moving past it.
   */
  const [focusedValue, setFocusedValue] = useState<T | null>(null);

  const enabled = options.filter((o) => !o.disabled);

  const focusOption = (v: T) => {
    optionRefs.current.get(v)?.focus();
  };

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    const from = focusedValue ?? value;
    const current = enabled.findIndex((o) => o.value === from);
    // With nothing selected yet, an arrow enters the group at the first option rather
    // than jumping to whatever index -1 + delta happens to land on.
    const next =
      current === -1
        ? delta > 0
          ? 0
          : enabled.length - 1
        : (current + delta + enabled.length) % enabled.length;
    const option = enabled[next]!;
    setFocusedValue(option.value);
    onChange(option.value);
    focusOption(option.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        if (enabled[0]) {
          setFocusedValue(enabled[0].value);
          onChange(enabled[0].value);
          focusOption(enabled[0].value);
        }
        break;
      case "End":
        e.preventDefault();
        if (enabled.at(-1)) {
          const last = enabled.at(-1)!;
          setFocusedValue(last.value);
          onChange(last.value);
          focusOption(last.value);
        }
        break;
      default:
        break;
    }
  };

  // Exactly one tab stop, and it has to be a button that can take focus: the selection
  // when it is enabled, otherwise the first enabled option. Falling back to index zero
  // regardless left the group unreachable by Tab whenever option zero was disabled, and
  // two options reporting tabIndex 0 is the bug that makes a radiogroup feel like a list
  // of buttons.
  const tabStopValue =
    value !== null && enabled.some((o) => o.value === value) ? value : (enabled[0]?.value ?? null);

  return (
    <div id={id} className="space-y-2 scroll-mt-12">
      <span id={labelId} className="block text-sm text-text-secondary">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        onKeyDown={handleKeyDown}
        className="flex flex-wrap gap-2"
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          const isDisabled = disabled || option.disabled;
          return (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={option.ariaLabel}
              ref={(el) => {
                if (el) optionRefs.current.set(option.value, el);
                else optionRefs.current.delete(option.value);
              }}
              disabled={isDisabled}
              tabIndex={!isDisabled && option.value === tabStopValue ? 0 : -1}
              onFocus={() => setFocusedValue(option.value)}
              onBlur={(e) => {
                // Leaving the group entirely resets tracking, so re-entering by Tab starts
                // from the real selection rather than from wherever focus last sat.
                if (!e.currentTarget.closest('[role="radiogroup"]')?.contains(e.relatedTarget)) {
                  setFocusedValue(null);
                }
              }}
              onClick={() => {
                if (isDisabled) return;
                setFocusedValue(option.value);
                onChange(option.value);
              }}
              className={cn(
                "px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium",
                "transition-colors duration-150",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                isDisabled && "opacity-50 cursor-not-allowed",
                isSelected
                  ? // forced-colors drops background and border colour, so the selected
                    // chip would otherwise look exactly like its siblings. An outline is
                    // the one treatment that survives there.
                    "bg-overlay-selected border border-border-strong text-text-primary forced-colors:outline forced-colors:outline-2"
                  : "border border-border-default text-text-secondary hover:bg-tint/5 hover:text-text-primary"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {description && (
        <p id={descriptionId} className="text-xs text-text-secondary">
          {description}
        </p>
      )}
    </div>
  );
}
