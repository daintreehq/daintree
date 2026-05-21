import { useCallback, useId } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { QuickSwitcherItem } from "./QuickSwitcherItem";
import { useKeybindingDisplay, useEffectiveCombo } from "@/hooks/useKeybinding";
import type {
  QuickSwitcherItem as QuickSwitcherItemData,
  UseQuickSwitcherReturn,
} from "@/hooks/useQuickSwitcher";

function getQuickSwitcherActionLabel(item: QuickSwitcherItemData): string {
  switch (item.type) {
    case "terminal":
      return "to switch terminal";
    case "worktree":
      return "to switch worktree";
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
  | "isLoading"
  | "close"
  | "setQuery"
  | "setSelectedIndex"
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
  isLoading,
  close,
  setQuery,
  setSelectedIndex,
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

  const footerHintId = useId();

  const getFooter = useCallback(
    (item: QuickSwitcherItemData | null): React.ReactNode => {
      if (!item) return undefined;
      const label = getQuickSwitcherActionLabel(item);
      return (
        <div id={footerHintId} className="w-full">
          <PaletteFooterHints
            primaryHint={{ keys: ["↵"], label }}
            hints={[
              { keys: ["↑", "↓"], label: "navigate" },
              { keys: ["Esc"], label: "close" },
            ]}
          />
        </div>
      );
    },
    [footerHintId]
  );

  const newTerminalShortcut = useKeybindingDisplay("terminal.new");
  const quickSwitcherShortcut = useEffectiveCombo("nav.quickSwitcher");

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
      onHoverIndex={setSelectedIndex}
      getItemId={(item) => item.id}
      renderItem={(item, index, isSelected, onHoverIndex) => (
        <QuickSwitcherItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onSelect={handleSelect}
          onHover={() => onHoverIndex(index)}
          ariaDescribedBy={footerHintId}
        />
      )}
      getFooter={getFooter}
      label="Quick switch"
      shortcut={quickSwitcherShortcut}
      ariaLabel="Quick switcher"
      isLoading={isLoading}
      searchPlaceholder="Find panels, agents, or worktrees"
      searchAriaLabel="Search terminals, agents, and worktrees"
      listId="quick-switcher-list"
      itemIdPrefix="qs-option"
      emptyMessage="No panels open"
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-daintree-text/40">
          {newTerminalShortcut ? (
            <>
              Press <kbd className={KBD_CLASS}>{newTerminalShortcut}</kbd> to create a terminal.
            </>
          ) : (
            "Create a terminal to get started."
          )}
        </p>
      }
    />
  );
}
