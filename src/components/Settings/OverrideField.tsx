import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { SETTINGS_CONTROL_WIDTH, SettingsRow } from "./SettingsGroup";

interface OverrideFieldProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "id" | "value" | "onChange" | "type"
> {
  label: ReactNode;
  /** Plain-text name for the reset button when `label` is not a string. */
  labelText?: string;
  /** Chips beside the label ("Required"). */
  accessory?: ReactNode;
  /** `undefined` inherits; any string is an override. */
  value: string | undefined;
  onChange: (value: string) => void;
  onReset: () => void;
  /**
   * What applies when nothing is overridden. Stays visible while overriding, so
   * the row always says what Reset would go back to.
   */
  inheritDescription: ReactNode;
  error?: string;
  layout?: "inline" | "stacked";
  controlWidth?: keyof typeof SETTINGS_CONTROL_WIDTH;
  inputClassName?: string;
}

/**
 * A settings row whose value is either inherited or overridden here. The override
 * wears the same modified bar and rail reset as every other settings row; emptying
 * the field goes back to inheriting rather than storing an empty override, which
 * would silently replace the inherited value with nothing.
 */
export function OverrideField({
  label,
  labelText,
  accessory,
  value,
  onChange,
  onReset,
  inheritDescription,
  error,
  layout = "inline",
  controlWidth = "wide",
  inputClassName,
  className,
  disabled,
  ...props
}: OverrideFieldProps) {
  const isOverriding = value !== undefined;
  const name = labelText ?? (typeof label === "string" ? label : "setting");

  return (
    <SettingsRow
      className={className}
      label={label}
      labelText={labelText}
      accessory={accessory}
      description={inheritDescription}
      layout={layout}
      isModified={isOverriding}
      onReset={onReset}
      resetAriaLabel={`Reset ${name} to default`}
      disabled={disabled}
      error={error}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        <div className={cn(layout === "inline" && SETTINGS_CONTROL_WIDTH[controlWidth])}>
          <Input
            type="text"
            value={value ?? ""}
            onChange={(e) => {
              if (e.target.value === "" && value !== undefined) onReset();
              else onChange(e.target.value);
            }}
            disabled={rowDisabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={error ? true : undefined}
            className={cn("w-full", inputClassName)}
            {...props}
          />
        </div>
      )}
    />
  );
}
