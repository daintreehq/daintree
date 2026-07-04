import { forwardRef, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
  /** Results were produced for an earlier query and a refresh is pending;
   *  rows render dimmed so they don't read as matches for the current text. */
  isStale?: boolean;
  onSelect: (item: AutocompleteItem) => void;
  style?: React.CSSProperties;
  title?: string;
  /** Compact keyboard hint rendered opposite the title, e.g. "↵ run · ⇥ complete". */
  keyHint?: string;
  ariaLabel?: string;
  emptyMessage: string;
}

export const AutocompleteMenu = forwardRef<HTMLDivElement, AutocompleteMenuProps>(
  (
    {
      isOpen,
      items,
      selectedIndex,
      isLoading = false,
      isStale = false,
      onSelect,
      style,
      title,
      keyHint,
      ariaLabel,
      emptyMessage,
    },
    ref
  ) => {
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!isOpen) return;
      const selected = listRef.current?.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView?.({ block: "nearest" });
    }, [isOpen, selectedIndex, items]);

    if (!isOpen) return null;

    const isEmpty = !isLoading && items.length === 0;

    return (
      <div
        ref={ref}
        className={cn(
          "absolute bottom-full mb-0 w-[420px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-tint/10 bg-surface shadow-[var(--theme-shadow-floating)]",
          "z-50"
        )}
        style={style}
        role={isEmpty ? undefined : "listbox"}
        aria-label={ariaLabel ?? title ?? "Autocomplete"}
        aria-busy={isLoading || isStale || undefined}
      >
        {(title || keyHint) && (
          <div className="flex items-center justify-between gap-2 border-b border-tint/5 px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-daintree-text/40">
              {title}
            </span>
            {keyHint && (
              <span aria-hidden="true" className="shrink-0 text-[10px] text-daintree-text/30">
                {keyHint}
              </span>
            )}
          </div>
        )}
        <ScrollShadow className="max-h-64" scrollClassName="p-1">
          {isLoading && items.length === 0 && (
            <div className="px-2 py-2 text-xs font-mono text-daintree-text/40">Searching…</div>
          )}

          {isEmpty && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="px-2 py-2 text-xs font-mono text-daintree-text/40"
            >
              {emptyMessage}
            </div>
          )}

          <div
            ref={listRef}
            className={cn(
              "transition-opacity duration-150 ease-out",
              isStale && items.length > 0 && "opacity-50"
            )}
          >
            {items.map((item, idx) => {
              const descriptionSnippet = item.description
                ? getDescriptionSnippet(item.description)
                : undefined;

              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="option"
                      aria-selected={idx === selectedIndex}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                        idx === selectedIndex
                          ? "bg-overlay-soft text-daintree-text"
                          : "text-daintree-text/70 hover:bg-tint/[0.05] hover:text-daintree-text"
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelect(item)}
                    >
                      <span className="min-w-0 flex-none max-w-full truncate font-mono text-xs leading-4">
                        {item.label}
                      </span>
                      {descriptionSnippet && (
                        <span
                          className={cn(
                            "min-w-0 truncate text-[10px] leading-4",
                            idx === selectedIndex
                              ? "text-daintree-text/80"
                              : "text-daintree-text/30"
                          )}
                        >
                          {descriptionSnippet}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {item.description ? `${item.label} — ${item.description}` : item.label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </ScrollShadow>
      </div>
    );
  }
);

AutocompleteMenu.displayName = "AutocompleteMenu";
