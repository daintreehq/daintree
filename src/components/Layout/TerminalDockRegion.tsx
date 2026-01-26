import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useDockStore } from "@/store";
import { ContentDock } from "./ContentDock";
import { CompactDock } from "./CompactDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockColorStrip } from "./DockColorStrip";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const {
    effectiveMode,
    shouldShowInLayout,
    showColorStrip,
    dockedCount,
    density,
    isHydrated,
    shouldFadeForInput,
    compactMinimal,
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

      {/* Handle overlay is visible in expanded and hidden modes (compact has its own expand button) */}
      <DockHandleOverlay />

      {/* Color strip when dock is hidden but has status counts or docked panels */}
      {showColorStrip && <DockColorStrip onExpandDock={() => setMode("expanded")} />}
    </DockPanelOffscreenContainer>
  );
}
