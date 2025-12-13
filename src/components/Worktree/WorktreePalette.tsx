import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import type { WorktreeState } from "@/types";

interface WorktreeListItemProps {
  worktree: WorktreeState;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function WorktreeListItem({ worktree, isActive, isSelected, onClick }: WorktreeListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] border flex flex-col gap-0.5",
        "border-canopy-border/40 hover:border-canopy-border/60",
        "bg-canopy-bg hover:bg-surface transition-colors",
        isSelected && "border-canopy-accent/60 bg-canopy-accent/10"
      )}
      aria-selected={isSelected}
      role="option"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-canopy-text">{worktree.name}</span>
        <div className="flex items-center gap-2 text-xs text-canopy-text/60">
          {worktree.branch && (
            <span className="font-mono text-canopy-text/70">{worktree.branch}</span>
          )}
          {isActive && (
            <span className="px-1.5 py-0.5 rounded-[var(--radius-md)] bg-canopy-accent/15 text-canopy-accent text-[11px] font-semibold">
              Active
            </span>
          )}
        </div>
      </div>
      <div className="text-[11px] text-canopy-text/50 truncate">{worktree.path}</div>
    </button>
  );
}

export interface WorktreePaletteProps {
  isOpen: boolean;
  query: string;
  results: WorktreeState[];
  activeWorktreeId: string | null;
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (worktree: WorktreeState) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function WorktreePalette({
  isOpen,
  query,
  results,
  activeWorktreeId,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onConfirm,
  onClose,
}: WorktreePaletteProps) {
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
      selectedItem?.scrollIntoView({ block: "nearest" });
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
          onConfirm();
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
    [onSelectPrevious, onSelectNext, onConfirm, onClose]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Worktree palette">
      <AppPaletteDialog.Header label="Worktree switcher" keyHint="⌘K, W">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search worktrees..."
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Search worktrees"
          aria-controls="worktree-palette-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0
              ? `worktree-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="worktree-palette-list" role="listbox" aria-label="Worktrees">
          {results.length === 0 ? (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No worktrees available"
              noMatchMessage={`No worktrees match "${query}"`}
            />
          ) : (
            results.map((worktree, index) => (
              <WorktreeListItem
                key={worktree.id}
                worktree={worktree}
                isActive={worktree.id === activeWorktreeId}
                isSelected={index === selectedIndex}
                onClick={() => onSelect(worktree)}
              />
            ))
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer />
    </AppPaletteDialog>
  );
}

export default WorktreePalette;
