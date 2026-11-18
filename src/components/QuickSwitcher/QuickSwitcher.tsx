import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { KbdChord } from "@/components/ui/Kbd";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import {
  PaletteFooterHints,
  PaletteNoMatchHint,
  type PaletteCloseReason,
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
    case "file":
      return "to open file";
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
  | "isFiltering"
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
  | "fileScope"
  | "isFileKeyword"
  | "enterFileScope"
  | "exitScope"
>;

const FILE_EDITOR_HINT = { keys: "Cmd+Enter", label: "to open in editor" };

export function QuickSwitcher({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  matchesById,
  isLoading,
  isFiltering,
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
  fileScope,
  isFileKeyword,
  enterFileScope,
  exitScope,
}: QuickSwitcherProps) {
  const handleSelect = useCallback(
    (item: QuickSwitcherItemData, modified?: boolean) => {
      selectItem(item, modified);
    },
    [selectItem]
  );

  const isScoped = scopedProvider !== null || fileScope !== null;
  // The chip names the worktree once, so no file row has to.
  const fileScopeTitle = fileScope?.worktreeName
    ? `Files in ${fileScope.worktreeName}`
    : fileScope
      ? "Files"
      : null;
  const scopeTitle = scopedProvider?.title ?? fileScopeTitle;

  const footerHintId = useId();

  // While the query spells a provider's keyword, the footer says Tab scopes to
  // it — the one place the keyword grammar is taught.
  const keywordHint = useMemo(
    () =>
      isFileKeyword
        ? { keys: "Tab", label: "to search files" }
        : keywordProvider
          ? { keys: "Tab", label: `to search ${keywordProvider.title}` }
          : null,
    [isFileKeyword, keywordProvider]
  );
  // Inside a scope the way back is Backspace on an empty field, said where the
  // Tab that got the user in was taught.
  const scopeExitHint = useMemo(
    () => (isScoped && query === "" ? { keys: "Backspace", label: "to search everything" } : null),
    [isScoped, query]
  );
  const secondaryHint = keywordHint ?? scopeExitHint;
  const getFooter = useCallback(
    (item: QuickSwitcherItemData | null): React.ReactNode => {
      if (!item && !secondaryHint) return undefined;
      return (
        <div id={footerHintId} className="w-full">
          {item ? (
            <PaletteFooterHints
              primaryHint={{ keys: "Enter", label: getQuickSwitcherActionLabel(item) }}
              hints={[
                ...(item.type === "file" ? [FILE_EDITOR_HINT] : []),
                ...(secondaryHint ? [secondaryHint] : []),
              ]}
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
  // Scoped, the chip in the field already names the one provider. The file
  // scope's empty field lists changed files, and says so: nothing was typed
  // that they match.
  const getSectionLabel = useCallback(
    (item: QuickSwitcherItemData) =>
      item.file?.changed
        ? "Changed files"
        : !scopedProvider && item.type === "plugin"
          ? (item.pluginHit?.providerTitle ?? "")
          : "",
    [scopedProvider]
  );

  // Keyword + Tab scopes the switcher to files or to that provider; Backspace
  // on an empty field steps back out. Plain Tab and Shift+Tab move focus as
  // usual.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (isFileKeyword || keywordProvider)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (isFileKeyword) {
          enterFileScope();
          useAnnouncerStore.getState().announce("Searching files", "polite");
        } else if (keywordProvider) {
          enterScope(keywordProvider.key);
          useAnnouncerStore.getState().announce(`Searching ${keywordProvider.title}`, "polite");
        }
        return;
      }
      if (!isScoped || e.key !== "Backspace") return;
      // Only an empty field: with text before the caret's end Backspace edits it.
      if (e.currentTarget.value === "") {
        e.preventDefault();
        exitScope();
        useAnnouncerStore.getState().announce("Searching everything", "polite");
      }
    },
    [isFileKeyword, keywordProvider, isScoped, enterFileScope, enterScope, exitScope]
  );

  // Escape once the query is clear steps out of a scope before it closes, from
  // the field or from anywhere else in the palette; a scrim click closes.
  const handleClose = useCallback(
    (reason?: PaletteCloseReason) => {
      if (reason === "escape" && isScoped) {
        exitScope();
        useAnnouncerStore.getState().announce("Searching everything", "polite");
        return;
      }
      close();
    },
    [isScoped, exitScope, close]
  );

  // Hold the last chip label across the exit animation so it doesn't blank out.
  const [chipLabel, setChipLabel] = useState("");
  useEffect(() => {
    if (scopeTitle) setChipLabel(scopeTitle);
  }, [scopeTitle]);
  const { isVisible: chipVisible, shouldRender: chipShouldRender } = useAnimatedPresence({
    isOpen: isScoped,
    animationDuration: UI_PALETTE_EXIT_DURATION,
  });
  const chipNode = chipShouldRender ? (
    <PaletteScopeChip label={chipLabel} isVisible={chipVisible} live={false} />
  ) : null;

  const scopedFailure = fileScope?.failed
    ? "Couldn't search files right now"
    : scopedProvider && scopedStatus === "timeout"
      ? `${scopedProvider.title} didn't answer in time`
      : scopedProvider && scopedStatus === "error"
        ? `${scopedProvider.title} couldn't search right now`
        : null;
  // With no worktree shown there is nothing to search, typed or not.
  const noWorktree =
    fileScope !== null && fileScope.worktreeName === null
      ? "Select a worktree to search its files"
      : null;
  // The empty field's way out of the scope is Backspace; with a query in the
  // field Backspace edits it, so that state's next step is Escape.
  const backToEverything = (
    <p className="mt-2 text-xs text-text-secondary">
      {scopedFailure ? "Type to try again, or press " : "Press "}
      <KbdChord shortcut="Backspace" /> to search everything
    </p>
  );
  const scopedNoMatch = scopedFailure ? (
    <p className="mt-2 text-xs text-text-secondary">
      Type to try again, or press <KbdChord shortcut="Escape" /> to clear the search
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
      onClose={handleClose}
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
      isFiltering={isFiltering}
      searchPlaceholder={
        fileScope
          ? "Search files by name or path…"
          : scopedProvider
            ? `Search ${scopedProvider.title}…`
            : "Find panels, agents, or worktrees…"
      }
      searchAriaLabel={
        fileScope
          ? fileScope.worktreeName
            ? `Search files in ${fileScope.worktreeName}`
            : "Search files"
          : scopedProvider
            ? `Search ${scopedProvider.title}`
            : "Find panels, agents, or worktrees"
      }
      listId="quick-switcher-list"
      itemIdPrefix="qs-option"
      emptyMessage={
        fileScope
          ? (noWorktree ?? scopedFailure ?? "No files in this worktree yet")
          : scopedProvider
            ? (scopedFailure ?? `Type to search ${scopedProvider.title}`)
            : "No panels open"
      }
      noMatchMessage={isScoped ? (noWorktree ?? scopedFailure ?? undefined) : undefined}
      noMatchContent={isScoped ? scopedNoMatch : <PaletteNoMatchHint what="everything open" />}
      totalResults={totalResults}
      emptyContent={
        isScoped ? (
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
