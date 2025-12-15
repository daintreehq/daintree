import { forwardRef } from "react";
import { cn } from "@/lib/utils";

function getDescriptionSnippet(description: string, maxLength = 60): string {
  const cleaned = description.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export interface AutocompleteItem {
  key: string;
  label: string;
  value: string;
  description?: string;
}

export interface AutocompleteMenuProps {
  isOpen: boolean;
  items: AutocompleteItem[];
  selectedIndex: number;
  isLoading?: boolean;
  onSelect: (item: AutocompleteItem) => void;
  style?: React.CSSProperties;
  title?: string;
  ariaLabel?: string;
}

export const AutocompleteMenu = forwardRef<HTMLDivElement, AutocompleteMenuProps>(
  ({ isOpen, items, selectedIndex, isLoading = false, onSelect, style, title, ariaLabel }, ref) => {
    if (!isOpen) return null;
    if (!isLoading && items.length === 0) return null;

    return (
      <div
        ref={ref}
        className={cn(
          "absolute bottom-full mb-0 w-[420px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-white/10 bg-[var(--color-surface)] shadow-2xl",
          "z-50"
        )}
        style={style}
        role="listbox"
        aria-label={ariaLabel ?? title ?? "Autocomplete"}
      >
        {title && (
          <div className="border-b border-white/5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-canopy-text/40">
            {title}
          </div>
        )}
        <div className="max-h-64 overflow-y-auto p-1">
          {isLoading && items.length === 0 && (
            <div className="px-2 py-2 text-xs font-mono text-canopy-text/40">Searching…</div>
          )}

          {items.map((item, idx) => {
            const descriptionSnippet = item.description
              ? getDescriptionSnippet(item.description)
              : undefined;

            return (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                  idx === selectedIndex
                    ? "bg-canopy-accent/20 text-canopy-text"
                    : "text-canopy-text/70 hover:bg-white/[0.05] hover:text-canopy-text"
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(item)}
                title={item.description ? `${item.label} — ${item.description}` : item.label}
              >
                <span className="shrink-0 font-mono text-xs leading-4">{item.label}</span>
                {descriptionSnippet && (
                  <span
                    className={cn(
                      "min-w-0 truncate text-[10px] leading-4",
                      idx === selectedIndex ? "text-canopy-text/80" : "text-canopy-text/30"
                    )}
                  >
                    {descriptionSnippet}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
);

AutocompleteMenu.displayName = "AutocompleteMenu";
