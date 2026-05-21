import type React from "react";
import { useId } from "react";

export interface TypedNameConfirmInputProps {
  target: string;
  value: string;
  onChange: (value: string) => void;
  onMatchSubmit?: () => void;
  preamble?: React.ReactNode;
  instructions?: React.ReactNode;
  "data-testid"?: string;
}

export function TypedNameConfirmInput({
  target,
  value,
  onChange,
  onMatchSubmit,
  preamble,
  instructions,
  "data-testid": testId,
}: TypedNameConfirmInputProps) {
  const instructionsId = useId();
  const preambleId = useId();
  const isMatched = value === target;
  const hasPreamble = preamble != null && instructions == null;

  const defaultInstructions = (
    <>
      Type{" "}
      <code className="font-mono text-xs bg-daintree-bg/50 px-1.5 py-0.5 rounded border border-daintree-border">
        {target}
      </code>{" "}
      to confirm.
    </>
  );

  return (
    <div className="space-y-2 p-3 bg-status-error/5 border border-status-error/20 rounded">
      {hasPreamble && (
        <p id={preambleId} className="text-sm text-daintree-text">
          {preamble}
        </p>
      )}
      <p id={instructionsId} className="text-sm text-daintree-text">
        {instructions ?? defaultInstructions}
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        className="w-full px-3 py-2 text-sm font-mono bg-daintree-bg border border-daintree-border rounded focus:outline-hidden focus:ring-2 focus:ring-status-error"
        data-testid={testId}
      />
      <span className="sr-only" aria-live="polite">
        {isMatched ? "Name confirmed. You may now confirm." : ""}
      </span>
    </div>
  );
}
