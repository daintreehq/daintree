import { forwardRef, useEffect, useRef } from "react";
import type { CompletionKind } from "@shared/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  getUiPaletteTransitionDuration,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import {
  PALETTE_ROW_CLASS,
  PALETTE_ROW_FOCUS_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";

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

/** What Enter does on the selected item: complete it, or run it. */
export type AutocompleteEnterAction = "insert" | "execute";

/** Daintree resolvers that expand a token to content at send time. */
export type CompletionResolverId = "diff" | "terminal" | "selection";

/**
 * How the inserted token behaves at send time. `literal` passes through the PTY
 * verbatim (files, commands, `$` capabilities); a resolver token is expanded by
 * the matching send-time scanner in `useTokenResolution`. The field is
 * declarative — the scanners are authoritative, so a manually-typed `@diff`
 * still resolves.
 */
export type AutocompleteInsert =
  "literal" | { insert: "resolve"; resolverId: CompletionResolverId };

export interface AutocompleteItem {
  key: string;
  /** Display text shown in the menu. May differ from what gets inserted. */
  label: string;
  /** Canonical token inserted on selection (e.g. `/diff`, `$plugin-creator`). */
  insertText: string;
  description?: string;
  /**
   * `path` when the description is a directory. A path keeps its deepest
   * segments when it has to give way — the end of a path is what tells two
   * same-named files apart — where prose keeps its beginning.
   */
  descriptionKind?: "text" | "path";
  /** Semantic category; drives the neutral badge. Undefined for file/context items. */
  category?: CompletionKind;
  /** Enter behavior; defaults to `insert` when absent. */
  enterAction?: AutocompleteEnterAction;
  /** Send-time behavior; defaults to `literal` when absent. */
  insert?: AutocompleteInsert;
}

/** The DOM id of the option at `index`, for the editor's `aria-activedescendant`. */
export function autocompleteOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/**
 * What the composer's editor, as this menu's combobox, reports. Expanded
 * whenever the menu is on screen — including while it only says "Searching…"
 * or "No files match" — and pointing at no row while the selected one is stale,
 * since Enter will not act on it.
 */
export function getComboboxState({
  isOpen,
  items,
  selectedIndex,
  staleKeys,
  listboxId,
}: {
  isOpen: boolean;
  items: readonly AutocompleteItem[];
  selectedIndex: number;
  staleKeys: ReadonlySet<string>;
  listboxId: string;
}): { listboxId: string; expanded: boolean; activeOptionId: string | null } {
  const active = isOpen ? items[selectedIndex] : undefined;
  return {
    listboxId,
    expanded: isOpen,
    activeOptionId:
      active && !staleKeys.has(active.key) ? autocompleteOptionId(listboxId, selectedIndex) : null,
  };
}

interface KeyHint {
  key: string;
  label: string;
}

/**
 * What the keys will do to the selected row, derived here rather than handed
 * in as a string so the hint cannot promise an action the keymap won't take.
 * Nothing is offered while there is no row to act on, or while the selected
 * row is stale — `useEditorKeymap` refuses a stale row, so "insert" there would
 * be a false promise.
 */
function getKeyHints(item: AutocompleteItem | undefined, isStale: boolean): KeyHint[] {
  if (!item || isStale) return [];
  if (item.enterAction === "execute") {
    return [
      { key: "↵", label: "run" },
      { key: "⇥", label: "complete" },
    ];
  }
  return [{ key: "↵", label: "insert" }];
}

export interface AutocompleteMenuProps {
  isOpen: boolean;
  items: AutocompleteItem[];
  selectedIndex: number;
  isLoading?: boolean;
  /** Keys of items produced for an earlier query and pending a refresh; those
   *  rows render dimmed so they don't read as matches for the current text.
   *  Per-item so a stale async `@file` search can't dim fresh `$`/`@diff`. */
  staleKeys?: ReadonlySet<string>;
  onSelect: (item: AutocompleteItem) => void;
  style?: React.CSSProperties;
  /**
   * The listbox's DOM id. The composer's editor is the combobox and names this
   * list in `aria-controls`, and its options through `autocompleteOptionId`.
   */
  listboxId?: string;
  title?: string;
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
      staleKeys,
      onSelect,
      style,
      listboxId,
      title,
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

    // `shouldRender` is a dependency because presence mounts the menu a commit
    // after `isOpen` flips: without it the first pass finds no list, and a menu
    // that opens with its selection below the fold never scrolls to it.
    useEffect(() => {
      if (!isOpen || !shouldRender) return;
      const selected = listRef.current?.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView?.({ block: "nearest" });
    }, [isOpen, shouldRender, selectedIndex, items]);

