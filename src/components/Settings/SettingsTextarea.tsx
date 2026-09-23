import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SettingsRow, useSettingsGroup } from "./SettingsGroup";

interface SettingsTextareaProps extends Omit<ComponentPropsWithoutRef<"textarea">, "id"> {
  label: string;
  description?: ReactNode;
  error?: string;
  touched?: boolean;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  ref?: Ref<HTMLTextAreaElement>;
  /** Row anchor for search deep links. */
  rowId?: string;
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
  rowId,
  ...props
}: SettingsTextareaProps) {
  const group = useSettingsGroup();
  const showReset = isModified && onReset && !disabled;
  const isError = !!error && touched;

  if (group) {
    return (
      <SettingsRow
        id={rowId}
        label={label}
        description={description}
        layout="stacked"
        isModified={isModified}
        onReset={onReset}
        resetAriaLabel={resetAriaLabel}
        disabled={disabled}
        error={isError ? error : undefined}
        control={({ labelId, descriptionId, disabled: rowDisabled }) => (
          <Textarea
            variant="code"
            ref={ref}
            disabled={rowDisabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={isError ? true : undefined}
            className={className}
            {...props}
          />
        )}
      />
    );
  }

  const accessory = (
    <>
      {isModified && (
        <span
          className="status-mark w-1.5 h-1.5 rounded-full bg-state-modified"
          aria-hidden="true"
        />
      )}
      {showReset && (
        <button
          type="button"
          aria-label={resetAriaLabel ?? `Reset ${label} to default`}
          className={cn(
            "p-0.5 rounded-sm text-text-secondary hover:text-text-primary",
            "invisible group-hover:visible group-focus-within:visible focus-visible:visible",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            "transition-colors"
          )}
          onClick={onReset}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </>
  );

  return (
    <Field
      id={rowId}
      className="group grid-cols-subgrid col-span-full"
      invalid={isError}
      disabled={disabled}
    >
      <FieldLabel accessory={accessory}>{label}</FieldLabel>
      {/* Settings textareas hold prompts, paths and env blocks — read character
          by character, so the monospace variant rather than the prose default. */}
      <Textarea variant="code" ref={ref} disabled={disabled} className={className} {...props} />
      {description && (
        <FieldDescription className="text-text-secondary">{description}</FieldDescription>
      )}
      {isError && <FieldError>{error}</FieldError>}
    </Field>
  );
}
