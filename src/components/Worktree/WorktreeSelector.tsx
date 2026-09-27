import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { cn } from "@/lib/utils";
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
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label
        htmlFor={id}
        className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
      >
        {label}
      </label>
      <div className="relative">
        <FolderGit2
          aria-hidden="true"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none"
        />
        <select
          id={id}
          value={selectedId ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full appearance-none truncate bg-surface-panel-elevated border border-border-default rounded-[var(--radius-md)] pl-8 pr-8 py-1.5 text-sm cursor-pointer focus:outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent-primary",
            selectedId ? "text-text-primary" : "text-text-secondary"
          )}
        >
          <option value="" disabled>
            Choose a worktree…
          </option>
          {worktrees.map((wt) => (
            <option key={wt.id} value={wt.id} disabled={wt.id === disabledId || !wt.branch}>
              {worktreeOptionLabel(wt)}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none"
        />
      </div>
    </div>
  );
}
