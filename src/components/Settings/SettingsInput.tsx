import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SETTINGS_CONTROL_WIDTH, SettingsRow, useSettingsGroup } from "./SettingsGroup";

interface SettingsInputProps extends Omit<ComponentPropsWithoutRef<"input">, "id"> {
  label: string;
  description?: ReactNode;
  error?: string;
  touched?: boolean;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  scope?: "default" | "global" | "project";
  ref?: Ref<HTMLInputElement>;
  /** Row anchor for search deep links. */
  rowId?: string;
  /**
   * Inside a group: `stacked` (the default for text) puts the field full width under
   * its label; `inline` puts it on the right rail at `controlWidth`.
   */
  layout?: "inline" | "stacked";
  controlWidth?: keyof typeof SETTINGS_CONTROL_WIDTH;
  /** Unit or suffix shown after an inline field ("MB", "px"). */
  suffix?: ReactNode;
  disabledReason?: string;
}

const SCOPE_LABEL = { project: "Project", global: "Global", default: "Default" } as const;

/**
 * The settings-form flavour of `ui/Field` + `ui/Input`: adds the scope chip, the
 * modified mark and the reset affordance. Inside a `SettingsGroup` it renders as a
 * group row; outside one it keeps the stacked field.
 */
export function SettingsInput({
  label,
  description,
  error,
  touched = true,
  isModified,
  onReset,
  resetAriaLabel,
  scope,
  disabled,
  className,
  ref,
  rowId,
  layout,
  controlWidth,
  suffix,
  disabledReason,
  ...props
}: SettingsInputProps) {
  const group = useSettingsGroup();
  const showReset = isModified && onReset && !disabled;
  const isError = !!error && touched;
  const scopeBadge = scope ? <Badge size="xs">{SCOPE_LABEL[scope]}</Badge> : null;

  if (group) {
    const rowLayout = layout ?? (props.type === "number" ? "inline" : "stacked");
    const width = controlWidth ?? (props.type === "number" ? "number" : "wide");
    return (
      <SettingsRow
        id={rowId}
        label={label}
        description={description}
        accessory={scopeBadge}
        layout={rowLayout}
        isModified={isModified}
        onReset={onReset}
        resetAriaLabel={resetAriaLabel}
        disabled={disabled}
        disabledReason={disabledReason}
        error={isError ? error : undefined}
        control={({ labelId, descriptionId, disabled: rowDisabled }) => (
          // The unit sits inside the field so every inline control still ends on the
          // row's rail; beside it, a "MB" pushed the field's edge off the column.
          <div className={cn("relative", rowLayout === "inline" && SETTINGS_CONTROL_WIDTH[width])}>
            <Input
              ref={ref}
              disabled={rowDisabled}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-invalid={isError ? true : undefined}
              className={cn("w-full", suffix && "pr-10", className)}
              {...props}
            />
            {suffix && (
              <span
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-secondary"
                aria-hidden="true"
              >
                {suffix}
              </span>
            )}
          </div>
        )}
      />
    );
  }

  const accessory = (
    <>
      {scopeBadge}
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
      <Input ref={ref} disabled={disabled} className={className} {...props} />
      {description && (
        <FieldDescription className="text-text-secondary">{description}</FieldDescription>
      )}
      {isError && <FieldError>{error}</FieldError>}
    </Field>
  );
}
