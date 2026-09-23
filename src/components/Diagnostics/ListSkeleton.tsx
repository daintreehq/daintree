import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

const WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"] as const;

/** Row-shaped placeholder for a diagnostics list whose first read is still in flight. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <Skeleton label={label} className="flex flex-col gap-2.5 px-3 py-2.5">
      {WIDTHS.map((width, i) => (
        <SkeletonBone key={i} className={`h-3 rounded-[var(--radius-sm)] ${width}`} />
      ))}
    </Skeleton>
  );
}
