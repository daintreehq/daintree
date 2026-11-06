import { Fragment, forwardRef, useEffect, useRef } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import type { CompletionKind } from "@shared/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
import { PathTail } from "@/components/ui/PathTail";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
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

/** Daintree resolvers that expand a token to content at send time; `context` is a plugin's provider. */
export type CompletionResolverId = "diff" | "terminal" | "selection" | "context";

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
  /** Badge text in place of the category's, for rows from outside the composer (plugin menus). */
  badge?: string;
  /** Shown but never selected or inserted, like a stale row, without the "Updating" state. */
  disabled?: boolean;
  /** The band the row is listed under; its label is drawn where the band begins. */
  group?: string;
  /**
   * A plugin's prompt template, by its runtime key. Picking the row by any
   * means (Enter, Tab, click) opens the template's form, or fills the draft
   * when it asks for nothing, and never inserts `insertText`.
   */
  template?: { key: string; opensForm: boolean };
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

interface HintKey {
  key: string;
  /** Spoken name of the key; the glyph reads badly aloud. */
  keyName: string;
}

interface KeyHint {
  /** Keys that do the same thing share one label. */
  keys: HintKey[];
  label: string;
}

const ENTER: HintKey = { key: "↵", keyName: "Enter" };
const TAB: HintKey = { key: "⇥", keyName: "Tab" };

/**
 * What the keys will do to the selected row, derived here rather than handed
 * in as a string so the hint cannot promise an action the keymap won't take.
 * Nothing is offered while there is no row to act on, or while the selected
 * row is stale — `useEditorKeymap` refuses a stale row, so "insert" there would
 * be a false promise.
 */
function getKeyHints(item: AutocompleteItem | undefined, isStale: boolean): KeyHint[] {
  if (!item || isStale) return [];
  if (item.template) return [{ keys: [ENTER, TAB], label: pickLabel(item) }];
  if (item.enterAction === "execute") {
    return [
      { keys: [ENTER], label: "run" },
      { keys: [TAB], label: "complete" },
    ];
  }
  // Tab completes an insert row exactly as Enter does (`useEditorKeymap`).
  return [{ keys: [ENTER, TAB], label: "insert" }];
}

/** What Tab does to a row: insert it, or for a template, what the template does. */
function pickLabel(item: AutocompleteItem): string {
  if (!item.template) return "insert";
  return item.template.opensForm ? "open form" : "fill draft";
}

/** With no row selected, Tab still takes the first one; Enter does not. */
function tabFirstHint(first: AutocompleteItem): KeyHint {
  return { keys: [TAB], label: `${pickLabel(first)} first` };
}

/**
 * A band's label. Listbox children must be options, and `role="group"` loses
 * its label under Chromium + VoiceOver, so it stands as an inert option, kept
 * out of `items` so the arrow keys and option ids never count it — the shape
 * the palettes use.
 */
function BandLabel({ label, first }: { label: string; first: boolean }) {
  return (
    <div
      role="option"
      aria-disabled="true"
      aria-selected="false"
      aria-label={label}
      data-autocomplete-band=""
      className={cn(PALETTE_SECTION_LABEL_CLASS, "flex h-6 items-center px-2", !first && "mt-1")}
    >
      {label}
    </div>
  );
}

function spokenHint(hint: KeyHint): string {
  return `${hint.keys.map((k) => k.keyName).join(" or ")} to ${hint.label}`;
}

/**
 * Bring a row into view by scrolling only the menu's own list. `scrollIntoView`
 * scrolls every scrollable ancestor too, and a grid pane is one
 * (`overflow-hidden`): a menu wider than the pane slid the whole pane sideways.
 * Honours the list's scroll padding, which keeps the row clear of the fades.
 */
