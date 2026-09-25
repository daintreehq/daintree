import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { settingsRowFrameClass, useSettingsGroup } from "./SettingsGroup";

interface SettingsCheckboxProps {
  id?: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  error?: string;
  touched?: boolean;
  scope?: "default" | "global" | "project";
  isModified?: boolean;
  onReset?: () => void;
}

/**
 * The settings-form flavour of `ui/Field` + `ui/Checkbox`: keeps the boolean
 * `onChange` this form layer has always used, adds the scope chip, and joins the
 * settings grid. The control and all of the ARIA come from the primitives.
 */
export function SettingsCheckbox({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  error,
  touched = true,
  scope,
  isModified,
  onReset,
}: SettingsCheckboxProps) {
  const group = useSettingsGroup();
  const isDisabled = !!disabled || (group?.disabled ?? false);
  const isError = touched && error !== undefined && error !== "";

  const scopeBadge = scope ? (
    <Badge size="xs">
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </Badge>
  ) : null;

  const showReset = !!isModified && !!onReset && !isDisabled;

  return (
    <div
      className={cn(
        "relative",
        group ? settingsRowFrameClass(group.depth) : "grid grid-cols-subgrid col-span-full gap-2",
        showReset && "flex items-start gap-2"
      )}
    >
      {isModified && (
        <span
          className="status-mark absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-state-modified"
          aria-hidden="true"
        />
      )}
      <Field
        orientation="horizontal"
        controlId={id}
        invalid={isError}
        disabled={isDisabled}
        className="flex-1"
      >
        <Checkbox
          checked={checked}
          onCheckedChange={(checkedState) => {
            if (checkedState !== "indeterminate") {
              onChange(checkedState);
            }
          }}
          disabled={isDisabled}
          aria-describedby={isDisabled ? group?.reasonId : undefined}
        />
        <FieldLabel accessory={scopeBadge} tinted>
          {label}
        </FieldLabel>
        <FieldDescription className="text-text-secondary">{description}</FieldDescription>
        {isError && <FieldError>{error}</FieldError>}
      </Field>
      {showReset && (
        <button
          type="button"
          aria-label={`Reset ${label} to default`}
          className="ml-auto p-1 rounded-sm text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          onClick={onReset}
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
