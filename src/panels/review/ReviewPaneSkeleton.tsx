import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";

// Bones are immediate, not delayed: this renders as a Suspense fallback, which
// React already throttles ~300ms before commit (FALLBACK_THROTTLE_MS), so the
// anti-flicker gate is spent by the time it paints — see the #9040 note in
// useDeferredLoading.ts.
export function ReviewPaneSkeleton() {
  const label = "Loading review panel";
  return (
    <div className="relative flex flex-col h-full w-full">
      <Skeleton label={label} className="flex flex-col h-full w-full bg-daintree-bg">
        {/* Header — matches ReviewHubContent: title, branch chip, diff-mode toggle */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-divider shrink-0"
          aria-hidden="true"
        >
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="h-4 w-32" />
            <SkeletonBone immediate className="h-5 w-24" />
          </div>
          <SkeletonBone immediate className="h-6 w-28" />
        </div>

        {/* Staged/unstaged section headers and file rows */}
        <div
          className="flex items-center justify-between px-4 py-2 bg-overlay-subtle border-b border-divider shrink-0"
          aria-hidden="true"
        >
          <SkeletonBone immediate className="h-3 w-16" />
          <SkeletonBone immediate className="h-3 w-8" />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3 shrink-0" aria-hidden="true">
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
          className="flex items-center justify-between px-4 py-2 bg-overlay-subtle border-y border-divider shrink-0"
          aria-hidden="true"
        >
          <SkeletonBone immediate className="h-3 w-20" />
          <SkeletonBone immediate className="h-3 w-8" />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3 shrink-0" aria-hidden="true">
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
      <SkeletonHint className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto" />
    </div>
  );
}
