import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useDockStore } from "@/store";
import { ContentDock } from "./ContentDock";
import { CompactDock } from "./CompactDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockStatusOverlay } from "./DockStatusOverlay";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const {
    effectiveMode,
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

  const isCompactMode = effectiveMode === "compact";

  return (
    <DockPanelOffscreenContainer>
      {/* CompactDock for compact mode - minimal bar with inline status */}
      {isCompactMode && shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="CompactDock">
          <CompactDock dockedCount={dockedCount} shouldFadeForInput={shouldFadeForInput} />
        </ErrorBoundary>
      )}

      {/* ContentDock for expanded mode - full dock with all features */}
      {!isCompactMode && shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density={density} />
        </ErrorBoundary>
      )}

      {/* Handle overlay is visible in expanded and hidden modes (compact has its own expand button) */}
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
