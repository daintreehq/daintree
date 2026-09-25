import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";

interface BrowserPaneSkeletonProps {
  label?: string;
  /**
   * Draw the browser toolbar row (navigation, address bar, actions). Only the
   * browser pane has one; the file, diff and file-browser panes that share this
   * fallback get the panel header alone, so no navigation controls or address
   * field appear and then vanish when the real pane arrives.
   */
  toolbar?: boolean;
}

const CONTROL = "size-7 rounded-[var(--radius-md)]";

// Bones are immediate, not delayed: this renders as a Suspense fallback, which
// React already throttles ~300ms before commit (FALLBACK_THROTTLE_MS), so the
// anti-flicker gate is spent by the time it paints — see the #9040 note in
// useDeferredLoading.ts.
export function BrowserPaneSkeleton({
  label = "Loading browser panel",
  toolbar = true,
}: BrowserPaneSkeletonProps) {
  return (
    <div className="relative flex flex-col h-full w-full">
      <Skeleton label={label} className="flex flex-col h-full w-full">
        {/* Header row — PanelHeader's compact frame: h-8, px-3, kind icon + title, controls */}
        <div className="flex items-center justify-between px-3 shrink-0 h-8 border-b border-divider bg-surface">
          <div className="flex items-center gap-2">
            <SkeletonBone immediate className="size-3.5" />
            <SkeletonBone immediate className="h-2.5 w-24" />
          </div>
          <div className="flex items-center gap-1">
            <SkeletonBone immediate className="size-4" />
            <SkeletonBone immediate className="size-4" />
          </div>
        </div>

        {/* Toolbar row — BrowserToolbar's geometry: 28px controls, nav group gap-0.5, h-7 address bar */}
        {toolbar && (
          <div className="flex items-center gap-2 px-2 py-1.5 bg-surface border-b border-overlay shrink-0">
            <div className="flex items-center gap-0.5">
              <SkeletonBone immediate className={CONTROL} />
              <SkeletonBone immediate className={CONTROL} />
              <SkeletonBone immediate className={CONTROL} />
            </div>
            <SkeletonBone immediate className="h-7 flex-1 rounded-[var(--radius-md)]" />
            <div className="flex items-center gap-0.5">
              <SkeletonBone immediate className={CONTROL} />
              <SkeletonBone immediate className={CONTROL} />
            </div>
          </div>
        )}

        {/* Content area — the page is unknown, so it stays quiet: no bones, no animation */}
        <div className="flex-1 min-h-0 bg-surface-canvas" />
      </Skeleton>

      {/* Long-tail loading hint — a sibling of the status region, never inside it.
       * Stays invisible until 8s, then fades in. */}
      <SkeletonHint className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto" />
    </div>
  );
}
