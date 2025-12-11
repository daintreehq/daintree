import { useEffect, useRef, useCallback } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          if (results.length > 0 && selectedIndex >= 0) {
            onSelect(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Terminal palette">
      <AppPaletteDialog.Header label="Quick switch" keyHint="⌘P">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search agents and terminals..."
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Search agents and terminals"
          aria-controls="terminal-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0
              ? `terminal-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="terminal-list" role="listbox" aria-label="Agents and terminals">
          {results.length === 0 ? (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No agents or terminals running"
              noMatchMessage={`No agents or terminals match "${query}"`}
            />
          ) : (
            results.map((terminal, index) => (
              <TerminalListItem
                key={terminal.id}
                id={`terminal-option-${terminal.id}`}
                title={terminal.title}
                type={terminal.type}
                agentId={terminal.agentId}
                worktreeName={terminal.worktreeName}
                cwd={terminal.cwd}
                isSelected={index === selectedIndex}
                onClick={() => onSelect(terminal)}
              />
            ))
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer />
    </AppPaletteDialog>
  );
}

export default TerminalPalette;
