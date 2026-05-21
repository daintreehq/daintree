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
  touched?: boolean;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

export function SettingsTextarea({
  label,
  description,
  error,
  touched = true,
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
  const isError = !!error && touched;

  const describedBy =
    [isError ? errorId : null, description ? descriptionId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className="group grid grid-cols-subgrid gap-2 col-span-full">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-text-secondary">
          {label}
        </label>
        {isModified && (
          <span className="w-1.5 h-1.5 rounded-full bg-state-modified" aria-hidden="true" />
        )}
        {showReset && (
          <button
            type="button"
            aria-label={resetAriaLabel ?? `Reset ${label} to default`}
            className={cn(
              "p-0.5 rounded-sm text-text-muted hover:text-daintree-text",
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
        aria-invalid={isError ? true : undefined}
        className={cn(TEXTAREA_CLASSES, isError && "border-status-error", className)}
        {...props}
      />
      {description && (
        <p id={descriptionId} className="text-xs text-text-muted select-text">
          {description}
        </p>
      )}
      {isError && (
        <p id={errorId} className="text-xs text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
