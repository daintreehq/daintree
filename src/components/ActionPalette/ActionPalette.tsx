import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
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
import { ActionPaletteItem } from "./ActionPaletteItem";
import {
  RECENTLY_USED_SECTION_ID,
  type ActionPaletteItem as ActionPaletteItemType,
  type UseActionPaletteReturn,
} from "@/hooks/useActionPalette";

const SECTION_HEADER_CLASS =
  "px-3 py-1 text-3xs font-medium tracking-wider uppercase text-text-secondary select-none";

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
      <span className="text-daintree-text/40">Type</span>
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
    (item: ActionPaletteItemType, index: number, canHide: boolean) => {
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
                  .map((item, idx) => renderActionRow(item, section.start + idx, canHide))}
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    [activeMode, query]
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

      // Mode-active footer: name what Enter does in the current scope so the
      // user can't accidentally fire the wrong primary action.
      if (activeMode === "commands") {
        body = (
          <PaletteFooterHints
            primaryHint={{ keys: ["↵"], label: "to run command" }}
            // Backspace keeps its chip: inside a mode it pops the scope rather
            // than deleting a character, which is the one thing here a user
            // can't infer from every other list they've used.
            hints={[{ keys: ["⌫"], label: "exit scope" }]}
          />
        );
      } else if (results.length === 0 && looksLikePath(query)) {
        // Default empty-mode hint: surface the projects prefix when the query
        // resembles a path or filename. Per-query-shape only — no auto-routing.
        body = <PaletteFooterHints primaryHint={{ keys: ["/"], label: "search projects" }} />;
      } else {
        // Default footer mirrors SearchablePalette's getActionLabel composition
        // so we keep that affordance while still owning the wrapper id used by
        // aria-describedby.
        const phrase = `to ${(selectedItem?.title ?? "Run action").trim().toLowerCase()}`;
        body = <PaletteFooterHints primaryHint={{ keys: ["↵"], label: phrase }} />;
      }

      return (
        <div id={footerHintId} className="@container/palette-footer w-full flex flex-col gap-1.5">
          {body}
          {showPrefixHints && <PrefixDiscoverabilityRow />}
        </div>
      );
    },
    [activeMode, query, results.length, footerHintId, showPrefixHints]
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
      totalResults={totalResults}
    />
  );
}
