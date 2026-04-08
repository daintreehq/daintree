import { WorktreeIcon } from "@/components/icons";
import type { WorktreeSnapshot } from "@/types";

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
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</span>
      <div className="relative">
        <WorktreeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
        <select
          value={selectedId ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none bg-surface-panel-elevated border border-border-default rounded-md pl-8 pr-3 py-2 text-sm text-text-primary focus:outline-none focus:border-border-default cursor-pointer"
        >
          <option value="" disabled>
            Select worktree…
          </option>
          {worktrees.map((wt) => (
            <option key={wt.id} value={wt.id} disabled={wt.id === disabledId}>
              {wt.isMainWorktree ? wt.name : wt.branch || wt.name}{" "}
              {wt.isMainWorktree ? "(main)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
