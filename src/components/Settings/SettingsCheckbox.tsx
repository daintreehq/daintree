import { useId } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type CheckedState = boolean | "indeterminate";

interface SettingsCheckboxProps {
  id?: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  error?: string;
  scope?: "default" | "global" | "project";
}

export function SettingsCheckbox({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  error,
  scope,
}: SettingsCheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;
  const descriptionId = useId();
  const errorId = useId();

  const describedBy = error ? errorId : descriptionId;
  const isError = error !== undefined && error !== "";

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
    <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer">
      <Checkbox.Root
        id={checkboxId}
        checked={checked as CheckedState}
        onCheckedChange={(checkedState) => {
          if (checkedState !== "indeterminate") {
            onChange(checkedState);
          }
        }}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={isError}
        className={cn(
          "relative flex shrink-0 w-4 h-4 mt-0.5 rounded border transition-colors duration-150",
          "bg-daintree-bg border-border-strong",
          "data-[state=checked]:bg-daintree-accent data-[state=checked]:border-daintree-accent",
          "data-[state=indeterminate]:bg-daintree-accent data-[state=indeterminate]:border-daintree-accent",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          isError &&
            "border-status-error data-[state=checked]:border-status-error data-[state=indeterminate]:border-status-error"
        )}
      >
        <Checkbox.Indicator className="flex items-center justify-center w-full h-full text-text-inverse">
          <CheckIcon className="w-3 h-3 block" data-state="checked" />
          <MinusIcon className="w-3 h-3 hidden" data-state="indeterminate" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <div className="flex-1">
        <span
          className={cn(
            "text-sm font-medium block",
            "text-daintree-text",
            disabled && "cursor-not-allowed opacity-50",
            isError && "text-status-error"
          )}
        >
          {label}
        </span>
        {scopeBadge}
        {!isError && (
          <p id={descriptionId} className="text-xs text-text-muted mt-0.5 select-text">
            {description}
          </p>
        )}
        {isError && (
          <p id={errorId} role="alert" className="text-xs text-status-error mt-0.5">
            {error}
          </p>
        )}
      </div>
    </label>
  );
}
