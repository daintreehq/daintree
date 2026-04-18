import { useId, useState, useRef, useEffect } from "react";
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChoiceboxOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SettingsChoiceboxProps<T extends string = string> extends Omit<
  ComponentPropsWithoutRef<"div">,
  "onChange"
> {
  label?: string;
  description?: ReactNode;
  error?: string;
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
  "flex-1 px-3 py-2 rounded-[var(--radius-md)] border text-sm text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";

const CARD_SELECTED_CLASSES = "border-daintree-accent bg-daintree-accent/10 text-daintree-text";

const CARD_UNSELECTED_CLASSES =
  "border-daintree-border bg-daintree-bg text-text-secondary hover:border-daintree-text/30 hover:text-daintree-text disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-daintree-border disabled:hover:text-text-secondary";

export function SettingsChoicebox<T extends string = string>({
  label,
  description,
  error,
  isModified,
  onReset,
  resetAriaLabel,
  value,
  onChange,
  options,
  columns = 1,
  disabled,
  className,
  ...props
}: SettingsChoiceboxProps<T>) {
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const showReset = isModified && onReset && !disabled;

  const describedBy =
    [description && !error ? descriptionId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
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

      if (nextIndex !== currentIndex && nextIndex >= 0 && nextIndex < buttons.length) {
        buttons[nextIndex]?.focus();
        setFocusedIndex(nextIndex);
      }
    };

    container.addEventListener("keydown", handleKeyDown as unknown as EventListener);
    return () =>
      container.removeEventListener("keydown", handleKeyDown as unknown as EventListener);
  }, [onChange, options]);

  return (
    <div className={cn("group flex flex-col gap-2", className)} {...props}>
      {label && (
        <div className="flex items-center gap-2">
          <label id={labelId} htmlFor={id} className="text-sm text-daintree-text/70">
            {label}
          </label>
          {isModified && (
            <span className="w-1.5 h-1.5 rounded-full bg-daintree-accent" aria-hidden="true" />
          )}
          {showReset && (
            <button
              type="button"
              aria-label={resetAriaLabel ?? `Reset ${label} to default`}
              className={cn(
                "p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-accent",
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
      )}
      {!label && showReset && (
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            aria-label="Reset to default"
            className={cn(
              "p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-accent",
              "invisible group-hover:visible group-focus-within:visible focus-visible:visible",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
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
        aria-labelledby={label && labelId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
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
              tabIndex={
                isSelected
                  ? 0
                  : focusedIndex === index
                    ? 0
                    : focusedIndex === -1 && index === initiallyFocusableIndex
                      ? 0
                      : -1
              }
              disabled={isOptionDisabled}
              data-value={option.value}
              onClick={() => {
                if (!isOptionDisabled) onChange(option.value);
              }}
              onFocus={() => setFocusedIndex(index)}
              onBlur={() => setFocusedIndex(-1)}
              className={cn(
                CARD_BASE_CLASSES,
                isSelected ? CARD_SELECTED_CLASSES : CARD_UNSELECTED_CLASSES,
                isOptionDisabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <div className="font-medium">{option.label}</div>
              {option.description && (
                <div className="text-xs text-daintree-text/50 mt-0.5">{option.description}</div>
              )}
            </button>
          );
        })}
      </div>
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