function revealInList(row: Element, scroller: HTMLElement): void {
  const style = getComputedStyle(scroller);
  const padTop = parseFloat(style.scrollPaddingTop) || 0;
  const padBottom = parseFloat(style.scrollPaddingBottom) || 0;
  const rowBox = row.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rowBox.top < box.top + padTop) {
    scroller.scrollTop -= box.top + padTop - rowBox.top;
  } else if (rowBox.bottom > box.bottom - padBottom) {
    scroller.scrollTop += rowBox.bottom - (box.bottom - padBottom);
  }
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
  /**
   * Moves the cursor to a row the pointer is over, so the pointer and the arrow
   * keys drive one highlight and Enter acts on the row that looks lit. Fired on
   * `pointermove`, never `pointerenter`, so rows scrolling under a resting
   * pointer cannot steal the cursor from the keys.
   */
  onHoverIndex?: (index: number) => void;
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
      onHoverIndex,
      style,
      listboxId,
      title,
      ariaLabel,
      emptyMessage,
    },
    ref
  ) => {
    const listRef = useRef<HTMLDivElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    // Palette-tier presence (150ms enter / 100ms exit) so the menu rises in
    // and fades out like its sibling overlays instead of popping on every
    // `/` or `@` keystroke.
    const skipMotion = useShouldSkipMotion();
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
      // A row under the pointer was just claimed by it; revealing it would
      // scroll a half-visible row out from under the pointer.
      if (isPointerClaimed(selected)) return;
      const scroller = scrollerRef.current;
      if (selected && scroller) revealInList(selected, scroller);
    }, [isOpen, shouldRender, selectedIndex, items]);

    // A caller that fits the menu to its space (the composer, to its pane) can
    // shrink the list while it is open; keep the selected row in sight.
    useEffect(() => {
      const scroller = scrollerRef.current;
      if (!isOpen || !shouldRender || !scroller || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        const selected = listRef.current?.querySelector('[aria-selected="true"]');
        if (selected && !isPointerClaimed(selected)) revealInList(selected, scroller);
      });
      observer.observe(scroller);
      return () => observer.disconnect();
    }, [isOpen, shouldRender]);

    if (!shouldRender) return null;

    const hasStaleRows = staleKeys !== undefined && staleKeys.size > 0;
    const selectedItem = items[selectedIndex];
    const isSelectedStale = selectedItem
      ? (staleKeys?.has(selectedItem.key) ?? false) || selectedItem.disabled === true
      : false;
    const firstItem = items[0];
    const tabTakesFirst =
      selectedItem === undefined &&
      firstItem !== undefined &&
      !(staleKeys?.has(firstItem.key) ?? false) &&
      firstItem.disabled !== true;
    const keyHints =
      tabTakesFirst && firstItem
        ? [tabFirstHint(firstItem)]
        : getKeyHints(selectedItem, isSelectedStale);
    const hasRows = items.length > 0;
    // Spoken for every state, shown only when there are no rows to show instead:
    // with rows on screen the header carries "Updating…" visibly. No row is
    // selected to carry the Tab instruction, so this says it.
    const statusText = hasRows
      ? isLoading || hasStaleRows
        ? "Updating results…"
        : tabTakesFirst
          ? `Tab to ${firstItem?.template ? "pick" : "insert"} the first match`
          : ""
      : isLoading
        ? "Searching…"
        : emptyMessage;

    return (
      <div
        ref={ref}
        data-autocomplete-menu=""
        className={cn(
          // A column, so a height the caller caps (`maxHeight`) is taken from
          // the list, which scrolls, never from the header.
          "absolute bottom-full mb-0 flex w-[420px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay",
          "z-50 origin-bottom",
          // Reduced motion keeps the fade and drops the rise. The hook, not a
          // `motion-reduce:` class: it also answers the app's own "Reduce UI
          // animations" setting and performance mode, which the class can't.
          skipMotion ? "transition-opacity" : "transition-[opacity,translate,scale]",
          isVisible
            ? "opacity-100 translate-y-0 scale-100"
            : cn("opacity-0", !skipMotion && "translate-y-0.5 scale-[0.99]")
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
          <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-tint/5 px-2">
            <span className={cn(PALETTE_SECTION_LABEL_CLASS, "min-w-0 truncate")}>{title}</span>
            {keyHints.length > 0 ? (
              <span
                aria-hidden="true"
                className="flex shrink-0 items-center gap-2.5 text-3xs text-text-secondary"
              >
                {keyHints.map((hint) => (
                  <span key={hint.label} className="inline-flex items-center gap-1">
                    {hint.keys.map((k) => (
                      <kbd key={k.key} className={KBD_COMPACT_CLASS}>
                        {k.key}
                      </kbd>
                    ))}
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
        <ScrollShadow
          ref={scrollerRef}
          compact
          className="max-h-64"
          scrollClassName="p-1 scroll-py-4"
        >
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
              const badge =
                item.badge ?? (item.category ? CATEGORY_LABEL[item.category] : undefined);
              const isRowStale = (staleKeys?.has(item.key) ?? false) || item.disabled === true;
              // Enter won't act on a stale row, so it doesn't wear the selection.
              const isSelected = idx === selectedIndex && !isRowStale;
              const isPath = item.descriptionKind === "path";
              // The description stays a step under the token on the lit row
              // too: the row's highlight lifts the token, and lifting both
              // made the two one undifferentiated line.
              const descriptionClass = "min-w-0 text-3xs leading-4 text-text-secondary";
              const band =
                item.group !== undefined && item.group !== items[idx - 1]?.group
                  ? item.group
                  : undefined;

              return (
                <Fragment key={item.key}>
                  {band && <BandLabel label={band} first={idx === 0} />}
                  <button
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
                      "text-text-secondary",
                      isRowStale && "opacity-50"
                    )}
                    // An inert row doesn't answer the pointer either.
                    onPointerMove={
                      isRowStale || !onHoverIndex || isSelected
                        ? undefined
                        : () => onHoverIndex(idx)
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (isRowStale) return;
                      onSelect(item);
                    }}
                  >
                    {/* The token is what the row is; it gives way last. A
                      template's title is a name, not something typed. */}
                    <span
                      className={cn(
                        "max-w-[calc(100%-5rem)] shrink-0 truncate text-xs leading-4",
                        !item.template && "font-mono"
                      )}
                    >
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
                    {item.description &&
                      (isPath ? (
                        <PathTail className={descriptionClass}>{item.description}</PathTail>
                      ) : (
                        <span className={cn(descriptionClass, "truncate")}>{item.description}</span>
                      ))}
                    {/* The header's hint band is hidden from assistive tech, so the
                      row Enter acts on carries the same instruction in words. */}
                    {isSelected && keyHints.length > 0 && (
                      <span className="sr-only">{`, ${keyHints.map(spokenHint).join(", ")}`}</span>
                    )}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </ScrollShadow>
      </div>
    );
  }
);

AutocompleteMenu.displayName = "AutocompleteMenu";
