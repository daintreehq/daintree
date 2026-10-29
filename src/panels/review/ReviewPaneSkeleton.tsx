import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { surfaceHeaderVariants } from "@/components/ui/SurfaceHeader";
import {
  REVIEW_HUB_HEADER_ROWS,
  REVIEW_HUB_HEADER_TOOLBAR,
  REVIEW_HUB_SECTION_BAND,
} from "@/components/Worktree/ReviewHub/reviewHubUtils";
import { cn } from "@/lib/utils";

// Bones are immediate, not delayed: this renders as a Suspense fallback, which
// React already throttles ~300ms before commit (FALLBACK_THROTTLE_MS), so the
// anti-flicker gate is spent by the time it paints — see the #9040 note in
// useDeferredLoading.ts.
export function ReviewPaneSkeleton() {
  const label = "Loading review panel";
  return (
    <div className="relative flex flex-col h-full w-full">
      <Skeleton label={label} className="flex flex-col h-full w-full bg-surface-canvas">
        {/* Header — matches ReviewHubContent: title, branch chip, and the
            diff-mode toggle beside them or on its own strip in a narrow pane,
            so the content below does not move when the hub arrives. */}
        <div className="@container/header shrink-0" aria-hidden="true">
          <div
            className={cn(
              surfaceHeaderVariants({ density: "compact" }),
              REVIEW_HUB_HEADER_ROWS,
              "grid-cols-[minmax(0,1fr)_auto] @max-[959px]/header:grid-cols-[minmax(0,1fr)]"
            )}
          >
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
              <SkeletonBone immediate className="h-4 w-32" />
              <SkeletonBone immediate className="h-5 w-24" />
            </div>
            <div className={REVIEW_HUB_HEADER_TOOLBAR}>
              <SkeletonBone immediate className="h-6 w-28" />
            </div>
          </div>
        </div>

        {/* Staged/unstaged section headers and file rows */}
        <div
          className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider shrink-0")}
          aria-hidden="true"
        >
          <SkeletonBone immediate className="h-3 w-16" />
          <SkeletonBone immediate className="h-3 w-8" />
        </div>
        <div className="flex flex-col gap-2 px-3 py-3 shrink-0" aria-hidden="true">
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="h-3.5 w-3.5" />
            <SkeletonBone immediate className="h-3 w-2/5" />
          </div>
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="h-3.5 w-3.5" />
            <SkeletonBone immediate className="h-3 w-1/3" />
          </div>
        </div>
        <div
          className={cn(REVIEW_HUB_SECTION_BAND, "border-y border-divider shrink-0")}
          aria-hidden="true"
        >
          <SkeletonBone immediate className="h-3 w-20" />
          <SkeletonBone immediate className="h-3 w-8" />
        </div>
        <div className="flex flex-col gap-2 px-3 py-3 shrink-0" aria-hidden="true">
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="h-3.5 w-3.5" />
            <SkeletonBone immediate className="h-3 w-1/2" />
          </div>
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="h-3.5 w-3.5" />
            <SkeletonBone immediate className="h-3 w-2/5" />
          </div>
        </div>

        {/* Remaining canvas — empty, no animation */}
        <div className="flex-1 min-h-0" aria-hidden="true" />
      </Skeleton>

      {/* Long-tail loading hint — sibling of role="status" so the live region
       * isn't silenced by aria-busy. */}
      <SkeletonHint className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto" />
    </div>
  );
}
