import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { useKeybindingDisplay, useEffectiveCombo } from "@/hooks/useKeybinding";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import type { WorktreeState } from "@/types";

interface WorktreeListItemProps {
  worktree: WorktreeState;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function WorktreeListItem({ worktree, isActive, isSelected, onClick }: WorktreeListItemProps) {
  const { ref, isTruncated } = useTruncationDetection();

  return (
    <TruncatedTooltip content={worktree.path} isTruncated={isTruncated}>
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        id={`worktree-option-${worktree.id}`}
        onClick={onClick}
        className={cn(
          // Was a hand-rolled copy of the shared row and drifted out of step
          // with it; takes the selected treatment from the family now.
          PALETTE_ROW_CLASS,
          "group w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex flex-col gap-0.5",
          "bg-daintree-bg hover:bg-surface"
        )}
        aria-selected={isSelected}
        role="option"
      >
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-daintree-text">{worktree.name}</span>
          <div className="flex items-center gap-2 text-xs text-daintree-text/60">
            {worktree.branch && (
              <span className="font-mono text-daintree-text/70">{worktree.branch}</span>
            )}
            {isActive && (
              <span className="px-1.5 py-0.5 rounded-[var(--radius-md)] bg-[var(--color-state-active)]/15 text-[var(--color-state-active)] text-[11px] font-semibold">
                Active
              </span>
            )}
          </div>
        </div>
        <div
          ref={ref}
          className="text-[11px] text-daintree-text/50 truncate transition-colors group-aria-selected:text-daintree-text/60"
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
}: WorktreePaletteProps) {
  const createWorktreeShortcut = useKeybindingDisplay("worktree.createDialog.open");
  const worktreePaletteShortcut = useEffectiveCombo("worktree.openPalette");

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
      getActionLabel={getWorktreeActionLabel}
      isFiltering={isStale}
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
      shortcut={worktreePaletteShortcut}
      ariaLabel="Worktree palette"
      searchPlaceholder="Search worktrees"
      searchAriaLabel="Search worktrees"
      listId="worktree-palette-list"
      itemIdPrefix="worktree-option"
      emptyMessage="No worktrees yet"
      totalResults={totalResults}
      emptyContent={
        <p className="mt-2 text-xs text-daintree-text/40">
          {createWorktreeShortcut ? (
            <>
              Press <kbd className={KBD_CLASS}>{createWorktreeShortcut}</kbd> to create a worktree.
            </>
          ) : (
            "Create a worktree to get started."
          )}
        </p>
      }
    />
  );
}
