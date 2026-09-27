import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KbdChord } from "@/components/ui/Kbd";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Lock } from "lucide-react";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import type { SendToAgentItem } from "@/hooks/useSendToAgentPalette";

// Names the pane, since Enter writes into another terminal and this is the
// last look before it does. "Paste", not "send to agent": the text lands in
// the pane's input unsubmitted, and a plain shell is a valid target too.
const getSendToAgentActionLabel = (item: SendToAgentItem): string | null =>
  item.isInputLocked ? null : `Paste into ${item.title}`;

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
  setSelectedIndex: (index: number) => void;
}

function SendToAgentItemRow({
  item,
  isSelected,
  onSelect,
  onHover,
}: {
  item: SendToAgentItem;
  isSelected: boolean;
  onSelect: (item: SendToAgentItem) => void;
  onHover: () => void;
}) {
  const locked = !!item.isInputLocked;
  return (
    <button
      id={`send-to-agent-option-${item.id}`}
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      // The pointer moves the cursor Enter acts on, so pointing at one row and
      // pressing Enter can't send to another.
      onPointerMove={onHover}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "text-text-secondary",
        !locked && "hover:bg-overlay-subtle"
      )}
      onClick={() => !locked && onSelect(item)}
      // Keyboard navigation never lands here, but an all-locked list still
      // parks the index on row 0; the rail must not claim a row Enter skips.
      aria-selected={isSelected && !locked}
      aria-disabled={locked}
      // The subtitle carries the agent, the lock reason and, when the targets
      // span more than one worktree, the worktree — the only thing separating
      // two identically titled rows, so the accessible name carries it too.
      aria-label={[item.title, item.subtitle].filter(Boolean).join(", ")}
      role="option"
    >
      <span className="shrink-0 text-text-secondary" aria-hidden="true">
        <TerminalIcon kind={item.terminalKind} chrome={item.chrome} />
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Locked steps the title down the ramp instead of fading the row, as
            the rest of the palette family does: opacity took the reason line
            with it, and the reason is the one line here that has to be read. */}
        {/* Two lines before it clips: a task title is often the only thing that
            tells two panes of one agent apart, and cutting it at one line hid
            the part that differs. */}
        <span
          className={cn(
            "text-sm font-medium line-clamp-2 break-words",
            locked ? "text-text-secondary" : "text-text-primary"
          )}
        >
          {item.title}
        </span>
        {item.subtitle && (
          <span className="text-xs text-text-secondary truncate block">{item.subtitle}</span>
        )}
      </div>

      {locked && <Lock className="w-3.5 h-3.5 text-text-secondary shrink-0" aria-hidden="true" />}
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
  setSelectedIndex,
}: SendToAgentPaletteProps) {
  const handleSelect = useCallback(
    (item: SendToAgentItem) => {
      selectItem(item);
    },
    [selectItem]
  );

  // Home and End come through here too, so a locked row at either end hands
  // the cursor to its nearest open neighbour instead of swallowing the key.
  const handleHoverIndex = useCallback(
    (index: number) => {
      const atEdge = index === 0 || index === results.length - 1;
      const step = index === results.length - 1 && index > 0 ? -1 : 1;
      for (let i = index; i >= 0 && i < results.length; i += step) {
        if (!results[i]!.isInputLocked) {
          setSelectedIndex(i);
          return;
        }
        if (!atEdge) return;
      }
    },
    [results, setSelectedIndex]
  );

  const allLocked = results.length > 0 && results.every((item) => item.isInputLocked);

  const newTerminalShortcut = useEffectiveCombo("terminal.new");
  const sendToAgentShortcut = useEffectiveCombo("terminal.sendToAgent");

  return (
    <SearchablePalette<SendToAgentItem>
      tier="anchored"
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      onHoverIndex={handleHoverIndex}
      getItemId={(item) => item.id}
      getActionLabel={getSendToAgentActionLabel}
      renderItem={(item, index, isItemSelected, onHoverIndex) => (
        <SendToAgentItemRow
          key={item.id}
          item={item}
          isSelected={isItemSelected}
          onSelect={handleSelect}
          onHover={() => onHoverIndex(index)}
        />
      )}
      afterList={
        allLocked ? (
          <p className="px-3 pt-3 pb-1 text-xs text-text-secondary">
            Unlock a terminal from its pane menu to send to it
          </p>
        ) : undefined
      }
      label="Send selection to"
      shortcut={sendToAgentShortcut}
      ariaLabel="Send selection to agent"
      searchPlaceholder="Search terminals, agents, and worktrees"
      searchAriaLabel="Search terminals, agents, and worktrees"
      listId="send-to-agent-list"
      itemIdPrefix="send-to-agent-option"
      emptyMessage="No other terminals available"
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-text-secondary">
          {newTerminalShortcut ? (
            <>
              Press <KbdChord shortcut={newTerminalShortcut} /> to create a new terminal
            </>
          ) : (
            "Create another terminal to send selections to"
          )}
        </p>
      }
    />
  );
}
