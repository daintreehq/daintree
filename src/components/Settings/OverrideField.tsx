import { useId } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverrideFieldProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "id" | "value" | "onChange"
> {
  label: string;
  hint?: ReactNode;
  value: string | undefined;
  onChange: (value: string) => void;
  onReset: () => void;
  inheritDescription: ReactNode;
  overrideDescription?: ReactNode;
  error?: string;
  inputClassName?: string;
}

export function OverrideField({
  label,
  hint,
  value,
  onChange,
  onReset,
  inheritDescription,
  overrideDescription = "Overriding app default",
  error,
  inputClassName,
  className,
  disabled,
  ...props
}: OverrideFieldProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const isOverriding = value !== undefined;
  const showReset = isOverriding && !disabled;
  const describedBy =
    [error ? errorId : null, descriptionId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("group", className)}>
      <div className="flex items-center gap-2 mb-1 min-h-[1.25rem]">
        <label htmlFor={id} className="block text-xs font-medium text-daintree-text/60">
          {label}
          {hint && <span className="ml-1 text-daintree-text/40">{hint}</span>}
        </label>
        {isOverriding && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-status-info"
            aria-hidden="true"
            data-testid="override-indicator"
          />
        )}
        {showReset && (
          <button
            type="button"
            aria-label="Reset to global"
            onClick={onReset}
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] text-text-muted hover:text-daintree-text hover:bg-overlay-subtle",
              "invisible group-hover:visible group-focus-within:visible focus-visible:visible",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
              "transition-colors"
            )}
          >
            <RotateCcw className="w-3 h-3" />
            Reset to global
          </button>
        )}
      </div>
      <input
        id={id}
        value={value ?? ""}
        onChange={(e) => {
          // Clearing the input while overriding is treated as a reset — keeps
          // the visible UI state and the persisted state from drifting (empty
          // overrides for shell/cwd/scrollback aren't meaningful).
          if (e.target.value === "" && value !== undefined) {
            onReset();
          } else {
            onChange(e.target.value);
          }
        }}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(
          "w-full bg-daintree-bg border rounded px-3 py-2 text-sm text-daintree-text font-mono",
          "focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30",
          "transition-colors placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed",
          isOverriding ? "border-status-info/40" : "border-daintree-border",
          error && "border-status-error",
          inputClassName
        )}
        {...props}
      />
      <p
        id={descriptionId}
        className={cn(
          "mt-1 text-xs",
          isOverriding ? "text-text-muted" : "text-daintree-text/40 italic"
        )}
      >
        {isOverriding ? overrideDescription : inheritDescription}
      </p>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
