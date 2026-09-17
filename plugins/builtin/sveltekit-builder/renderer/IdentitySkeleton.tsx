import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

/**
 * The identity block's shape, held while its source is being resolved.
 *
 * The loading contract makes a skeleton mandatory past one second, and resolving
 * an element's source can take that long on a cold dev server. A spinner row was
 * standing in for the whole block, so a slow resolve replaced a desktop
 * inspector with a single status line and then jumped back to a full panel —
 * two layout shifts where the contract asks for none.
 *
 * The shape is exactly `SelectionIdentity`'s: a badge and label row, a path
 * line, a trail line.
 */
export function IdentitySkeleton({ label }: { label?: string }) {
  return (
    <Skeleton
      label={label ?? "Finding the source for this element"}
      className="flex flex-col gap-1"
    >
      {/* 28 / 24 / 20: the identity's three rows, so the sections below land
          in the same place when the answer arrives. */}
      <div className="flex h-7 items-center gap-2">
        <SkeletonBone heightPx={18} className="w-14 rounded-[var(--radius-sm)]" />
        <SkeletonBone heightPx={14} className="w-32 rounded-[var(--radius-sm)]" />
      </div>
      <div className="flex h-6 items-center">
        <SkeletonBone heightPx={11} className="w-48 rounded-[var(--radius-sm)]" />
      </div>
      <div className="flex h-5 items-center">
        <SkeletonBone heightPx={11} className="w-28 rounded-[var(--radius-sm)]" />
      </div>
    </Skeleton>
  );
}
