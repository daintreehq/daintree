import { cn } from "../../lib/utils";

export function WorktreeCardSkeleton() {
  return (
    <div
      className={cn(
        "border rounded-[var(--radius-lg)] p-3 mb-2",
        "border-transparent bg-canopy-bg/50",
        "animate-pulse-delayed"
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading worktree"
    >
      <span className="sr-only">Loading worktree</span>

      <div className="flex items-center justify-between gap-3 mb-2" aria-hidden="true">
        <div className="flex items-center gap-3 w-full">
          <div className="h-4 w-4 bg-muted/50 rounded-full shrink-0" />
          <div className="h-4 w-32 bg-muted/50 rounded" />
        </div>
        <div className="flex gap-1 shrink-0">
          <div className="h-4 w-4 bg-muted/30 rounded" />
          <div className="h-4 w-4 bg-muted/30 rounded" />
          <div className="h-4 w-4 bg-muted/30 rounded" />
        </div>
      </div>

      <div className="mb-2" aria-hidden="true">
        <div className="h-3 w-3/4 bg-muted/30 rounded" />
      </div>

      <div aria-hidden="true">
        <div className="h-3 w-full bg-muted/20 rounded" />
      </div>
    </div>
  );
}
