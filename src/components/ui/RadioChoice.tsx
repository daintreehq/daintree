import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled single-choice group built on native radios.
 *
 * Deliberately not `SettingsChoicebox`: that one is `role="radio"` buttons with
 * a roving tabindex, so its arrow keys move focus without moving the selection.
 * A native radio group moves both together, is one tab stop, and has its checked
 * state painted by the user agent — which is the only thing that still reads as
 * "chosen" once `forced-colors: active` has flattened every author fill and
 * border. Anything mutually exclusive and keyboard-driven should use this;
 * `SettingsChoicebox` remains for the settings-form grid it is built into.
 *
 * The row is the click target, so the whole card is the `<label>`. That would
 * normally fold the description into the accessible name and announce each
 * option as one run-on string, which is why the title is named explicitly and
 * the description is attached as a description instead.
 */

/**
 * No display utility here: the shell composes onto a `flex` label, and
 * tailwind-merge resolves same-property utilities by order, so a `block` in this
 * string silently wins and drops the control onto its own line.
 *
 * The focus ring sits on the row rather than the ~13px control — the row is what
 * the pointer targets and it encloses the control. Scoped to `input` so focusing
 * a nested dependent control does not also light up the card.
 */
export const CHOICE_SHELL =
  "rounded-[var(--radius-md)] border transition-colors duration-150 " +
  "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 " +
  "has-[input:focus-visible]:outline-accent-primary has-[input:focus-visible]:outline-offset-2";

export const CHOICE_PAD = "px-3 py-2.5";

/**
 * The transparent outline is not decoration. Under `forced-colors: active` the
 * UA overrides `outline-color` — including `transparent` — to a system colour,
 * so this is what keeps the chosen card distinguishable once the fill and the
 * border have both been repainted to the same value. It costs nothing in normal
 * rendering.
 */
export const CHOICE_SELECTED =
  "border-border-strong bg-overlay-selected outline outline-2 outline-transparent";

export const CHOICE_UNSELECTED =
  "border-border-default hover:bg-overlay-soft hover:border-daintree-text/30";

/** Control (~13px) + `gap-3`, so a nested control lines up with the label column. */
export const CHOICE_LABEL_INSET = "ml-[25px]";

interface RadioChoiceGroupProps {
  /** Names the group. Visible unless `legendHidden`. */
  legend: string;
  legendHidden?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function RadioChoiceGroup({
  legend,
  legendHidden,
  children,
  className,
}: RadioChoiceGroupProps) {
  return (
    <fieldset className={cn("space-y-2", className)}>
      <legend
        className={cn(legendHidden ? "sr-only" : "text-sm font-medium text-text-primary mb-2")}
      >
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}

interface RadioChoiceRowProps {
  /**
   * The group name. Always passed in, never derived from `useId` — end-to-end
   * specs select these groups by name.
   */
  name: string;
  /** Always emitted as the `value` attribute; specs select on it. */
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  /** What the user ends up with. Announced as a description, not part of the name. */
  description?: string;
  disabled?: boolean;
  /** Lands on the `<input>`, never on the shell — clicking a wrapper misses the control. */
  testId?: string;
  /**
   * Rendered inside a row that already paints the choice surface, for options
   * that host a dependent control. The caller owns the shell and must keep the
   * dependent control outside this label so it cannot retoggle the option.
   */
  bare?: boolean;
  className?: string;
}

export function RadioChoiceRow({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  disabled,
  testId,
  bare,
  className,
}: RadioChoiceRowProps) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <label
      className={cn(
        "flex items-start gap-3",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        CHOICE_PAD,
        // A bare row is padded by the same rule but leaves the border and fill
        // to the shell that wraps it, so the whole card stays one target.
        !bare && [CHOICE_SHELL, checked ? CHOICE_SELECTED : CHOICE_UNSELECTED],
        className
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        data-testid={testId}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        // The accent tint comes from the global `accent-color` base rule. The
        // visible focus indicator is the row's, so the control's own ring is
        // neutralised with a transparent outline rather than one of the
        // outline-suppressing utilities, which the repo's focus-ring contract
        // treats as removing the indicator outright. Left bare it would fall
        // through to Chromium's cobalt, the one hue the app never renders.
        // Under forced-colors the UA repaints this outline, so the control
        // keeps a system ring there as well.
        //
        // mt-1 centres the ~13px control in the label's 20px line box.
        className="mt-1 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-transparent"
      />
      <span className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-text-primary">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="block text-xs text-text-secondary select-text">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
