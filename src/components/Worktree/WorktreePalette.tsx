import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
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
      id={`worktree-option-${worktree.id}`}
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
  return (
    <SearchablePalette<WorktreeState>
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={onQueryChange}
      onSelectPrevious={onSelectPrevious}
      onSelectNext={onSelectNext}
      onConfirm={onConfirm}
      onClose={onClose}
      getItemId={(worktree) => worktree.id}
      renderItem={(worktree, _index, isSelected) => (
        <WorktreeListItem
          key={worktree.id}
          worktree={worktree}
          isActive={worktree.id === activeWorktreeId}
          isSelected={isSelected}
          onClick={() => onSelect(worktree)}
        />
      )}
      label="Worktree switcher"
      keyHint="⌘K, W"
      ariaLabel="Worktree palette"
      searchPlaceholder="Search worktrees..."
      searchAriaLabel="Search worktrees"
      listId="worktree-palette-list"
      itemIdPrefix="worktree-option"
      emptyMessage="No worktrees available"
      noMatchMessage={`No worktrees match "${query}"`}
    />
  );
}

export default WorktreePalette;
