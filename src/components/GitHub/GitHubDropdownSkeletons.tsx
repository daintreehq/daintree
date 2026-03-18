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

export function GitHubResourceListSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading GitHub results">
      <span className="sr-only">Loading GitHub results</span>
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
