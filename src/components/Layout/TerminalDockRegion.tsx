import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useDockStore } from "@/store";
import { ContentDock } from "./ContentDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockStatusOverlay } from "./DockStatusOverlay";

export function TerminalDockRegion() {
  const {
    shouldShowInLayout,
    showStatusOverlay,
    effectiveMode,
    hasDocked,
    dockedCount,
    density,
    isHydrated,
    waitingCount,
    failedCount,
    trashedCount,
  } = useDockRenderState();

  const setMode = useDockStore((state) => state.setMode);

  // Before hydration, only show the handle overlay to prevent flash of incorrect state
  if (!isHydrated) {
    return <DockHandleOverlay />;
  }

  return (
    <>
      {/* ContentDock in layout when visible */}
      {shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density={density} />
        </ErrorBoundary>
      )}

      {/* Handle overlay is always visible at bottom edge for discoverability */}
      <DockHandleOverlay />

      {/* Status overlay when dock is hidden but has status counts */}
      {showStatusOverlay && (
        <DockStatusOverlay
          waitingCount={waitingCount}
          failedCount={failedCount}
          trashedCount={trashedCount}
        />
      )}

      {/* Peek indicator bar when dock is hidden with docked terminals */}
      {effectiveMode === "hidden" && hasDocked && !shouldShowInLayout && (
        <button
          type="button"
          className="absolute bottom-0 left-0 right-0 h-1 bg-canopy-accent/60
                     cursor-pointer hover:h-2 focus-visible:h-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent
                     transition-[height,background-color,outline] duration-200 z-40"
          onClick={() => setMode("expanded")}
          title={`${dockedCount} terminal${dockedCount > 1 ? "s" : ""} in dock`}
          aria-label={`Show ${dockedCount} hidden terminal${dockedCount > 1 ? "s" : ""}`}
        />
      )}
    </>
  );
}
