import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { ActionPaletteItem } from "./ActionPaletteItem";
import type {
  ActionPaletteItem as ActionPaletteItemType,
  UseActionPaletteReturn,
} from "@/hooks/useActionPalette";

const SECTION_HEADER_CLASS =
  "px-3 py-1 text-[10px] font-medium tracking-wider uppercase text-daintree-text/40 select-none";

// Module-level so SearchablePalette receives a stable reference and skips
// re-renders driven only by a freshly-created callback identity.
const getActionItemId = (item: ActionPaletteItemType): string => item.id;

// Verb-noun derived from the highlighted action's title — empty selection
// falls back to a generic "run action" so the chip never goes blank.
const getActionLabel = (item: ActionPaletteItemType | null): string => item?.title ?? "Run action";

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
        "bg-overlay-subtle text-xs text-daintree-text/70 select-none shrink-0 origin-left",
        "transition-[opacity,transform] motion-reduce:transition-opacity motion-reduce:scale-100",
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
  | "pinnedCount"
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
  pinnedCount,
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

  // The sectioned empty-query body renders headers as siblings of the row list,
  // so the listbox children stay 1:1 with `results` for the parent's
  // scroll-into-view logic. The custom scroll effect below scrolls within the
  // sectioned listbox itself, keyed by `data-action-id` so the divider divs
  // don't throw off the offset.
  const sectionedListRef = useRef<HTMLDivElement>(null);
  const showSections = !query.trim() && results.length > 0;

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
    (item: ActionPaletteItemType, index: number) => {
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
            onHide={hideAction}
          />
        </div>
      );
    },
    [
      pinnedActionIds,
      selectedIndex,
      handleSelect,
      setSelectedIndex,
      pinAction,
      unpinAction,
      hideAction,
    ]
  );

  const renderSectionedBody = useCallback(() => {
    const pinnedRows = results.slice(0, pinnedCount);
    const recentRows = results.slice(pinnedCount);
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
          {pinnedRows.length > 0 && (
            <>
              <div className={SECTION_HEADER_CLASS} role="presentation">
                Favorites
              </div>
              {pinnedRows.map((item, idx) => renderActionRow(item, idx))}
            </>
          )}
          {recentRows.length > 0 && (
            <>
              <div className={SECTION_HEADER_CLASS} role="presentation">
                Recently used
              </div>
              {recentRows.map((item, idx) => renderActionRow(item, pinnedCount + idx))}
            </>
          )}
        </div>
        <PaletteOverflowNotice shown={results.length} total={totalResults} />
      </>
    );
  }, [results, pinnedCount, isStale, totalResults, renderActionRow]);

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
      // Atomic hand-off — `openPalette` replaces `activePaletteId` directly,
      // so the action palette unmounts as the target mounts. No `close()`
      // call needed; an explicit close would briefly null the mutex and
      // teardown focus restoration via the palette-to-palette guard.
      usePaletteStore.getState().openPalette(route.paletteId);
    },
    [activeMode, query]
  );

  const footer = useMemo<React.ReactNode>(() => {
    // Mode-active footer: name what Enter does in the current scope so the
    // user can't accidentally fire the wrong primary action.
    if (activeMode === "commands") {
      return (
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: "to run command" }}
          hints={[
            { keys: ["⌫"], label: "exit scope" },
            { keys: ["Esc"], label: "close" },
          ]}
        />
      );
    }

    // Default empty-mode hint: surface the projects prefix when the query
    // resembles a path or filename. Per-query-shape only — no auto-routing.
    if (results.length === 0 && looksLikePath(query)) {
      return (
        <PaletteFooterHints
          primaryHint={{ keys: ["/"], label: "search projects" }}
          hints={[
            { keys: ["↑", "↓"], label: "navigate" },
            { keys: ["Esc"], label: "close" },
          ]}
        />
      );
    }

    return undefined;
  }, [activeMode, query, results.length]);

  const chipNode = chipShouldRender ? <ModeChip label={chipLabel} isVisible={chipVisible} /> : null;

  return (
    <SearchablePalette<ActionPaletteItemType>
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
      footer={footer}
      getItemId={getActionItemId}
      getActionLabel={activeMode === null && footer === undefined ? getActionLabel : undefined}
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
          />
        );
      }}
      renderBody={showSections ? renderSectionedBody : undefined}
      label="Actions"
      shortcut={actionPaletteShortcut}
      ariaLabel="Action palette"
      searchPlaceholder="Find an action"
      searchAriaLabel="Search actions"
      listId="action-palette-list"
      itemIdPrefix="action-option"
      emptyMessage="No actions yet"
      totalResults={totalResults}
    />
  );
}
