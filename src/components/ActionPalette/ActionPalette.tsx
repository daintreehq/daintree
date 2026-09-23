import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import {
  KBD_CLASS,
  PaletteFooterHints,
  PaletteNoMatchHint,
  toHintPhrase,
} from "@/components/ui/AppPaletteDialog";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { parseChord } from "@/lib/kbdShortcut";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { ActionPaletteItem, HIDE_SHORTCUT, PIN_SHORTCUT } from "./ActionPaletteItem";
import {
  RECENTLY_USED_SECTION_ID,
  type ActionPaletteItem as ActionPaletteItemType,
  type UseActionPaletteReturn,
} from "@/hooks/useActionPalette";

// A band after the first opens with more air above it than below, so the
// label reads as the head of the rows under it rather than the tail of the
// rows above.
const SECTION_HEADER_CLASS = `${PALETTE_SECTION_LABEL_CLASS} px-3 py-1 not-first:mt-2`;

// Module-level so SearchablePalette receives a stable reference and skips
// re-renders driven only by a freshly-created callback identity.
const getActionItemId = (item: ActionPaletteItemType): string => item.id;

type ActionPaletteMode = "commands";

type PrefixRouteSpec = {
  label: string;
  // When `null`, the chip displays in-place (commands mode is already inside
  // the action palette). Otherwise the action palette atomically hands off
  // to the target palette via `paletteStore.openPalette`.
  paletteId: PaletteId | null;
  mode: ActionPaletteMode | null;
};

const PREFIX_MAP: Record<string, PrefixRouteSpec> = {
  ">": { label: "Commands", paletteId: null, mode: "commands" },
  "@": { label: "Worktrees", paletteId: "worktree", mode: null },
  "#": { label: "Panels", paletteId: "panel", mode: null },
  ":": { label: "Prompt history", paletteId: "prompt-history", mode: null },
  "/": { label: "Projects", paletteId: "project-switcher", mode: null },
};

const COMMANDS_LABEL = PREFIX_MAP[">"]!.label;

// Display tokens for the row-control chords, resolved once: the platform can't
// change under a running renderer.
const PIN_CHORD_KEYS = parseChord(PIN_SHORTCUT, isMac())[0] ?? [];
const HIDE_CHORD_KEYS = parseChord(HIDE_SHORTCUT, isMac())[0] ?? [];

/**
 * Which row command an Alt chord names, or null.
 *
 * The typed character wins when there is one. On Windows and Linux Alt does not
 * compose, so `key` is the letter the user's layout actually produces — reading
 * `code` first made a Dvorak user's P do nothing while the key printed L pinned.
 * macOS composes Option+letter into a symbol (⌥P arrives as "π"), so there `key`
 * is never a plain letter and `code`, the physical position, is all there is.
 */
function altCommandLetter(e: React.KeyboardEvent): "pin" | "hide" | null {
  const key = e.key ?? "";
  const typed = key.length === 1 && /[a-z]/i.test(key) ? key.toLowerCase() : null;
  const token = typed ?? (e.code ?? "").toLowerCase();
  if (token === "keyp" || token === "p") return "pin";
  if (token === "keyh" || token === "h") return "hide";
  return null;
}

// A query that contains `/`, `\`, or a leading `.` / `~` looks like a path or
// filename — surface the projects hint so users discover the prefix. Heuristic
// is intentionally narrow; broader patterns produce noisy suggestions.
function looksLikePath(query: string): boolean {
  if (!query) return false;
  return /[/\\]/.test(query) || /^[.~]/.test(query);
}

// Compact prefix table surfaced in the empty-query footer so users can discover
// the mode-routing characters without having to type one first. Drops out as
// soon as a query or mode is active so it never competes with the primary
// "↵ to {action}" hint.
//
// Teaching content rather than chrome, so it gets one showing and then retires
// (#11690) — see `hasSeenActionPalettePrefixHint`. The empty-query browse rail
// covers what actions exist; this covers the input grammar that hands search to
// another palette, which nothing else states.
function PrefixDiscoverabilityRow() {
  return (
    <div
      // Spacing does the separating, not interpuncts. The row wraps at the
      // palette's width, and a per-item separator ends a wrapped line with a
      // dangling dot pointing at nothing.
      className="@max-[420px]/palette-footer:hidden flex items-center gap-x-3 gap-y-1 flex-wrap text-2xs text-text-secondary"
      aria-label="Prefix shortcuts"
    >
      <span>Type</span>
      {Object.entries(PREFIX_MAP).map(([prefix, route]) => (
        <span key={prefix} className="inline-flex items-baseline">
          <kbd className={KBD_CLASS}>{prefix}</kbd>
          <span className="ml-1.5">{route.label.toLowerCase()}</span>
        </span>
      ))}
    </div>
  );
}

