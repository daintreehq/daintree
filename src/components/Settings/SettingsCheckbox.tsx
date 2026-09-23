import { Badge } from "@/components/ui/badge";
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
}: SettingsCheckboxProps) {
  const group = useSettingsGroup();
  const isDisabled = !!disabled || (group?.disabled ?? false);
  const isError = touched && error !== undefined && error !== "";

  const scopeBadge = scope ? (
    <Badge size="xs">
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </Badge>
  ) : null;

  return (
    <div
      className={
        group ? settingsRowFrameClass(group.depth) : "grid grid-cols-subgrid col-span-full gap-2"
      }
    >
      <Field orientation="horizontal" controlId={id} invalid={isError} disabled={isDisabled}>
        <Checkbox
          checked={checked}
          onCheckedChange={(checkedState) => {
            if (checkedState !== "indeterminate") {
              onChange(checkedState);
            }
          }}
          disabled={isDisabled}
        />
        <FieldLabel accessory={scopeBadge} tinted>
          {label}
        </FieldLabel>
        <FieldDescription className="text-text-secondary">{description}</FieldDescription>
        {isError && <FieldError>{error}</FieldError>}
      </Field>
    </div>
  );
}
