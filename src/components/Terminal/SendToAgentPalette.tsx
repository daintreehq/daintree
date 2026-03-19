import React, { useCallback } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getBrandColorHex } from "@/lib/colorUtils";
import { Lock } from "lucide-react";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import type { SendToAgentItem } from "@/hooks/useSendToAgentPalette";

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

const SendToAgentItemRow = React.memo(function SendToAgentItemRow({
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
        "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "transition-colors",
        "border",
        item.isInputLocked
          ? "opacity-40 cursor-not-allowed border-transparent"
          : isSelected
            ? "bg-overlay-soft border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
            : "border-transparent text-canopy-text/70 hover:bg-overlay-subtle hover:text-canopy-text"
      )}
      onClick={() => !item.isInputLocked && onSelect(item)}
      aria-selected={isSelected}
      aria-disabled={item.isInputLocked}
      aria-label={item.title}
      role="option"
    >
      <span className="shrink-0 text-canopy-text/70" aria-hidden="true">
        <TerminalIcon
          type={item.terminalType}
          kind={item.terminalKind}
          agentId={item.agentId}
          detectedProcessId={item.detectedProcessId}
          brandColor={getBrandColorHex(item.agentId ?? item.terminalType)}
        />
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <span className="text-sm font-medium text-canopy-text truncate block">{item.title}</span>
        {item.subtitle && (
          <span className="text-xs text-canopy-text/50 truncate block">{item.subtitle}</span>
        )}
      </div>

      {item.isInputLocked && (
        <Lock className="w-3.5 h-3.5 text-canopy-text/40 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
});

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
      renderItem={(item, _index, isItemSelected) => (
        <SendToAgentItemRow
          key={item.id}
          item={item}
          isSelected={isItemSelected}
          onSelect={handleSelect}
        />
      )}
      label="Send selection to"
      keyHint="⌘⇧E"
      ariaLabel="Send selection to agent"
      searchPlaceholder="Search terminals and agents..."
      searchAriaLabel="Search terminals and agents"
      listId="send-to-agent-list"
      itemIdPrefix="send-to-agent-option"
      emptyMessage="No other terminals available"
      noMatchMessage={`No terminals match "${query}"`}
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-canopy-text/40">
          {newTerminalShortcut ? (
            <>
              Press{" "}
              <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                {newTerminalShortcut}
              </kbd>{" "}
              to create a new terminal.
            </>
          ) : (
            "Create another terminal to send selections."
          )}
        </p>
      }
    />
  );
}
