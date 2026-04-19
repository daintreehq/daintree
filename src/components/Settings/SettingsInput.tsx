import { useId } from "react";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const INPUT_CLASSES =
  "w-full bg-surface-input border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

interface SettingsInputProps extends Omit<ComponentPropsWithoutRef<"input">, "id"> {
  label: string;
  description?: ReactNode;
  error?: string;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  scope?: "default" | "global" | "project";
  ref?: Ref<HTMLInputElement>;
}

export function SettingsInput({
  label,
  description,
  error,
  isModified,
  onReset,
  resetAriaLabel,
  scope,
  disabled,
  className,
  ref,
  ...props
}: SettingsInputProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const showReset = isModified && onReset && !disabled;

  const describedBy =
    [description && !error ? descriptionId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const scopeBadge = scope ? (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
        scope === "project"
          ? "bg-daintree-accent/10 text-daintree-accent dark:bg-daintree-accent/20"
          : scope === "global"
            ? "bg-blue-500/10 text-blue-500 dark:bg-blue-500/20"
            : "bg-text-secondary/10 text-text-secondary dark:bg-text-secondary/20"
      }`}
    >
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </span>
  ) : null;

  return (
    <div className="group flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-text-secondary">
          {label}
        </label>
        {scopeBadge}
        {isModified && (
          <span className="w-1.5 h-1.5 rounded-full bg-daintree-accent" aria-hidden="true" />
        )}
        {showReset && (
          <button
            type="button"
            aria-label={resetAriaLabel ?? `Reset ${label} to default`}
            className={cn(
              "p-0.5 rounded-sm text-text-muted hover:text-daintree-accent",
              "invisible group-hover:visible group-focus-within:visible focus-visible:visible",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
              "transition-colors"
            )}
            onClick={onReset}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>
      <input
        id={id}
        ref={ref}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(INPUT_CLASSES, error && "border-status-error", className)}
        {...props}
      />
      {description && !error && (
        <p id={descriptionId} className="text-xs text-text-muted select-text">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
