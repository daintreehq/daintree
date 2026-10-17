import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

// Nearly every Portal tab is a chat, so the silhouette is the end of a conversation
// settling onto its composer, in a column capped where chat pages clamp their own
// thread so the bones never stretch into stripes in a wide dock.
export function PortalTabSkeleton() {
  return (
    <Skeleton label="Loading tab" className="flex-1 flex flex-col p-4 bg-surface-sidebar min-h-0">
      <div className="flex-1 min-h-0 flex flex-col gap-6 mx-auto w-full max-w-3xl">
        <div className="flex-1 min-h-0 flex flex-col justify-end gap-6 overflow-hidden">
          <SkeletonBone className="h-8 w-2/3 max-w-sm self-end shrink-0 rounded-[var(--radius-md)]" />
          <div className="shrink-0 space-y-2.5">
            <SkeletonBone className="h-3 w-full" />
            <SkeletonBone className="h-3 w-5/6" />
            <SkeletonBone className="h-3 w-1/2" />
          </div>
        </div>
        <SkeletonBone className="h-10 w-full shrink-0 rounded-[var(--radius-2xl)]" />
      </div>
    </Skeleton>
  );
}
