import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KbdChord } from "@/components/ui/Kbd";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import type { WorktreeState } from "@/types";

interface WorktreeListItemProps {
  worktree: WorktreeState;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
  onHover: () => void;
}

function WorktreeListItem({
  worktree,
  isActive,
  isSelected,
  onClick,
  onHover,
}: WorktreeListItemProps) {
  const { ref, isTruncated } = useTruncationDetection();

  return (
    <TruncatedTooltip content={worktree.path} isTruncated={isTruncated}>
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        id={`worktree-option-${worktree.id}`}
        onPointerMove={onHover}
        onClick={onClick}
        className={cn(
          // Was a hand-rolled copy of the shared row and drifted out of step
          // with it; takes the selected treatment from the family now.
          PALETTE_ROW_CLASS,
          "group w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex flex-col gap-0.5",
          "bg-surface-canvas hover:bg-surface"
        )}
        // The cursor is aria-selected; the worktree you are in is aria-current
        // with a neutral check, as in the rest of the palette family.
        aria-selected={isSelected}
        aria-current={isActive ? "true" : undefined}
        role="option"
      >
        <div className="flex items-center justify-between gap-2 text-sm">
          {/* Both sides truncate: branch names have no length worth trusting,
              so no tier is wide enough to make this unnecessary. */}
          <span className="font-medium text-text-primary truncate">{worktree.name}</span>
          <div className="flex items-center gap-2 min-w-0 text-xs text-text-secondary">
            {worktree.branch && (
              <span className="font-mono text-text-secondary truncate">{worktree.branch}</span>
            )}
            {isActive && (
              <>
                <Check className="w-4 h-4 shrink-0 text-text-primary" aria-hidden="true" />
                <span className="sr-only">Current worktree</span>
              </>
            )}
          </div>
        </div>
        <div
          ref={ref}
          className="text-2xs text-text-secondary truncate transition-colors group-aria-selected:text-text-primary"
        >
          {worktree.path}
        </div>
      </button>
    </TruncatedTooltip>
  );
}

const getWorktreeActionLabel = (_item: WorktreeState | null): string => "Switch worktree";

export interface WorktreePaletteProps {
  isOpen: boolean;
  query: string;
  results: WorktreeState[];
  totalResults: number;
  activeWorktreeId: string | null;
  selectedIndex: number;
  isStale?: boolean;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (worktree: WorktreeState) => void;
  onConfirm: () => void;
  onClose: () => void;
  /** Moves the cursor Enter acts on; the pointer and Home/End drive it. */
  onSelectIndex: (index: number) => void;
}

export function WorktreePalette({
  isOpen,
  query,
  results,
  totalResults,
  activeWorktreeId,
  selectedIndex,
  isStale = false,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onConfirm,
  onClose,
  onSelectIndex,
}: WorktreePaletteProps) {
  const createWorktreeShortcut = useEffectiveCombo("worktree.createDialog.open");
  const worktreePaletteShortcut = useEffectiveCombo("worktree.openPalette");

  return (
    <SearchablePalette<WorktreeState>
      tier="anchored"
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={onQueryChange}
      onSelectPrevious={onSelectPrevious}
      onSelectNext={onSelectNext}
      onSelectIndex={onSelectIndex}
      onConfirm={onConfirm}
      onClose={onClose}
      getItemId={(worktree) => worktree.id}
      onHoverIndex={onSelectIndex}
      getActionLabel={getWorktreeActionLabel}
      isFiltering={isStale}
      renderItem={(worktree, index, isSelected, onHoverIndex) => (
        <WorktreeListItem
          key={worktree.id}
          worktree={worktree}
          isActive={worktree.id === activeWorktreeId}
          isSelected={isSelected}
          onClick={() => onSelect(worktree)}
          onHover={() => onHoverIndex(index)}
        />
      )}
      label="Worktree switcher"
      shortcut={worktreePaletteShortcut}
      ariaLabel="Worktree palette"
      searchPlaceholder="Search worktrees"
      searchAriaLabel="Search worktrees"
      listId="worktree-palette-list"
      itemIdPrefix="worktree-option"
      emptyMessage="No worktrees yet"
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-text-secondary">
          {createWorktreeShortcut ? (
            <>
              Press <KbdChord shortcut={createWorktreeShortcut} /> to create a worktree.
            </>
          ) : (
            "Create a worktree to get started."
          )}
        </p>
      }
    />
  );
}
