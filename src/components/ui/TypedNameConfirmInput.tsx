import type React from "react";
import { useId } from "react";

export interface TypedNameConfirmInputProps {
  target: string;
  value: string;
  onChange: (value: string) => void;
  onMatchSubmit?: () => void;
  preamble?: React.ReactNode;
  instructions?: React.ReactNode;
  /**
   * Freeze the field while a destructive submit is already in flight, so the
   * typed value cannot change out from under an awaiting dispatch.
   */
  disabled?: boolean;
  /**
   * The same freeze, but the field keeps focus: for a submit that can come
   * back and ask for the gate again, where a disabled field would have
   * dropped the user's focus on the page.
   */
  readOnly?: boolean;
  "data-testid"?: string;
}

export function TypedNameConfirmInput({
  target,
  value,
  onChange,
  onMatchSubmit,
  preamble,
  instructions,
  disabled = false,
  readOnly = false,
  "data-testid": testId,
}: TypedNameConfirmInputProps) {
  const instructionsId = useId();
  const preambleId = useId();
  const isMatched = value === target;
  const hasPreamble = preamble != null && instructions == null;

  const defaultInstructions = (
    <>
      Type{" "}
      {/* `box-decoration-break: clone` so a long name that wraps is drawn as
          one chip per line, each with its own caps, rather than a single
          chip split open across the break. */}
      <code className="font-mono text-xs bg-surface-canvas px-1.5 py-0.5 rounded-[var(--radius-sm)] border border-border-strong [overflow-wrap:anywhere] [box-decoration-break:clone]">
        {target}
      </code>{" "}
      to confirm.
    </>
  );

  return (
    <div className="space-y-2 p-3 bg-status-error/5 border border-status-error/20 rounded-[var(--radius-md)]">
      {hasPreamble && (
        <p id={preambleId} className="text-sm text-text-primary">
          {preamble}
        </p>
      )}
      <p id={instructionsId} className="text-sm text-text-primary">
        {instructions ?? defaultInstructions}
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isMatched && onMatchSubmit) {
            e.preventDefault();
            onMatchSubmit();
          }
        }}
        aria-describedby={hasPreamble ? `${preambleId} ${instructionsId}` : instructionsId}
        aria-label={`Type ${target} to confirm`}
        aria-required="true"
        aria-invalid={value.length > 0 && !isMatched}
        autoComplete="off"
        spellCheck={false}
        // Scroll margin so focusing the field in a scrolled dialog body brings
        // it clear of the body's bottom fade rather than parking it beneath.
        className="w-full px-3 py-2 text-sm font-mono bg-surface-canvas border border-border-input rounded-[var(--radius-md)] focus:outline-hidden focus:ring-2 focus:ring-status-error disabled:opacity-50 read-only:opacity-50 scroll-mb-8"
        data-testid={testId}
      />
      <span className="sr-only" aria-live="polite">
        {isMatched ? "Name confirmed. You may now confirm." : ""}
      </span>
    </div>
  );
}
