import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { TerminalListItem } from "./TerminalListItem";
import type { SearchableTerminal } from "@/hooks/useTerminalPalette";

export interface TerminalPaletteProps {
  isOpen: boolean;
  query: string;
  results: SearchableTerminal[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (terminal: SearchableTerminal) => void;
  onClose: () => void;
}

export function TerminalPalette({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
}: TerminalPaletteProps) {
  return (
    <SearchablePalette<SearchableTerminal>
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={onQueryChange}
      onSelectPrevious={onSelectPrevious}
      onSelectNext={onSelectNext}
      onConfirm={() => {
        if (results.length > 0 && selectedIndex >= 0) {
          onSelect(results[selectedIndex]);
        }
      }}
      onClose={onClose}
      getItemId={(terminal) => terminal.id}
      renderItem={(terminal, _index, isSelected) => (
        <TerminalListItem
          key={terminal.id}
          id={`terminal-option-${terminal.id}`}
          title={terminal.title}
          type={terminal.type}
          kind={terminal.kind}
          agentId={terminal.agentId}
          worktreeName={terminal.worktreeName}
          cwd={terminal.cwd}
          isSelected={isSelected}
          onClick={() => onSelect(terminal)}
        />
      )}
      label="Quick switch"
      keyHint="⌘P"
      ariaLabel="Terminal palette"
      searchPlaceholder="Search agents and terminals..."
      searchAriaLabel="Search agents and terminals"
      listId="terminal-list"
      itemIdPrefix="terminal-option"
      emptyMessage="No agents or terminals running"
      noMatchMessage={`No agents or terminals match "${query}"`}
    />
  );
}

export default TerminalPalette;