    if (!shouldRender) return null;

    const hasStaleRows = staleKeys !== undefined && staleKeys.size > 0;
    const selectedItem = items[selectedIndex];
    const isSelectedStale = selectedItem ? (staleKeys?.has(selectedItem.key) ?? false) : false;
    const keyHints = getKeyHints(selectedItem, isSelectedStale);
    const hasRows = items.length > 0;
    // Spoken for every state, shown only when there are no rows to show instead:
    // with rows on screen the header carries "Updating…" visibly.
    const statusText = hasRows
      ? isLoading || hasStaleRows
        ? "Updating results…"
        : ""
      : isLoading
        ? "Searching…"
        : emptyMessage;

    return (
      <div
        ref={ref}
        data-autocomplete-menu=""
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
      >
        {title && (
          <div className="flex h-7 items-center justify-between gap-2 border-b border-tint/5 px-2">
            <span className={PALETTE_SECTION_LABEL_CLASS}>{title}</span>
            {keyHints.length > 0 ? (
              <span
                aria-hidden="true"
                className="flex shrink-0 items-center gap-2.5 text-3xs text-text-secondary"
              >
                {keyHints.map((hint) => (
                  <span key={hint.key} className="inline-flex items-center gap-1">
                    <kbd className={KBD_COMPACT_CLASS}>{hint.key}</kbd>
                    {hint.label}
                  </span>
                ))}
              </span>
            ) : (
              (hasStaleRows || (isLoading && hasRows)) && (
                <span aria-hidden="true" className="shrink-0 text-3xs text-text-secondary">
                  Updating…
                </span>
              )
            )}
          </div>
        )}
        {/* Compact fade, and scroll padding to match: a selection scrolled to the
            edge would otherwise land under the fade and read as disabled. */}
        <ScrollShadow compact className="max-h-64" scrollClassName="p-1 scroll-py-4">
          {/* Mounted for the menu's whole life, so a change of text is announced —
              a live region inserted already holding its message often is not. */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn(hasRows ? "sr-only" : "px-2 py-1.5 text-xs text-text-secondary")}
          >
            {statusText}
          </div>

          <div
            ref={listRef}
            id={listboxId}
            // A listbox for as long as the menu is open, rows or not: the editor
            // reports itself expanded whenever it is visible, and its
            // `aria-controls` has to name the same element throughout.
            role="listbox"
            aria-label={ariaLabel ?? title ?? "Autocomplete"}
            aria-busy={isLoading || hasStaleRows || undefined}
          >
            {items.map((item, idx) => {
              const badge = item.category ? CATEGORY_LABEL[item.category] : undefined;
              const isRowStale = staleKeys?.has(item.key) ?? false;
              // Enter won't act on a stale row, so it doesn't wear the selection.
              const isSelected = idx === selectedIndex && !isRowStale;
              const isPath = item.descriptionKind === "path";

              return (
                <button
                  key={item.key}
                  id={listboxId ? autocompleteOptionId(listboxId, idx) : undefined}
                  type="button"
                  role="option"
                  // Focus stays in the editor; the rows are reached through
                  // `aria-activedescendant`, never the Tab sequence.
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={isRowStale || undefined}
                  className={cn(
                    PALETTE_ROW_CLASS,
                    PALETTE_ROW_FOCUS_CLASS,
                    "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left",
                    "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary",
                    isRowStale && "opacity-50"
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (isRowStale) return;
                    onSelect(item);
                  }}
                >
                  {/* The token is what the row is; it gives way last. */}
                  <span className="max-w-[calc(100%-5rem)] shrink-0 truncate font-mono text-xs leading-4">
                    {item.label}
                  </span>
                  {badge && (
                    <>
                      <Badge aria-hidden="true" size="xs" tone="outline" className="leading-3">
                        {badge}
                      </Badge>
                      <span className="sr-only">Category: {badge}</span>
                    </>
                  )}
                  {item.description && (
                    <span
                      className={cn(
                        "min-w-0 truncate text-3xs leading-4",
                        isSelected ? "text-text-primary" : "text-text-secondary",
                        // Clip from the start so the deepest directories survive.
                        // The inner isolate keeps a path's slashes in LTR order.
                        isPath && "[direction:rtl] text-left"
                      )}
                    >
                      {isPath ? <bdi>{item.description}</bdi> : item.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollShadow>
      </div>
    );
  }
);

AutocompleteMenu.displayName = "AutocompleteMenu";
