import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Field chrome for the create-worktree form. Deliberately the same language as
 * `SettingsInput` — one recessed surface, one border weight — so the dialog
 * reads as a single designed surface instead of a stack of separately-styled
 * boxes. Focus is the global accent outline; nothing here paints accent at rest.
 */
export const FIELD_SURFACE =
  "bg-surface-input border border-border-strong rounded-[var(--radius-md)] transition-colors duration-150 ease-out";

export const FIELD_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";

export const FIELD_INPUT = cn(
  FIELD_SURFACE,
  FIELD_FOCUS,
  "w-full h-8 px-2.5 text-sm text-daintree-text placeholder:text-text-placeholder",
  "disabled:opacity-50 disabled:cursor-not-allowed"
);

/**
 * Combobox triggers are `Button`s. `ghost` is the base because it carries no
 * ring/shadow of its own to fight — the field chrome below is the whole look.
 */
export const FIELD_TRIGGER = cn(
  FIELD_SURFACE,
  "w-full h-8 justify-between px-2.5 font-normal text-daintree-text",
  "hover:bg-surface-hover hover:text-daintree-text hover:border-border-default"
);

const LABEL_CLASSES = "text-xs text-text-secondary";

interface FormSectionProps {
  title: string;
  /** Section-level control (e.g. the branch-mode switch) pinned to the right of the rule. */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The single grid every section and row lands in. One grid for the whole form,
 * not one per section, so the label rail is the same column everywhere — with a
 * grid per section, a long label in one section would silently widen that
 * section's rail and break alignment against the others.
 *
 * `max-content` sizes the rail to the longest label rather than a guessed
 * width, which keeps it honest under translation; the `4rem` floor stops a form
 * of short labels from collapsing it.
 */
export function FormGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(4rem,max-content)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
      {children}
    </div>
  );
}

/**
 * A titled group of rows. The hairline between title and action is what turns a
 * flat field stack into readable sections without spending another border on
 * every control.
 *
 * Renders a fragment: the header spans both columns of {@link FormGrid} and the
 * rows drop straight into it, so sections group visually without taking the
 * rows out of the shared rail.
 */
export function FormSection({ title, action, children }: FormSectionProps) {
  return (
    <>
      <div className="col-span-2 flex items-center gap-3 [&:not(:first-child)]:mt-3">
        <h3 className="text-xs font-semibold text-daintree-text shrink-0">{title}</h3>
        <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
        {action}
      </div>
      {children}
    </>
  );
}

interface FormRowProps {
  label?: string;
  /** Id of the labelled control. Omit for composite controls — see below. */
  htmlFor?: string;
  /** Secondary content under the control — hints, inline toggles, status. */
  hint?: React.ReactNode;
  /**
   * The control already carries its own accessible name (e.g. a radiogroup with
   * `aria-label`). Skips the group wrapper, which would otherwise make screen
   * readers announce the name twice — "Environment, group, Environment, radio
   * group". Keep the control's name matching the visible label (WCAG 2.5.3).
   */
  selfLabelled?: boolean;
  children: React.ReactNode;
}

/**
 * One control on the section's shared label rail. Returns a fragment so its
 * cells land directly in that grid — a wrapper element would give each row its
 * own independent columns and the rail would stop lining up.
 *
 * A row whose control is a single element names it with a real `<label for>`.
 * A row whose control is composite (a radiogroup, a forge-contributed slot)
 * cannot be, so it labels the control region as a `role="group"` instead —
 * visually aligned is not the same as programmatically named.
 */
export function FormRow({ label, htmlFor, hint, selfLabelled, children }: FormRowProps) {
  const labelId = useId();
  const needsGroupLabel = !!label && !htmlFor && !selfLabelled;

  return (
    <>
      {label ? (
        htmlFor ? (
          <label htmlFor={htmlFor} className={LABEL_CLASSES}>
            {label}
          </label>
        ) : (
          <span id={labelId} className={LABEL_CLASSES}>
            {label}
          </span>
        )
      ) : (
        <span aria-hidden="true" />
      )}
      <div
        className="min-w-0"
        {...(needsGroupLabel ? { role: "group", "aria-labelledby": labelId } : {})}
      >
        {children}
      </div>
      {hint && <div className="col-start-2 min-w-0">{hint}</div>}
    </>
  );
}
