import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";

/**
 * The rendered layout's loading body. One component for all three waits — the
 * lazy chunk, the whole-file read and the comparison itself — so a document
 * that passes through each in turn shows one continuous skeleton rather than
 * three that swap under the reader.
 */
export function RenderedMarkdownDiffSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton label="Loading rendered Markdown">
        <SkeletonBone className="h-7 w-3/4" />
        <SkeletonText lines={8} />
      </Skeleton>
    </div>
  );
}
