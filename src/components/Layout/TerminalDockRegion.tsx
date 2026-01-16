import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useDockStore } from "@/store";
import { ContentDock } from "./ContentDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockStatusOverlay } from "./DockStatusOverlay";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const {
    shouldShowInLayout,
    showStatusOverlay,
    dockedCount,
    density,
    isHydrated,
    waitingCount,
    failedCount,
    trashedCount,
    shouldFadeForInput,
  } = useDockRenderState();

  const setMode = useDockStore((state) => state.setMode);

  // Before hydration, only show the handle overlay to prevent flash of incorrect state
  if (!isHydrated) {
    return <DockHandleOverlay />;
  }

  return (
    <DockPanelOffscreenContainer>
      {/* ContentDock in layout when visible */}
      {shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density={density} />
        </ErrorBoundary>
      )}

      {/* Handle overlay is always visible at bottom edge for discoverability */}
      <DockHandleOverlay />

      {/* Status overlay when dock is hidden but has status counts or docked panels */}
      {showStatusOverlay && (
        <DockStatusOverlay
          waitingCount={waitingCount}
          failedCount={failedCount}
          trashedCount={trashedCount}
          dockedCount={dockedCount}
          onExpandDock={() => setMode("expanded")}
          shouldFadeForInput={shouldFadeForInput}
        />
      )}
    </DockPanelOffscreenContainer>
  );
}
