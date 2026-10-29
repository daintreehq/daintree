import { useId } from "react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsInlineError,
  SettingsRow,
  useSettingsGroup,
} from "./SettingsGroup";
import { SettingsResetButton } from "./SettingsResetButton";

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** A brand mark shown beside the label in the list and, once picked, in the trigger. */
  icon?: ComponentType<{ size?: number; className?: string }>;
}

interface SettingsSelectProps {
  label: string;
  description?: ReactNode;
  error?: string;
  touched?: boolean;
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
  /** Row anchor for search deep links. */
  id?: string;
  /** Inside a group: `inline` (default) puts the select on the right rail; `stacked` goes full width. */
  layout?: "inline" | "stacked";
  /** Inline trigger width — `wide` for values longer than a few words. */
  controlWidth?: "select" | "wide";
  /** Why the row is disabled, shown with it while it is. */
  disabledReason?: string;
  /** Inside a group: a transient state beside the label, such as "Saving…". */
  status?: ReactNode;
}

const SCOPE_LABEL = { project: "Project", global: "Global", default: "Default" } as const;

export function SettingsSelect({
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
  value,
  onValueChange,
  options,
  placeholder,
  name,
  id: rowId,
  layout = "inline",
  controlWidth = "select",
  disabledReason,
  status,
}: SettingsSelectProps) {
  const group = useSettingsGroup();
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const showReset = isModified && onReset && !disabled;
  const isError = !!error && touched;

  const describedBy =
    [isError ? errorId : null, description ? descriptionId : null].filter(Boolean).join(" ") ||
    undefined;

  const scopeBadge = scope ? <Badge size="xs">{SCOPE_LABEL[scope]}</Badge> : null;

  const items = options.map((option) => (
    <SelectItem
      key={option.value}
      value={option.value}
      description={option.description}
      disabled={option.disabled}
    >
      {option.icon ? (
        <span className="inline-flex items-center gap-2 align-middle">
          <option.icon size={14} className="shrink-0 text-text-secondary" />
          {option.label}
        </span>
      ) : (
        option.label
      )}
    </SelectItem>
  ));

  if (group) {
    return (
      <SettingsRow
        id={rowId}
        label={label}
        description={description}
        accessory={
          status ? (
            <>
              {scopeBadge}
              {status}
            </>
          ) : (
            scopeBadge
          )
        }
        layout={layout}
        isModified={isModified}
        onReset={onReset}
        resetAriaLabel={resetAriaLabel}
        disabled={disabled}
        disabledReason={disabledReason}
        error={isError ? error : undefined}
        control={({ labelId, descriptionId: rowDescriptionId, disabled: rowDisabled }) => (
          <Select value={value} onValueChange={onValueChange} disabled={rowDisabled} name={name}>
            <SelectTrigger
              aria-labelledby={labelId}
              aria-describedby={rowDescriptionId}
              aria-invalid={isError ? true : undefined}
              className={cn(
                layout === "inline" && SETTINGS_CONTROL_WIDTH[controlWidth],
                isError && "border-status-error",
                className
              )}
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>{items}</SelectContent>
          </Select>
        )}
      />
    );
  }

  return (
    <div
      id={rowId}
      className="group grid grid-cols-subgrid gap-2 col-span-full"
      data-settings-reset-scope=""
    >
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-text-secondary">
          {label}
        </label>
        {scopeBadge}
        {isModified && (
          <span
            className="status-mark w-1.5 h-1.5 rounded-full bg-state-modified"
            aria-hidden="true"
          />
        )}
        {showReset && onReset && (
          <SettingsResetButton
            label={resetAriaLabel ?? `Reset ${label} to default`}
            onReset={onReset}
          />
        )}
      </div>
      <Select value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
        <SelectTrigger
          id={id}
          aria-describedby={describedBy}
          aria-invalid={isError ? true : undefined}
          className={cn(isError && "border-status-error", className)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
      {description && (
        <p id={descriptionId} className="text-xs text-text-secondary select-text">
          {description}
        </p>
      )}
      {isError && <SettingsInlineError id={errorId}>{error}</SettingsInlineError>}
    </div>
  );
}
