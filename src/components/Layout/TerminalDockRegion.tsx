import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { ContentDock } from "./ContentDock";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const { shouldShowInLayout, isHydrated } = useDockRenderState();

  // Before hydration, show nothing to prevent flash of incorrect state
  if (!isHydrated) {
    return null;
  }

  return (
    <DockPanelOffscreenContainer>
      {shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density="normal" />
        </ErrorBoundary>
      )}
    </DockPanelOffscreenContainer>
  );
}
