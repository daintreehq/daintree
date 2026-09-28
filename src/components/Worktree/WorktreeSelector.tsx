import { useId } from "react";
import { FolderGit2 } from "@/components/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorktreeSnapshot } from "@/types";
import { worktreeOptionLabel } from "./crossWorktreeDiffUtils";

interface WorktreeSelectorProps {
  label: string;
  worktrees: WorktreeSnapshot[];
  selectedId: string | null;
  disabledId?: string | null;
  onChange: (worktreeId: string) => void;
}

export function WorktreeSelector({
  label,
  worktrees,
  selectedId,
  disabledId,
  onChange,
}: WorktreeSelectorProps) {
  const triggerId = useId();
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label
        htmlFor={triggerId}
        className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
      >
        {label}
      </label>
      {/* "" is Radix's unset value: the trigger shows the placeholder. */}
      <Select value={selectedId ?? ""} onValueChange={onChange}>
        <SelectTrigger id={triggerId} className="justify-start">
          <FolderGit2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
          <SelectValue placeholder="Choose a worktree…" className="flex-1" />
        </SelectTrigger>
        <SelectContent>
          {worktrees.map((wt) => (
            <SelectItem key={wt.id} value={wt.id} disabled={wt.id === disabledId || !wt.branch}>
              {worktreeOptionLabel(wt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
