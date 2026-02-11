import { useCallback } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { QuickSwitcherItem } from "./QuickSwitcherItem";
import type {
  QuickSwitcherItem as QuickSwitcherItemData,
  UseQuickSwitcherReturn,
} from "@/hooks/useQuickSwitcher";

type QuickSwitcherProps = Pick<
  UseQuickSwitcherReturn,
  | "isOpen"
  | "query"
  | "results"
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
          onClick={() => handleSelect(item)}
        />
      )}
      label="Quick switch"
      keyHint="⌘P"
      ariaLabel="Quick switcher"
      searchPlaceholder="Search terminals, agents, worktrees..."
      searchAriaLabel="Search terminals, agents, and worktrees"
      listId="quick-switcher-list"
      itemIdPrefix="qs-option"
      emptyMessage="No items available"
      noMatchMessage={`No items match "${query}"`}
    />
  );
}
