import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Lock } from "lucide-react";
import { useKeybindingDisplay, useEffectiveCombo } from "@/hooks/useKeybinding";
import type { SendToAgentItem } from "@/hooks/useSendToAgentPalette";

const getSendToAgentActionLabel = (_item: SendToAgentItem | null): string => "Send to agent";

export interface SendToAgentPaletteProps {
  isOpen: boolean;
  query: string;
  results: SendToAgentItem[];
  totalResults: number;
  selectedIndex: number;
  close: () => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectItem: (item: SendToAgentItem) => void;
  confirmSelection: () => void;
}

function SendToAgentItemRow({
  item,
  isSelected,
  onSelect,
}: {
  item: SendToAgentItem;
  isSelected: boolean;
  onSelect: (item: SendToAgentItem) => void;
}) {
  return (
    <button
      id={`send-to-agent-option-${item.id}`}
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      className={cn(
        "group relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors",
        // A locked row is not a selectable target, so it keeps its own inert box
        // rather than the shared selected treatment.
        item.isInputLocked
          ? "opacity-50 cursor-not-allowed border border-transparent"
          : [
              PALETTE_ROW_CLASS,
              "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text",
            ]
      )}
      onClick={() => !item.isInputLocked && onSelect(item)}
      aria-selected={isSelected}
      aria-disabled={item.isInputLocked}
      aria-label={item.title}
      role="option"
    >
      <span className="shrink-0 text-daintree-text/70" aria-hidden="true">
        <TerminalIcon kind={item.terminalKind} chrome={item.chrome} />
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <span className="text-sm font-medium text-daintree-text truncate block">{item.title}</span>
        {item.subtitle && (
          <span className="text-xs text-daintree-text/50 truncate block">{item.subtitle}</span>
        )}
      </div>

      {item.isInputLocked && (
        <Lock className="w-3.5 h-3.5 text-daintree-text/40 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

export function SendToAgentPalette({
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
}: SendToAgentPaletteProps) {
  const handleSelect = useCallback(
    (item: SendToAgentItem) => {
      selectItem(item);
    },
    [selectItem]
  );

  const newTerminalShortcut = useKeybindingDisplay("terminal.new");
  const sendToAgentShortcut = useEffectiveCombo("terminal.sendToAgent");

  return (
    <SearchablePalette<SendToAgentItem>
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
      getActionLabel={getSendToAgentActionLabel}
      renderItem={(item, _index, isItemSelected) => (
        <SendToAgentItemRow
          key={item.id}
          item={item}
          isSelected={isItemSelected}
          onSelect={handleSelect}
        />
      )}
      label="Send selection to"
      shortcut={sendToAgentShortcut}
      ariaLabel="Send selection to agent"
      searchPlaceholder="Search terminals and agents"
      searchAriaLabel="Search terminals and agents"
      listId="send-to-agent-list"
      itemIdPrefix="send-to-agent-option"
      emptyMessage="No other terminals available"
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-daintree-text/40">
          {newTerminalShortcut ? (
            <>
              Press <kbd className={KBD_CLASS}>{newTerminalShortcut}</kbd> to create a new terminal.
            </>
          ) : (
            "Create another terminal to send selections."
          )}
        </p>
      }
    />
  );
}
