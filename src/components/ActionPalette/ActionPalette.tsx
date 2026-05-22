import { useCallback, useEffect, useRef } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
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
    );
  }, [results, pinnedCount, isStale, renderActionRow]);

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
      getItemId={getActionItemId}
      getActionLabel={getActionLabel}
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
