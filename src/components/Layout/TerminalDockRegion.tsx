import { useEffect, useRef } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { ContentDock } from "./ContentDock";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const { shouldShowInLayout, isHydrated, hasDocked } = useDockRenderState();
  const dockRegionRef = useRef<HTMLDivElement>(null);
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "dock");

  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("dock", hasDocked);
  }, [hasDocked]);

  useEffect(() => {
    useMacroFocusStore.getState().setRegionRef("dock", dockRegionRef.current);
    return () => useMacroFocusStore.getState().setRegionRef("dock", null);
  }, []);

  // Before hydration, show nothing to prevent flash of incorrect state
  if (!isHydrated) {
    return null;
  }

  return (
    <div
      ref={dockRegionRef}
      role="region"
      tabIndex={-1}
      aria-label="Dock bar"
      data-macro-focus={isMacroFocused ? "true" : undefined}
      className="outline-none data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-canopy-accent/60 data-[macro-focus=true]:ring-inset"
    >
      <DockPanelOffscreenContainer>
        {shouldShowInLayout && (
          <ErrorBoundary variant="section" componentName="ContentDock">
            <ContentDock density="normal" />
          </ErrorBoundary>
        )}
      </DockPanelOffscreenContainer>
    </div>
  );
}
