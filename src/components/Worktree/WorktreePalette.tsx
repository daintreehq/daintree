import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KbdChord } from "@/components/ui/Kbd";
import { FolderGit2, Sprout } from "@/components/icons";
import { PaletteCurrentLabel } from "@/components/ui/PaletteCurrentLabel";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { substringMatchIndices } from "@/components/ui/HighlightedText";
import { remapPathRanges, shortenPath } from "@/lib/pathTail";
import { TailKeepingText } from "@/components/ui/TailKeepingText";
import { PathTail } from "@/components/ui/PathTail";
import type { WorktreeState } from "@/types";
import { getWorktreeBranchLabel, getWorktreeQualifier } from "@/lib/worktreeHeadline";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { splitBranchType } from "./BranchLabel";

interface WorktreeListItemProps {
  worktree: WorktreeState;
  query: string;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
  onHover: () => void;
}

function WorktreeListItem({
  worktree,
  query,
  isActive,
  isSelected,
  onClick,
  onHover,
}: WorktreeListItemProps) {
  const customTitle = useWorktreeFilterStore((state) => state.worktreeCustomTitles[worktree.id]);
  const title = customTitle || worktree.name;
  // Beside the title when that adds anything: a linked worktree is named by its
  // branch, so printing the branch again spent half the line repeating the name.
  // A custom title (#13409) displaces the name, and the branch is then what
  // tells the row apart.
  const qualifier = getWorktreeQualifier(worktree, title);
  // A linked worktree is named by its branch, so its title is an identifier and
  // set in mono as the sidebar sets it; main's folder name stays a name.
  const isBranchTitled =
    !worktree.isMainWorktree && !worktree.isDetached && title === worktree.branch;
  // The tail, as in the quick switcher: the prefix every worktree shares is
  // what an end-truncated path used to spend its whole line on.
  const path = shortenPath(worktree.path);
  // The sidebar's glyph for the same worktree: the sprout for main, the
  // branch's type mark otherwise, and the worktree glyph only for an untyped one.
  const Glyph = worktree.isMainWorktree
    ? Sprout
    : (splitBranchType(getWorktreeBranchLabel(worktree)).Icon ?? FolderGit2);

  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      id={`worktree-option-${worktree.id}`}
      onPointerMove={onHover}
      onClick={onClick}
      className={cn(
        PALETTE_ROW_CLASS,
        // No resting fill: a backplate on every row read as stacked cards, and
        // the cursor had to out-shout its neighbours instead of being the only
        // lit row. The quick switcher's anatomy, so a worktree reads the same in
        // both places.
        "group w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary"
      )}
      // The cursor is aria-selected; the worktree you are in is aria-current
      // and says "Current" in words. A check is the mark for a chosen value,
      // and switching worktrees is navigation, not a value pick.
      aria-selected={isSelected}
      aria-current={isActive ? "true" : undefined}
      role="option"
    >
      <Glyph className="w-4 h-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <TailKeepingText
            text={title}
            indices={substringMatchIndices(title, query)}
            className={cn(
              // Only the family changes for a branch: the title keeps the
              // row's title size so it stays above the text-xs path line. Clipped,
              // not overflowing, when its kept tail is wider than what the
              // qualifier leaves, so the two never overlap; from its start, since the
              // end is what tells branch-like titles apart.
              "text-sm font-medium text-text-primary justify-end overflow-hidden",
              isBranchTitled && "font-mono"
            )}
          />
          {qualifier && (
            // Its own width, as before, capped at half the line: a long branch beside
            // a long custom title would otherwise take the whole row from the title.
            <span className="flex min-w-0 max-w-[50%] shrink-0 font-mono text-xs text-text-secondary">
              <span className="sr-only">, </span>
              <TailKeepingText text={qualifier} indices={substringMatchIndices(qualifier, query)} />
            </span>
          )}
          {isActive && <span className="sr-only">, current</span>}
        </div>
        <Tooltip autoDismiss={false}>
          <TooltipTrigger asChild>
            <div className="mt-0.5 flex min-w-0 text-xs text-text-secondary">
              <PathTail
                className="block min-w-0 font-mono"
                indices={remapPathRanges(substringMatchIndices(worktree.path, query), path.start)}
              >
                {path.text}
              </PathTail>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{worktree.path}</TooltipContent>
        </Tooltip>
      </div>
      {isActive && <PaletteCurrentLabel />}
    </button>
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
          query={query}
          isActive={worktree.id === activeWorktreeId}
          isSelected={isSelected}
          onClick={() => onSelect(worktree)}
          onHover={() => onHoverIndex(index)}
        />
      )}
      label="Switch worktree"
      shortcut={worktreePaletteShortcut}
      ariaLabel="Worktree palette"
      searchPlaceholder="Search worktrees…"
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
