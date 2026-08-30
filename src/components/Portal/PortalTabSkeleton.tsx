import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

export function PortalTabSkeleton() {
  return (
    <Skeleton
      label="Loading tab"
      className="flex-1 flex flex-col gap-3 p-4 bg-surface-sidebar min-h-0"
    >
      <SkeletonBone className="h-5 w-2/3" />
      <SkeletonBone className="h-3 w-full" />
      <SkeletonBone className="h-3 w-11/12" />
      <SkeletonBone className="h-3 w-3/4" />
      <div className="h-2" aria-hidden="true" />
      <SkeletonBone className="h-3 w-full" />
      <SkeletonBone className="h-3 w-5/6" />
      <SkeletonBone className="h-3 w-2/3" />
    </Skeleton>
  );
}
