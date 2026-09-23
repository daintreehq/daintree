import { useId, useRef, useEffect } from "react";
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsRowFrameClass, useSettingsGroup } from "./SettingsGroup";

export interface ChoiceboxOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Subordinate annotation shown after the label, e.g. the value an inherit slot resolves to. */
  resolvedLabel?: string;
  /** Renders the option as a softer, subordinate slot (e.g. a reset/inherit default). */
  muted?: boolean;
}

interface SettingsChoiceboxProps<T extends string = string> extends Omit<
  ComponentPropsWithoutRef<"div">,
  "onChange"
> {
  label?: string;
  description?: ReactNode;
  error?: string;
  touched?: boolean;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly ChoiceboxOption<T>[];
  columns?: 1 | 2 | 3 | 4;
  disabled?: boolean;
  className?: string;
}

const CARD_BASE_CLASSES =
  "flex-1 px-3 py-2 rounded-[var(--radius-md)] border text-sm text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

const CARD_SELECTED_CLASSES = "border-border-strong bg-overlay-subtle text-text-primary shadow-sm";

const CARD_UNSELECTED_CLASSES =
  "border-border-default bg-surface-canvas text-text-secondary hover:border-daintree-text/30 hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border-default disabled:hover:text-text-secondary";

export function SettingsChoicebox<T extends string = string>({
  label,
  description,
  error,
  touched = true,
  isModified,
  onReset,
  resetAriaLabel,
  value,
  onChange,
  options,
  columns = 1,
  disabled: ownDisabled,
  className,
  "aria-label": ariaLabel,
  ...props
}: SettingsChoiceboxProps<T>) {
  const group = useSettingsGroup();
  const disabled = ownDisabled || (group?.disabled ?? false);
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const showReset = isModified && onReset && !disabled;
  const isError = !!error && touched;

  const describedBy =
    [isError ? errorId : null, description ? descriptionId : null].filter(Boolean).join(" ") ||
    undefined;

  const containerRef = useRef<HTMLDivElement>(null);

  const initiallyFocusableIndex = (() => {
    const selectedIndex = options.findIndex((o) => o.value === value);
    if (selectedIndex >= 0 && !disabled && !options[selectedIndex]?.disabled) {
      return selectedIndex;
    }
    const firstEnabledIndex = options.findIndex((o) => !o.disabled && !disabled);
    return firstEnabledIndex >= 0 ? firstEnabledIndex : -1;
  })();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[role='radio']:not(:disabled)")
      );
      if (buttons.length === 0) return;

      const currentIndex = buttons.findIndex((b) => b === document.activeElement);

      let nextIndex = currentIndex;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextIndex = currentIndex < buttons.length - 1 ? currentIndex + 1 : 0;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
      } else if (e.key === "Home") {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        nextIndex = buttons.length - 1;
      } else if ((e.key === " " || e.key === "Enter") && currentIndex >= 0) {
        e.preventDefault();
        const button = buttons[currentIndex];
        if (!button) return;
        const buttonValue = button.getAttribute("data-value");
        if (buttonValue !== null) onChange(buttonValue as T);
        return;
      }

      // Radio semantics: moving is choosing. A radiogroup whose arrows only move focus
      // leaves a screen-reader user hearing "checked" on one option while standing on
      // another, and needing a second key to commit what the pattern already implies.
      if (nextIndex !== currentIndex && nextIndex >= 0 && nextIndex < buttons.length) {
        const next = buttons[nextIndex];
        next?.focus();
        const nextValue = next?.getAttribute("data-value");
        if (nextValue !== null && nextValue !== undefined) onChange(nextValue as T);
      }
    };

    container.addEventListener("keydown", handleKeyDown as unknown as EventListener);
    return () =>
      container.removeEventListener("keydown", handleKeyDown as unknown as EventListener);
  }, [onChange, options]);

  if (group) {
    const resetName = resetAriaLabel ?? (label ? `Reset ${label} to default` : "Reset to default");
    const frame = settingsRowFrameClass(group.depth);
    // A disabled `SettingsDependents` says why once; every control under it points at it.
    const groupDescribedBy =
      [describedBy, disabled ? group.reasonId : undefined].filter(Boolean).join(" ") || undefined;
    return (
      <div className={cn("group relative", className)} {...props}>
        {isModified && (
          <span
            className="status-mark absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-state-modified"
            aria-hidden="true"
          />
        )}
        {(label || description || showReset) && (
          <div className={cn("flex items-start gap-2", frame, "pt-3 pb-1")}>
            <div className={cn("min-w-0 flex-1", disabled && "opacity-50")}>
              {label && (
                <span id={labelId} className="block text-sm font-medium text-text-primary">
                  {label}
                </span>
              )}
              {description && (
                <p id={descriptionId} className="mt-0.5 text-xs text-text-secondary select-text">
                  {description}
                </p>
              )}
            </div>
            {showReset && (
              <button
                type="button"
                aria-label={resetName}
                className={cn(
                  "p-1 rounded-sm text-text-secondary hover:text-text-primary transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                )}
                onClick={onReset}
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div
          ref={containerRef}
          id={id}
          role="radiogroup"
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={groupDescribedBy}
          aria-invalid={isError ? true : undefined}
          className="divide-y divide-border-subtle"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isOptionDisabled = disabled || option.disabled;
            const optionLabelId = `${id}-option-${index}-label`;
            const optionDescriptionId = `${id}-option-${index}-description`;

            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={isOptionDisabled}
                // Named by the label (and what an inherit slot resolves to) alone; the
                // option's description is announced as a description, not a run-on name.
                aria-labelledby={optionLabelId}
                aria-describedby={option.description ? optionDescriptionId : undefined}
                tabIndex={index === initiallyFocusableIndex ? 0 : -1}
                disabled={isOptionDisabled}
                data-value={option.value}
                onClick={() => {
                  if (!isOptionDisabled) onChange(option.value);
                }}
                className={cn(
                  "flex w-full items-start gap-3 text-left text-sm transition-colors",
                  frame,
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
                  isSelected
                    ? // forced-colors flattens the fill, so the selected row keeps an
                      // outline there — the one treatment that survives.
                      "bg-overlay-selected forced-colors:outline forced-colors:outline-2 forced-colors:-outline-offset-2"
                    : "hover:bg-overlay-soft",
                  isOptionDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent"
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    isSelected ? "border-text-primary" : "border-border-strong"
                  )}
                >
                  {isSelected && <span className="h-2 w-2 rounded-full bg-text-primary" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    id={optionLabelId}
                    className={cn(
                      "block text-text-primary",
                      option.muted ? "font-normal" : "font-medium"
                    )}
                  >
                    {option.label}
                    {option.resolvedLabel && (
                      <>
                        {" "}
                        <span className="text-xs font-normal text-text-secondary">
                          {option.resolvedLabel}
                        </span>
                      </>
                    )}
                  </span>
                  {option.description && (
                    <span
                      id={optionDescriptionId}
                      className="mt-0.5 block text-xs text-text-secondary"
                    >
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {isError && (
          <p id={errorId} className={cn(frame, "pt-0 text-xs text-status-error")}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("group grid grid-cols-subgrid gap-2 col-span-full", className)} {...props}>
      {label && (
        <div className="flex items-center gap-2">
          <label id={labelId} htmlFor={id} className="text-sm text-text-secondary">
            {label}
          </label>
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
        </div>
      )}
      {!label && showReset && (
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            aria-label="Reset to default"
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
        </div>
      )}
      <div
        ref={containerRef}
        id={id}
        role="radiogroup"
        // The group's name belongs on the radiogroup itself, not the wrapper around it:
        // an unlabelled choicebox named by the caller's `aria-label` announced as an
        // anonymous radio group.
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={isError ? true : undefined}
        className={cn("flex gap-2", {
          "grid grid-cols-2": columns === 2,
          "grid grid-cols-3": columns === 3,
          "grid grid-cols-4": columns === 4,
        })}
      >
        {options.map((option, index) => {
          const isSelected = option.value === value;
          const isOptionDisabled = disabled || option.disabled;

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-disabled={isOptionDisabled}
              // One tab stop for the whole group: the selected option, or the first
              // enabled one when nothing selectable is selected.
              tabIndex={index === initiallyFocusableIndex ? 0 : -1}
              disabled={isOptionDisabled}
              data-value={option.value}
              onClick={() => {
                if (!isOptionDisabled) onChange(option.value);
              }}
              className={cn(
                CARD_BASE_CLASSES,
                isSelected ? CARD_SELECTED_CLASSES : CARD_UNSELECTED_CLASSES,
                isOptionDisabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <div className="flex items-start gap-2">
                <Check
                  className={cn("w-4 h-4 shrink-0 mt-0.5", !isSelected && "invisible")}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className={option.muted ? "font-normal" : "font-medium"}>
                    {option.label}
                    {option.resolvedLabel && (
                      <>
                        {" "}
                        <span className="text-xs font-normal text-text-secondary">
                          {option.resolvedLabel}
                        </span>
                      </>
                    )}
                  </div>
                  {option.description && (
                    <div className="text-xs text-text-secondary mt-0.5">{option.description}</div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {description && (
        <p id={descriptionId} className="text-xs text-text-secondary select-text">
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