type ModeChipProps = {
  label: string;
  isVisible: boolean;
  id?: string;
};

function ModeChip({ label, isVisible, id }: ModeChipProps) {
  return (
    <span
      id={id}
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)]",
        "bg-overlay-subtle text-xs text-text-secondary select-none shrink-0 origin-left",
        "transition-[opacity,scale] motion-reduce:transition-opacity motion-reduce:scale-100",
        isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"
      )}
      style={{
        transitionDuration: isVisible
          ? `${UI_PALETTE_ENTER_DURATION}ms`
          : `${UI_PALETTE_EXIT_DURATION}ms`,
        transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
      }}
    >
      {label}
    </span>
  );
}

type ActionPaletteProps = Pick<
  UseActionPaletteReturn,
  | "isOpen"
  | "query"
  | "results"
  | "totalResults"
  | "selectedIndex"
  | "isStale"
  | "sections"
  | "close"
  | "setQuery"
  | "setSelectedIndex"
  | "selectPrevious"
  | "selectNext"
  | "executeAction"
  | "confirmSelection"
  | "pinAction"
  | "unpinAction"
  | "hideAction"
>;

export function ActionPalette({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  isStale,
  sections,
  close,
  setQuery,
  setSelectedIndex,
  selectPrevious,
  selectNext,
  executeAction,
  confirmSelection,
  pinAction,
  unpinAction,
  hideAction,
}: ActionPaletteProps) {
  const handleSelect = useCallback(
    (item: ActionPaletteItemType) => {
      executeAction(item);
    },
    [executeAction]
  );

  const actionPaletteShortcut = useEffectiveCombo("action.palette.open");
  const pinnedActionIds = useActionPrefsStore((state) => state.pinnedActionIds);
  const hasSeenPrefixHint = usePreferencesStore((state) => state.hasSeenActionPalettePrefixHint);
  const markPrefixHintSeen = usePreferencesStore((state) => state.markActionPalettePrefixHintSeen);
  // Stable id wraps the rendered footer hint and gets pointed at by every
  // option's aria-describedby — mirrors QuickSwitcher.tsx so screen readers
  // announce what Enter does for each row.
  const footerHintId = useId();

  // The sectioned empty-query body renders headers as siblings of the row list,
  // so the listbox children stay 1:1 with `results` for the parent's
  // scroll-into-view logic. The custom scroll effect below scrolls within the
  // sectioned listbox itself, keyed by `data-action-id` so the divider divs
  // don't throw off the offset.
  const sectionedListRef = useRef<HTMLDivElement>(null);
  // Driven by the descriptors rather than by `query`, because filtering lags
  // the input: the hook only publishes sections alongside the browse rows that
  // produced them, so this can't sectionize a set of search results (or strip
  // the headers off a browse list that is still on screen) mid-keystroke.
  const showSections = sections.length > 0;

  useEffect(() => {
    if (!showSections) return;
    const listEl = sectionedListRef.current;
    if (!listEl || selectedIndex < 0 || selectedIndex >= results.length) return;
    const selectedId = results[selectedIndex]?.id;
    if (!selectedId) return;
    const row = listEl.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(selectedId)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [showSections, selectedIndex, results]);

  const renderActionRow = useCallback(
    (item: ActionPaletteItemType, index: number, canHide: boolean, showCategory: boolean) => {
      const isPinned = pinnedActionIds.includes(item.id);
      return (
        <div key={item.id} data-action-id={item.id}>
          <ActionPaletteItem
            item={item}
            index={index}
            isSelected={index === selectedIndex}
            onSelect={handleSelect}
            onHoverIndex={setSelectedIndex}
            isPinned={isPinned}
            onPin={pinAction}
            onUnpin={unpinAction}
            onHide={canHide ? hideAction : undefined}
            footerHintId={footerHintId}
            posInSet={index + 1}
            setSize={results.length}
            showCategory={showCategory}
          />
        </div>
      );
    },
    [
      results.length,
      pinnedActionIds,
      selectedIndex,
      handleSelect,
      setSelectedIndex,
      pinAction,
      unpinAction,
      hideAction,
      footerHintId,
    ]
  );

  const renderSectionedBody = useCallback(() => {
    return (
      <>
        <div
          ref={sectionedListRef}
          id="action-palette-list"
          role="listbox"
          aria-label="Actions"
          className={isStale ? "palette-results-stale" : undefined}
          data-stale={isStale ? "true" : undefined}
          aria-busy={isStale || undefined}
        >
          {sections.map((section) => {
            const canHide = section.id === RECENTLY_USED_SECTION_ID;
            // A category band's header already names every row's category.
            const showCategory = !section.id.startsWith("category:");
            return (
              <Fragment key={section.id}>
                {/*
                  Listbox children must be role="option" or role="group" per ARIA.
                  role="group" inside role="listbox" is broken under Chromium 146 +
                  VoiceOver (label is dropped, "empty group" is announced), so the
                  separator masquerades as a non-interactive option instead — AT
                  announces the section name, arrow keys still skip it because it
                  isn't in `results`.
                */}
                <div
                  className={SECTION_HEADER_CLASS}
                  role="option"
                  aria-disabled="true"
                  aria-selected="false"
                  aria-label={section.label}
                >
                  {section.label}
                </div>
                {results
                  .slice(section.start, section.start + section.count)
                  // Rows are indexed against `results`, not the slice, so the
                  // highlight and hover handlers keep addressing the flat list
                  // the keyboard navigates.
                  .map((item, idx) =>
                    renderActionRow(item, section.start + idx, canHide, showCategory)
                  )}
              </Fragment>
            );
          })}
        </div>
      </>
    );
    // No overflow notice here: the browse rail is uncapped, so `shown` always
    // equals `total`. The search path keeps its notice via SearchablePalette.
  }, [results, sections, isStale, renderActionRow]);

  const [activeMode, setActiveMode] = useState<ActionPaletteMode | null>(null);
  // Hold the last rendered chip label across the exit animation so the chip
  // doesn't visibly blank out as `activeMode` clears.
  const [chipLabel, setChipLabel] = useState("");

  // Reset chip state when the palette closes so the next open never starts in
  // a stale mode. `useActionPalette.close()` only clears query/index — local
  // component state stays unless cleaned up here.
  useEffect(() => {
    if (!isOpen && activeMode !== null) {
      setActiveMode(null);
    }
  }, [isOpen, activeMode]);

  useEffect(() => {
    if (activeMode === "commands") setChipLabel(COMMANDS_LABEL);
  }, [activeMode]);

  // Drive chip mount/unmount with the palette enter/exit tier (150ms / 100ms)
  // so the chip doesn't pop in faster than the palette itself.
  const { isVisible: chipVisible, shouldRender: chipShouldRender } = useAnimatedPresence({
    isOpen: activeMode !== null,
    animationDuration: UI_PALETTE_EXIT_DURATION,
  });

  // Hide only evicts from the frecency band, so the command is offered exactly
  // where the control is: on any search row, or on a Recently used row of the
  // browse rail. Offering it elsewhere would promise an eviction that row can't
  // perform.
  const canHideIndex = useCallback(
    (index: number): boolean => {
      if (!showSections) return true;
      const band = sections.find((section) => section.id === RECENTLY_USED_SECTION_ID);
      return band !== undefined && index >= band.start && index < band.start + band.count;
    },
    [showSections, sections]
  );

  const activeItem = selectedIndex >= 0 ? results[selectedIndex] : undefined;
  // Settled results only: mid-filter the list can be momentarily empty for a
  // query that will match.
  const offersProjectSearch =
    activeMode === null && !isStale && results.length === 0 && looksLikePath(query);
  const activeIsPinned = activeItem !== undefined && pinnedActionIds.includes(activeItem.id);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // The row's pin and hide controls are presentational spans — ARIA forbids
      // interactive descendants of `role="option"` — so the only keyboard path
      // to them is here, against whichever row aria-activedescendant names.
      // DOM focus never leaves the input.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const command = altCommandLetter(e);
        if (command) {
          // Claimed whether or not it applies to this row: on macOS the
          // unhandled chord would otherwise compose a dead-key symbol into the
          // query.
          e.preventDefault();
          const item = selectedIndex >= 0 ? results[selectedIndex] : undefined;
          if (!item) return;
          const isPinned = pinnedActionIds.includes(item.id);
          const announce = useAnnouncerStore.getState().announce;
          if (command === "pin") {
            if (isPinned) {
              unpinAction(item.id);
              announce(`${item.title} unpinned from Favorites`);
            } else if (pinAction(item)) {
              announce(`${item.title} pinned to Favorites`);
            } else {
              announce("Can't pin destructive actions", "assertive");
            }
            return;
          }
          if (isPinned || item.danger === "confirm" || !canHideIndex(selectedIndex)) return;
          hideAction(item);
          announce(`${item.title} hidden from Recently used`);
          return;
        }
      }

      if (e.key === "Enter" && offersProjectSearch) {
        e.preventDefault();
        usePaletteStore.getState().openPalette("project-switcher");
        return;
      }

      // Backspace at position 0 (no selection) pops the active chip and
      // restores global action search. Mirrors the asymmetric Escape stack:
      // first Backspace clears the mode, subsequent Backspace acts normally.
      if (e.key === "Backspace" && activeMode !== null) {
        const input = e.currentTarget;
        if (input.selectionStart === 0 && input.selectionEnd === 0) {
          e.preventDefault();
          setActiveMode(null);
          return;
        }
      }

      // Mode-prefix routing only fires on an empty query with no modifier so
      // typing `>` mid-search or with Cmd/Ctrl held doesn't hijack the input.
      // Skip when a mode is already active — re-prefixing inside a mode is a
      // literal char.
      if (activeMode !== null) return;
      if (query !== "") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;

      const route = PREFIX_MAP[e.key];
      if (!route) return;

      e.preventDefault();
      if (route.paletteId === null) {
        if (route.mode) setActiveMode(route.mode);
        return;
      }
      // Atomic hand-off — `openPalette` replaces `activePaletteId` directly, so
      // this palette's `isOpen` goes false as the target mounts. No `close()`
      // call needed; an explicit close would briefly null the mutex and
      // teardown focus restoration via the palette-to-palette guard. The
      // component itself stays mounted (`useKeepMounted`) and only its dialog
      // exits, which is what lets the prefix-hint close effect still run.
      usePaletteStore.getState().openPalette(route.paletteId);
    },
    [
      activeMode,
      query,
      results,
      selectedIndex,
      pinnedActionIds,
      pinAction,
      unpinAction,
      hideAction,
      canHideIndex,
      offersProjectSearch,
    ]
  );

  // Mirror showSections (`!query.trim()`) so a whitespace-only buffer collapses
  // to the same default state instead of diverging between the sectioned MRU
  // body and the prefix-hint footer. The seen flag is an extra clause, not a
  // replacement: within its one showing the row still comes and goes with the
  // query, so typing and clearing brings it back.
  const showPrefixHints = !hasSeenPrefixHint && activeMode === null && !query.trim();

  // Consumed by an opening that actually showed the row, and only once it
  // closes. Marking on open would clear the flag under the user mid-read, since
  // this component subscribes to it; observing `isOpen` rather than wrapping
  // `close()` catches every exit, including the prefix hand-off that swaps
  // palettes through `paletteStore` without calling it.
  // `isOpen` gates the exposure too, not just the spend. The component stays
  // mounted between openings (`useKeepMounted`) and `close()` resets the query,
  // so a closed palette otherwise satisfies the predicate and would bank an
  // exposure the user never saw.
  const prefixHintShownRef = useRef(false);
  useEffect(() => {
    if (isOpen && showPrefixHints) prefixHintShownRef.current = true;
  }, [isOpen, showPrefixHints]);
  useEffect(() => {
    if (isOpen || !prefixHintShownRef.current) return;
    prefixHintShownRef.current = false;
    markPrefixHintSeen();
  }, [isOpen, markPrefixHintSeen]);

  const getFooter = useCallback(
    (selectedItem: ActionPaletteItemType | null): React.ReactNode => {
      let body: React.ReactNode;

      // The row controls have no other discoverable surface — they're
      // presentational spans with a mouse tooltip — so the chord that reaches
      // them rides the footer, and only while the row actually offers it.
      const rowHints: { keys: string[]; label: string }[] = [];
      if (activeItem && activeItem.danger !== "confirm") {
        rowHints.push({ keys: PIN_CHORD_KEYS, label: activeIsPinned ? "unpin" : "pin" });
        if (!activeIsPinned && canHideIndex(selectedIndex)) {
          rowHints.push({ keys: HIDE_CHORD_KEYS, label: "hide" });
        }
      }

      // What Enter does, named for the row it will act on — or nothing, on a
      // row it won't run. A disabled action is a silent no-op on Enter (#8814),
      // so offering "↵ to …" there promised a result that never comes; the row's
      // own reason line says why, and its pin/hide chords still work.
      const enterHint =
        selectedItem && selectedItem.enabled
          ? { keys: ["↵"], label: `to ${toHintPhrase(selectedItem.title)}` }
          : null;

      if (activeMode === "commands") {
        // Backspace keeps its chip: inside a mode it pops the scope rather than
        // deleting a character, which is the one thing here a user can't infer
        // from every other list they've used.
        const exitScope = { keys: ["⌫"], label: "exit scope" };
        body = enterHint ? (
          <PaletteFooterHints primaryHint={enterHint} hints={[exitScope, ...rowHints]} />
        ) : (
          <PaletteFooterHints primaryHint={exitScope} hints={rowHints} />
        );
      } else if (offersProjectSearch) {
        // The query looks like a path or filename and matched no action, so
        // Enter hands it to the project switcher (see `handleKeyDown`). This
        // used to show a `/` chip, but the prefix only routes from an empty
        // field, so pressing it here typed a slash.
        body = <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to search projects" }} />;
      } else if (enterHint) {
        // Mirrors SearchablePalette's getActionLabel composition so we keep
        // that affordance while still owning the wrapper id used by
        // aria-describedby.
        body = <PaletteFooterHints primaryHint={enterHint} hints={rowHints} />;
      } else if (rowHints.length > 0) {
        body = <PaletteFooterHints primaryHint={rowHints[0]!} hints={rowHints.slice(1)} />;
      }

      // Nothing selected and nothing to teach: no band. A "↵ to run action"
      // over an empty list promised an Enter that does nothing.
      if (!body && !showPrefixHints) return undefined;

      return (
        <div id={footerHintId} className="@container/palette-footer w-full flex flex-col gap-1.5">
          {body}
          {showPrefixHints && <PrefixDiscoverabilityRow />}
        </div>
      );
    },
    [
      activeMode,
      offersProjectSearch,
      footerHintId,
      showPrefixHints,
      activeItem,
      activeIsPinned,
      canHideIndex,
      selectedIndex,
    ]
  );

  const chipNode = chipShouldRender ? <ModeChip label={chipLabel} isVisible={chipVisible} /> : null;

  return (
    <SearchablePalette<ActionPaletteItemType>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      onHoverIndex={setSelectedIndex}
      onKeyDown={handleKeyDown}
      inputPrefix={chipNode}
      getFooter={getFooter}
      getItemId={getActionItemId}
      isFiltering={isStale}
      renderItem={(item, index, isSelected, onHoverIndex) => {
        const isPinned = pinnedActionIds.includes(item.id);
        return (
          <ActionPaletteItem
            key={item.id}
            item={item}
            index={index}
            isSelected={isSelected}
            onSelect={handleSelect}
            onHoverIndex={onHoverIndex}
            isPinned={isPinned}
            onPin={pinAction}
            onUnpin={unpinAction}
            onHide={hideAction}
            footerHintId={footerHintId}
            // Redundant on this path — the search body has no headers to throw
            // the count off — but stated anyway so a row announces the same way
            // whichever body rendered it.
            posInSet={index + 1}
            setSize={results.length}
            highlightQuery={query}
          />
        );
      }}
      renderBody={showSections ? renderSectionedBody : undefined}
      label="Actions"
      shortcut={actionPaletteShortcut}
      ariaLabel="Command palette"
      searchPlaceholder="Find an action"
      searchAriaLabel="Search actions"
      listId="action-palette-list"
      itemIdPrefix="action-option"
      emptyMessage="No actions yet"
      noMatchContent={offersProjectSearch ? undefined : <PaletteNoMatchHint what="all actions" />}
      totalResults={totalResults}
    />
  );
}
