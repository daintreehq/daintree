import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { KbdChord } from "@/components/ui/Kbd";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import {
  KBD_CLASS,
  PaletteFooterHints,
  PaletteNoMatchHint,
} from "@/components/ui/AppPaletteDialog";
import { PaletteScopeChip } from "@/components/ui/PaletteScopeChip";
import { QuickSwitcherItem } from "./QuickSwitcherItem";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { UI_PALETTE_EXIT_DURATION } from "@/lib/animationUtils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type {
  QuickSwitcherItem as QuickSwitcherItemData,
  UseQuickSwitcherReturn,
} from "@/hooks/useQuickSwitcher";

function getQuickSwitcherActionLabel(item: QuickSwitcherItemData): string {
  switch (item.type) {
    case "terminal":
      return "to switch panel";
    case "worktree":
      return "to switch worktree";
    case "plugin":
      return "to open";
  }
  const _exhaustive: never = item.type;
  return _exhaustive;
}

type QuickSwitcherProps = Pick<
  UseQuickSwitcherReturn,
  | "isOpen"
  | "query"
  | "results"
  | "totalResults"
  | "selectedIndex"
  | "matchesById"
  | "isLoading"
  | "close"
  | "setQuery"
  | "setSelectedIndex"
  | "selectPrevious"
  | "selectNext"
  | "selectItem"
  | "confirmSelection"
  | "scopedProvider"
  | "keywordProvider"
  | "scopedStatus"
  | "enterScope"
  | "exitScope"
>;

