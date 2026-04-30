import { useId } from "react";
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SettingsSelectProps {
  label: string;
  description?: ReactNode;
  error?: string;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  scope?: "default" | "global" | "project";
  disabled?: boolean;
  className?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SettingsSelectOption[];
  placeholder?: string;
  name?: string;
}

export function SettingsSelect({
  label,
  description,
  error,
  isModified,
  onReset,
  resetAriaLabel,
  scope,
  disabled,
  className,
  value,
  onValueChange,
  options,
  placeholder,
  name,
}: SettingsSelectProps) {
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
          ? "bg-status-info/10 text-status-info"
          : scope === "global"
            ? "bg-status-info/10 text-status-info"
            : "bg-text-secondary/10 text-text-secondary dark:bg-text-secondary/20"
      }`}
    >
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </span>
  ) : null;

  return (
    <div className="group grid grid-cols-subgrid gap-2 col-span-full">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-daintree-text/70">
          {label}
        </label>
        {scopeBadge}
        {isModified && (
          <span className="w-1.5 h-1.5 rounded-full bg-state-modified" aria-hidden="true" />
        )}
        {showReset && (
          <button
            type="button"
            aria-label={resetAriaLabel ?? `Reset ${label} to default`}
            className={cn(
              "p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-text",
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
      <Select value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
        <SelectTrigger
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(error && "border-status-error focus:border-status-error", className)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              description={option.description}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && !error && (
        <p id={descriptionId} className="text-xs text-daintree-text/40 select-text">
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
