import { useId } from "react";
import { FolderGit2, Sprout } from "@/components/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorktreeSnapshot } from "@/types";
import { worktreeOptionLabel } from "./crossWorktreeDiffUtils";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { splitBranchType } from "./BranchLabel";

interface WorktreeSelectorProps {
  label: string;
  worktrees: WorktreeSnapshot[];
  selectedId: string | null;
  disabledId?: string | null;
  onChange: (worktreeId: string) => void;
}

/**
 * An option as the sidebar card draws the same worktree: the sprout for main,
 * the branch's type mark otherwise, the branch in mono. The sprout says "main"
 * on screen, so the words stay only in the accessible name.
 */
function WorktreeOption({ wt }: { wt: WorktreeSnapshot }) {
  if (!wt.branch) return <>{worktreeOptionLabel(wt)}</>;
  const Glyph = wt.isMainWorktree ? Sprout : (splitBranchType(wt.branch).Icon ?? FolderGit2);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Glyph className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="truncate font-mono">{wt.branch}</span>
      {wt.isMainWorktree && <span className="sr-only"> (main worktree)</span>}
    </span>
  );
}

export function WorktreeSelector({
  label,
  worktrees,
  selectedId,
  disabledId,
  onChange,
}: WorktreeSelectorProps) {
  const triggerId = useId();
  // A chosen worktree that has since left the list matches no option, which
  // Radix draws as a blank trigger; it reads as unset instead.
  const value = worktrees.some((wt) => wt.id === selectedId) ? (selectedId ?? "") : "";
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label htmlFor={triggerId} className={SECTION_LABEL_CLASS}>
        {label}
      </label>
      {/* "" is Radix's unset value: the trigger shows the placeholder. */}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={triggerId} className="justify-start">
          {/* A chosen option brings its own glyph into the trigger. */}
          {!worktrees.some((wt) => wt.id === selectedId && wt.branch) && (
            <FolderGit2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
          )}
          <SelectValue placeholder="Choose a worktree…" className="flex-1" />
        </SelectTrigger>
        <SelectContent>
          {worktrees.map((wt) => (
            <SelectItem key={wt.id} value={wt.id} disabled={wt.id === disabledId || !wt.branch}>
              <WorktreeOption wt={wt} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