export function QuickSwitcher({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  matchesById,
  isLoading,
  close,
  setQuery,
  setSelectedIndex,
  selectPrevious,
  selectNext,
  selectItem,
  confirmSelection,
  scopedProvider,
  keywordProvider,
  scopedStatus,
  enterScope,
  exitScope,
}: QuickSwitcherProps) {
  const handleSelect = useCallback(
    (item: QuickSwitcherItemData) => {
      selectItem(item);
    },
    [selectItem]
  );

  const footerHintId = useId();

  // While the query spells a provider's keyword, the footer says Tab scopes to
  // it — the one place the keyword grammar is taught.
  const keywordHint = useMemo(
    () => (keywordProvider ? { keys: ["Tab"], label: `to search ${keywordProvider.title}` } : null),
    [keywordProvider]
  );
  // Inside a scope the way back is Backspace on an empty field, said where the
  // Tab that got the user in was taught.
  const scopeExitHint = useMemo(
    () => (scopedProvider && query === "" ? { keys: ["⌫"], label: "to search everything" } : null),
    [scopedProvider, query]
  );
  const secondaryHint = keywordHint ?? scopeExitHint;
  const getFooter = useCallback(
    (item: QuickSwitcherItemData | null): React.ReactNode => {
      if (!item && !secondaryHint) return undefined;
      return (
        <div id={footerHintId} className="w-full">
          {item ? (
            <PaletteFooterHints
              primaryHint={{ keys: ["↵"], label: getQuickSwitcherActionLabel(item) }}
              hints={secondaryHint ? [secondaryHint] : []}
            />
          ) : (
            <PaletteFooterHints primaryHint={secondaryHint!} />
          )}
        </div>
      );
    },
    [footerHintId, secondaryHint]
  );

  // Built-in rows carry their type in their glyph and stay in one MRU or ranked
  // run; a band would split that order. Plugin rows come from somewhere else,
  // so each provider's block is named once above it instead of on every row.
  // Scoped, the chip in the field already names the one provider.
  const getSectionLabel = useCallback(
    (item: QuickSwitcherItemData) =>
      !scopedProvider && item.type === "plugin" ? (item.pluginHit?.providerTitle ?? "") : "",
    [scopedProvider]
  );

  // Keyword + Tab scopes the switcher to that provider; Backspace on an empty
  // field, or Escape once the query is clear, steps back out. Plain Tab and
  // Shift+Tab keep moving the selection as before.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        keywordProvider
      ) {
        e.preventDefault();
        e.stopPropagation();
        enterScope(keywordProvider.key);
        useAnnouncerStore.getState().announce(`Searching ${keywordProvider.title}`, "polite");
        return;
      }
      if (!scopedProvider) return;
      if (e.key === "Backspace") {
        const input = e.currentTarget;
        if (input.selectionStart === 0 && input.selectionEnd === 0) {
          e.preventDefault();
          exitScope();
          useAnnouncerStore.getState().announce("Searching everything", "polite");
        }
        return;
      }
      if (e.key === "Escape" && query === "") {
        e.preventDefault();
        e.stopPropagation();
        exitScope();
        useAnnouncerStore.getState().announce("Searching everything", "polite");
      }
    },
    [keywordProvider, scopedProvider, enterScope, exitScope, query]
  );

  // Hold the last chip label across the exit animation so it doesn't blank out.
  const [chipLabel, setChipLabel] = useState("");
  useEffect(() => {
    if (scopedProvider) setChipLabel(scopedProvider.title);
  }, [scopedProvider]);
  const { isVisible: chipVisible, shouldRender: chipShouldRender } = useAnimatedPresence({
    isOpen: scopedProvider !== null,
    animationDuration: UI_PALETTE_EXIT_DURATION,
  });
  const chipNode = chipShouldRender ? (
    <PaletteScopeChip label={chipLabel} isVisible={chipVisible} live={false} />
  ) : null;

  const scopedFailure =
    scopedProvider && scopedStatus === "timeout"
      ? `${scopedProvider.title} didn't answer in time`
      : scopedProvider && scopedStatus === "error"
        ? `${scopedProvider.title} couldn't search right now`
        : null;
  // The empty field's way out of the scope is Backspace; with a query in the
  // field Backspace edits it, so that state's next step is Escape.
  const backToEverything = (
    <p className="mt-2 text-xs text-text-secondary">
      {scopedFailure ? "Type to try again, or press " : "Press "}
      <kbd className={KBD_CLASS}>Backspace</kbd> to search everything
    </p>
  );
  const scopedNoMatch = scopedFailure ? (
    <p className="mt-2 text-xs text-text-secondary">
      Type to try again, or press <kbd className={KBD_CLASS}>Esc</kbd> to clear the search
    </p>
  ) : (
    <PaletteNoMatchHint />
  );

  const newTerminalShortcut = useEffectiveCombo("terminal.new");
  const quickSwitcherShortcut = useEffectiveCombo("nav.quickSwitcher");

  return (
    <SearchablePalette<QuickSwitcherItemData>
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
      getItemId={(item) => item.id}
      matchesById={matchesById}
      getSectionLabel={getSectionLabel}
      renderItem={(item, index, isSelected, onHoverIndex, matches) => (
        <QuickSwitcherItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onSelect={handleSelect}
          onHover={() => onHoverIndex(index)}
          ariaDescribedBy={footerHintId}
          matches={matches}
          query={query}
          showProvider={false}
        />
      )}
      getFooter={getFooter}
      label="Quick switch"
      shortcut={quickSwitcherShortcut}
      ariaLabel="Quick switcher"
      isLoading={isLoading}
      searchPlaceholder={
        scopedProvider ? `Search ${scopedProvider.title}` : "Find panels, agents, or worktrees"
      }
      searchAriaLabel={
        scopedProvider ? `Search ${scopedProvider.title}` : "Search panels, agents, and worktrees"
      }
      listId="quick-switcher-list"
      itemIdPrefix="qs-option"
      emptyMessage={
        scopedProvider
          ? (scopedFailure ?? `Type to search ${scopedProvider.title}`)
          : "No panels open"
      }
      noMatchMessage={scopedProvider ? (scopedFailure ?? undefined) : undefined}
      noMatchContent={
        scopedProvider ? scopedNoMatch : <PaletteNoMatchHint what="everything open" />
      }
      totalResults={totalResults}
      emptyContent={
        scopedProvider ? (
          backToEverything
        ) : (
          <p className="mt-2 text-xs text-text-secondary">
            {newTerminalShortcut ? (
              <>
                Press <KbdChord shortcut={newTerminalShortcut} /> to create a terminal.
              </>
            ) : (
              "Create a terminal to get started."
            )}
          </p>
        )
      }
    />
  );
}
