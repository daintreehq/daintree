import { Search, ExternalLink, Plus, ArrowUpDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";

/**
 * The virtualized row height, in px, and the only definition of it. This used
 * to be 68 against markup that measured about 58 — Virtuoso laid rows out on
 * the constant while the fill and hit area drew to the shorter box, leaving a
 * 10px strip between rows that belonged to no row at all. `GitHubListItem`
 * now sets its own height from this constant, so the two cannot drift.
 */
export const RESOURCE_ITEM_HEIGHT_PX = 64;
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
  const showImmediate = useSkeletonGate(Boolean(immediate));

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
      className="relative w-[450px] flex flex-col h-[500px]"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading GitHub results"
    >
      <span className="sr-only">Loading GitHub results</span>

      {/* Header — matches GitHubResourceList */}
      <div className="p-3 border-b border-[var(--border-divider)] space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-text-secondary pointer-events-none"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 text-sm text-text-secondary select-none">
              Search {type === "issue" ? "issues" : "pull requests"}…
            </span>
          </div>
          {/* Both icon slots, or the search field jumps narrower the moment
              real content replaces this. */}
          <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary">
            <RefreshCw className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary">
            <ArrowUpDown className="w-3.5 h-3.5" />
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
                tab.id === "open" ? "bg-overlay-medium text-daintree-text" : "text-text-secondary"
              )}
            >
              {tab.label}
            </div>
          ))}
        </div>
      </div>

      {/* List skeleton rows */}
      <div className="relative overflow-hidden flex-1 min-h-0">
        <GitHubResourceRowsSkeleton count={renderCount} immediate={showImmediate} />
        {/* Same fade the loaded list uses, so a skeleton row cut by the panel
            edge dissolves instead of being guillotined. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-[var(--scroll-shadow-color)] to-transparent"
        />
      </div>

      {/* Footer — matches GitHubResourceList */}
      <div className="px-2 py-1.5 border-t border-[var(--border-divider)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 px-3 h-7 text-xs text-text-secondary">
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </div>
        <div className="flex items-center gap-1.5 px-3 h-7 text-xs text-text-secondary">
          <Plus className="h-3.5 w-3.5" />
          {type === "issue" ? "New issue" : "New pull request"}
        </div>
      </div>
    </div>
  );
}

export function GitHubResourceRowsSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  return (
    <div aria-hidden="true">
      {Array.from({ length: renderCount }).map((_, i) => (
        <div
          key={i}
          className={`${pulseClass} box-border px-3 py-2.5 flex items-start gap-2.5`}
          style={{ height: `${RESOURCE_ITEM_HEIGHT_PX}px` }}
        >
          <div className="w-4 h-4 rounded-full bg-muted shrink-0 mt-px" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 h-6">
              <div className="h-4 bg-muted rounded flex-1" />
              {/* The loaded row's persistent 24×24 actions slot — reserve the
                  same box or the title bar shrinks the moment data lands. */}
              <div className="h-6 w-6 -me-1 bg-muted rounded shrink-0" />
            </div>
            <div className="flex items-center gap-1.5 mt-1 h-4">
              <div className="h-3 bg-muted rounded w-12" />
              <div className="h-3 bg-muted rounded w-16" />
              <div className="h-3 bg-muted rounded w-10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CommitListSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const showImmediate = useSkeletonGate(Boolean(immediate));
  const pulseClass = showImmediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

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
