import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
}

/**
 * The settings-form flavour of `ui/Field` + `ui/Input`: adds the scope chip, the
 * modified dot and the reset affordance, and participates in the settings grid.
 * Everything about labels, descriptions and ARIA comes from `Field`.
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
  ...props
}: SettingsInputProps) {
  const showReset = isModified && onReset && !disabled;
  const isError = !!error && touched;

  const accessory = (
    <>
      {scope && (
        <Badge size="xs" className="bg-text-secondary/10 dark:bg-text-secondary/20">
          {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
        </Badge>
      )}
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
            "p-0.5 rounded-sm text-text-muted hover:text-text-primary",
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
    <Field className="group grid-cols-subgrid col-span-full" invalid={isError} disabled={disabled}>
      <FieldLabel accessory={accessory}>{label}</FieldLabel>
      <Input ref={ref} disabled={disabled} className={className} {...props} />
      {description && <FieldDescription>{description}</FieldDescription>}
      {isError && <FieldError>{error}</FieldError>}
    </Field>
  );
}
