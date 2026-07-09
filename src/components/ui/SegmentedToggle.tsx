import { cn } from "@/lib/utils";

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Screen-reader name when the visible label is an abbreviation (S/M/L). */
  ariaLabel?: string;
}

/**
 * Compact two-to-three-way mode switch used in viewer chrome (file viewer's
 * View/Diff and Split/Unified, markdown Rendered/Source). Extracted from
 * FileViewerModal so panel and dialog surfaces share one control.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex bg-daintree-sidebar rounded p-0.5 shrink-0">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          aria-pressed={value === option.value}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded transition-colors",
            value === option.value
              ? "bg-daintree-border text-daintree-text"
              : "text-muted-foreground hover:text-daintree-text disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
