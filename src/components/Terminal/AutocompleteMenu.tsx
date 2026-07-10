import { forwardRef, useEffect, useRef } from "react";
import type { CompletionKind } from "@shared/types";
import { cn } from "@/lib/utils";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  getUiPaletteTransitionDuration,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";

function getDescriptionSnippet(description: string, maxLength = 60): string {
  const cleaned = description.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Visible badge text per category. `command` is intentionally absent — plain
 * commands render without a badge (a `[Command]` on every slash token is noise),
 * so only the notable kinds (skills, apps, plugins) are called out.
 */
const CATEGORY_LABEL: Partial<Record<CompletionKind, string>> = {
  skill: "Skill",
  app: "App",
  plugin: "Plugin",
};

export interface AutocompleteItem {
  key: string;
  /** Display text shown in the menu. May differ from what gets inserted. */
  label: string;
  /** Canonical token inserted on selection (e.g. `/diff`, `$plugin-creator`). */
  insertText: string;
  description?: string;
  /** Semantic category; drives the neutral badge. Undefined for file/context items. */
  category?: CompletionKind;
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
    // Palette-tier presence (150ms enter / 100ms exit) so the menu rises in
    // and fades out like its sibling overlays instead of popping on every
    // `/` or `@` keystroke.
    const { isVisible, shouldRender } = useAnimatedPresence({
      isOpen,
      animationDuration: getUiPaletteTransitionDuration("exit"),
    });

    useEffect(() => {
      if (!isOpen) return;
      const selected = listRef.current?.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView?.({ block: "nearest" });
    }, [isOpen, selectedIndex, items]);

    if (!shouldRender) return null;

    const isEmpty = !isLoading && items.length === 0;

    return (
      <div
        ref={ref}
        className={cn(
          "absolute bottom-full mb-0 w-[420px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-tint/10 bg-surface shadow-[var(--theme-shadow-floating)]",
          "z-50 origin-bottom",
          "transition-[opacity,translate,scale]",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:translate-none motion-reduce:scale-none",
          isVisible
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 translate-y-0.5 scale-[0.99]"
        )}
        style={{
          ...style,
          transitionDuration: isVisible
            ? `${UI_PALETTE_ENTER_DURATION}ms`
            : `${UI_PALETTE_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
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
              const badge = item.category ? CATEGORY_LABEL[item.category] : undefined;
              const tooltipText = [
                item.label,
                badge ? `(${badge})` : "",
                item.description ? `— ${item.description}` : "",
              ]
                .filter(Boolean)
                .join(" ");

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
                      {badge && (
                        <>
                          <span
                            aria-hidden="true"
                            className="shrink-0 rounded-sm border border-tint/10 bg-overlay-subtle px-1 text-[9px] font-medium uppercase leading-4 tracking-wide text-daintree-text/50"
                          >
                            {badge}
                          </span>
                          <span className="sr-only">Category: {badge}</span>
                        </>
                      )}
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
                  <TooltipContent side="bottom">{tooltipText}</TooltipContent>
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
