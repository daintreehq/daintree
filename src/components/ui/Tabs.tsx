import { useRef, useCallback, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface TabOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: TabOption[];
  className?: string;
  fullWidth?: boolean;
  ariaLabel?: string;
  idPrefix?: string;
}

export function Tabs({
  value,
  onChange,
  options,
  className,
  fullWidth = false,
  ariaLabel = "Tab navigation",
  idPrefix,
}: TabsProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTab = useCallback(
    (index: number) => {
      const clampedIndex = Math.max(0, Math.min(index, options.length - 1));
      tabRefs.current[clampedIndex]?.focus();
    },
    [options.length]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      let handled = true;
      let newIndex = currentIndex;

      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          newIndex = currentIndex === 0 ? options.length - 1 : currentIndex - 1;
          break;
        case "ArrowRight":
        case "ArrowDown":
          newIndex = currentIndex === options.length - 1 ? 0 : currentIndex + 1;
          break;
        case "Home":
          newIndex = 0;
          break;
        case "End":
          newIndex = options.length - 1;
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        // Only call onChange if the value actually changes
        const newValue = options[newIndex].value;
        if (newValue !== value) {
          onChange(newValue);
        }
        focusTab(newIndex);
      }
    },
    [focusTab, options, onChange, value]
  );

  if (options.length === 0) {
    return null;
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={cn("flex border-b border-canopy-border", className)}
    >
      {options.map((option, index) => {
        const isActive = value !== null && value === option.value;
        const tabId = idPrefix ? `${idPrefix}-tab-${option.value}` : undefined;
        const panelId = idPrefix ? `${idPrefix}-panel-${option.value}` : undefined;

        return (
          <button
            key={option.value}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId}
            aria-selected={isActive}
            aria-controls={panelId}
            tabIndex={isActive ? 0 : value === null && index === 0 ? 0 : -1}
            onClick={() => {
              if (value === option.value) {
                onChange(null);
              } else {
                onChange(option.value);
              }
            }}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-inset",
              fullWidth && "flex-1",
              isActive
                ? "text-canopy-accent border-b-2 border-canopy-accent -mb-px"
                : "text-canopy-text/60 hover:text-canopy-text"
            )}
          >
            {option.icon && <span className="mr-2">{option.icon}</span>}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
