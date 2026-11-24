import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { REVIEW_HUB_SECTION_BAND } from "./reviewHubUtils";

const ROW_WIDTHS = ["w-48", "w-32", "w-56", "w-24", "w-40", "w-36", "w-52", "w-28"];

/**
 * The loading shape of a Review Hub comparison list (vs the base branch, since
 * review): a band and eight file rows. One composition for both, so switching
 * modes while either loads doesn't jump between two treatments. Callers gate it;
 * the bones are `immediate` because the gate already absorbed the threshold.
 */
export function ReviewHubListSkeleton({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <>
      <Skeleton label={label}>
        {/* The loaded band's label is `text-2xs` on the inherited 1.5 leading, so
            its line is 16.5px, not a whole 16: bones take one line height so the
            list below doesn't shift when the real band lands. */}
        <div
          data-testid="review-hub-list-skeleton-band"
          className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider text-2xs")}
        >
          <div className="flex items-center gap-1.5">
            <SkeletonBone immediate className="h-[1lh] w-32" />
            <SkeletonBone immediate className="h-[1lh] w-8" />
          </div>
        </div>
        <div className="px-2 py-1 flex flex-col gap-0.5">
          {ROW_WIDTHS.map((width) => (
            <div key={width} className="flex items-center gap-2 px-1.5 py-1.5">
              <SkeletonBone immediate className="h-4 w-4 shrink-0 rounded-sm" />
              <SkeletonBone immediate className={cn("h-2.5", width)} />
            </div>
          ))}
        </div>
      </Skeleton>
      <SkeletonHint className="px-3 py-2" onRetry={onRetry} />
    </>
  );
}
