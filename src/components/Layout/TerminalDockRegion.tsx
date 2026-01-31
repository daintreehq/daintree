import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { ContentDock } from "./ContentDock";
import { CompactDock } from "./CompactDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const {
    effectiveMode,
    shouldShowInLayout,
    dockedCount,
    density,
    isHydrated,
    shouldFadeForInput,
    compactMinimal,
  } = useDockRenderState();

  // Before hydration, show nothing to prevent flash of incorrect state
  if (!isHydrated) {
    return null;
  }

  const isCompactMode = effectiveMode === "compact";

  return (
    <DockPanelOffscreenContainer>
      {/* CompactDock for compact mode - minimal bar with inline status */}
      {isCompactMode && shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="CompactDock">
          <CompactDock
            dockedCount={dockedCount}
            shouldFadeForInput={shouldFadeForInput}
            ultraMinimal={compactMinimal}
          />
        </ErrorBoundary>
      )}

      {/* ContentDock for expanded mode - full dock with all features */}
      {!isCompactMode && shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density={density} />
        </ErrorBoundary>
      )}

      {/* Handle overlay for toggling between expanded and compact */}
      <DockHandleOverlay />
    </DockPanelOffscreenContainer>
  );
}
