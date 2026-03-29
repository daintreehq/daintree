import { useCallback } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { QuickSwitcherItem } from "./QuickSwitcherItem";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import type {
  QuickSwitcherItem as QuickSwitcherItemData,
  UseQuickSwitcherReturn,
} from "@/hooks/useQuickSwitcher";

type QuickSwitcherProps = Pick<
  UseQuickSwitcherReturn,
  | "isOpen"
  | "query"
  | "results"
  | "totalResults"
  | "selectedIndex"
  | "close"
  | "setQuery"
  | "selectPrevious"
  | "selectNext"
  | "selectItem"
  | "confirmSelection"
>;

export function QuickSwitcher({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  close,
  setQuery,
  selectPrevious,
  selectNext,
  selectItem,
  confirmSelection,
}: QuickSwitcherProps) {
  const handleSelect = useCallback(
    (item: QuickSwitcherItemData) => {
      selectItem(item);
    },
    [selectItem]
  );

  const newTerminalShortcut = useKeybindingDisplay("terminal.new");

  return (
    <SearchablePalette<QuickSwitcherItemData>
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      getItemId={(item) => item.id}
      renderItem={(item, _index, isSelected) => (
        <QuickSwitcherItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onSelect={handleSelect}
        />
      )}
      label="Quick switch"
      keyHint="⌘P"
      ariaLabel="Quick switcher"
      searchPlaceholder="Search terminals, agents, worktrees..."
      searchAriaLabel="Search terminals, agents, and worktrees"
      listId="quick-switcher-list"
      itemIdPrefix="qs-option"
      emptyMessage="No panels open"
      noMatchMessage={`No items match "${query}"`}
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-canopy-text/40">
          {newTerminalShortcut ? (
            <>
              Press{" "}
              <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                {newTerminalShortcut}
              </kbd>{" "}
              to create a terminal.
            </>
          ) : (
            "Create a terminal to get started."
          )}
        </p>
      }
    />
  );
}
