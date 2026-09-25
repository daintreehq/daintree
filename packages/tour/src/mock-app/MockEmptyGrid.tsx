import { Search } from "lucide-react";
import { cn } from "../kit/cn.js";

/** The empty grid, as a new worktree shows it: the launcher and nothing else. */
export function MockEmptyGrid({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex size-full flex-col items-center justify-center gap-2", className)}>
      <span className="text-xs font-semibold text-text-primary">{label}</span>
      <span className="flex h-6 w-48 items-center gap-1.5 rounded-md border border-border-default bg-surface-panel px-2">
        <Search className="size-3 text-text-secondary" aria-hidden="true" />
        <span className="text-3xs text-text-secondary">Search agents &amp; panels…</span>
      </span>
    </div>
  );
}
