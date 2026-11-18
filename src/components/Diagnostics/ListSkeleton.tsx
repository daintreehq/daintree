import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";

const WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"] as const;

/**
 * Row-shaped placeholder for a diagnostics list whose first read is still in flight.
 * Callers mount it only while that read is pending, so the onset gate starts at
 * mount: a read that settles inside the gate unmounts it before anything paints.
 * The bones are `immediate`: the gate already owns the onset, and the default
 * 400ms delayed reveal would stack on it and hold the rows invisible until ~600ms.
 */
export function ListSkeleton({ label }: { label: string }) {
  const visible = useSkeletonGate(true);
  if (!visible) return null;
  return (
    <Skeleton label={label} className="flex flex-col gap-2.5 px-3 py-2.5">
      {WIDTHS.map((width, i) => (
        <SkeletonBone key={i} immediate className={`h-3 rounded-[var(--radius-sm)] ${width}`} />
      ))}
    </Skeleton>
  );
}
