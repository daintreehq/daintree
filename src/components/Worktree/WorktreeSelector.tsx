import { GitBranch } from "lucide-react";
import type { WorktreeState } from "@/types";

interface WorktreeSelectorProps {
  label: string;
  worktrees: WorktreeState[];
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
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">{label}</span>
      <div className="relative">
        <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-400 pointer-events-none" />
        <select
          value={selectedId ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none bg-neutral-800 border border-neutral-700 rounded-md pl-8 pr-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 cursor-pointer"
        >
          <option value="" disabled>
            Select worktree…
          </option>
          {worktrees.map((wt) => (
            <option key={wt.id} value={wt.id} disabled={wt.id === disabledId}>
              {wt.branch || wt.name} {wt.isMainWorktree ? "(main)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
