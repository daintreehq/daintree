import { useId } from "react";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const TEXTAREA_CLASSES =
  "w-full bg-surface-input border border-border-strong rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-daintree-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed";

interface SettingsTextareaProps extends Omit<ComponentPropsWithoutRef<"textarea">, "id"> {
  label: string;
  description?: ReactNode;
  error?: string;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

export function SettingsTextarea({
  label,
  description,
  error,
  isModified,
  onReset,
  resetAriaLabel,
  disabled,
  className,
  ref,
  ...props
}: SettingsTextareaProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const showReset = isModified && onReset && !disabled;

  const describedBy =
    [description && !error ? descriptionId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="group flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-text-secondary">
          {label}
        </label>
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
      <textarea
        id={id}
        ref={ref}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(TEXTAREA_CLASSES, error && "border-status-error", className)}
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
