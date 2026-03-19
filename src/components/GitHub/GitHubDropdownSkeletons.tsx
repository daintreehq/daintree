import { Search, ExternalLink, Plus, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

export const RESOURCE_ITEM_HEIGHT_PX = 68;
export const COMMIT_ITEM_HEIGHT_PX = 64;
export const MAX_SKELETON_ITEMS = 6;

function normalizeCount(count?: number | null): number {
  if (count == null || !Number.isFinite(count)) return MAX_SKELETON_ITEMS;
  return Math.min(Math.max(1, Math.floor(count)), MAX_SKELETON_ITEMS);
}

interface SkeletonProps {
  count?: number | null;
  immediate?: boolean;
}

interface ResourceListSkeletonProps extends SkeletonProps {
  type?: "issue" | "pr";
}

export function GitHubResourceListSkeleton({
  count,
  immediate,
  type = "issue",
}: ResourceListSkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  const stateTabs =
    type === "pr"
      ? [
          { id: "open", label: "Open" },
          { id: "merged", label: "Merged" },
          { id: "closed", label: "Closed" },
        ]
      : [
          { id: "open", label: "Open" },
          { id: "closed", label: "Closed" },
        ];

  return (
    <div
      className="relative w-[450px] flex flex-col max-h-[500px]"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading GitHub results"
    >
      <span className="sr-only">Loading GitHub results</span>

      {/* Header — matches GitHubResourceList */}
      <div className="p-3 border-b border-[var(--border-divider)] space-y-3 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-canopy-text/40 pointer-events-none"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 text-sm text-muted-foreground select-none">
              Search {type === "issue" ? "issues" : "pull requests"}...
            </span>
          </div>
          <div className="flex items-center justify-center w-7 h-7 rounded shrink-0 text-canopy-text/60">
            <Filter className="w-3.5 h-3.5" />
          </div>
        </div>

        <div
          className="flex p-0.5 bg-overlay-soft border border-[var(--border-divider)] rounded-[var(--radius-md)]"
          aria-hidden="true"
        >
          {stateTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "flex-1 px-3 py-1 text-xs font-medium rounded text-center",
                tab.id === "open"
                  ? "bg-canopy-accent/10 text-canopy-accent"
                  : "text-muted-foreground"
              )}
            >
              {tab.label}
            </div>
          ))}
        </div>
      </div>

      {/* List skeleton rows */}
      <div className="overflow-y-auto flex-1 min-h-0">
        <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
          {Array.from({ length: renderCount }).map((_, i) => (
            <div
              key={i}
              className={`${pulseClass} box-border`}
              style={{ height: `${RESOURCE_ITEM_HEIGHT_PX}px` }}
            >
              <div className="flex items-center gap-2 px-3 pt-2.5">
                <div className="w-4 h-4 rounded-full bg-muted shrink-0" />
                <div className="h-4 bg-muted rounded flex-1" />
                <div className="h-4 bg-muted rounded w-8 shrink-0" />
              </div>
              <div className="flex items-center gap-1.5 px-3 mt-1.5 pb-2.5">
                <div className="h-3 bg-muted rounded w-16" />
                <div className="h-3 bg-muted rounded w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer — matches GitHubResourceList */}
      <div className="p-3 border-t border-[var(--border-divider)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plus className="h-3.5 w-3.5" />
          New
        </div>
      </div>
    </div>
  );
}

export function CommitListSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading commits">
      <span className="sr-only">Loading commits</span>
      <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
        {Array.from({ length: renderCount }).map((_, i) => (
          <div
            key={i}
            className={`px-3 py-2.5 ${pulseClass} box-border`}
            style={{ height: `${COMMIT_ITEM_HEIGHT_PX}px` }}
          >
            <div className="flex items-start gap-2 h-full">
              <div className="w-4 h-4 rounded-full bg-muted mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="h-5 bg-muted rounded w-3/4" />
                <div className="mt-0.5 flex items-center gap-1.5">
                  <div className="h-4 bg-muted rounded w-16" />
                  <div className="h-4 bg-muted rounded w-20" />
                  <div className="h-4 bg-muted rounded w-12" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
