import { useEffect, useRef } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDockRenderState } from "@/hooks/useDockRenderState";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { ContentDock } from "./ContentDock";
import { DockPanelOffscreenContainer } from "./DockPanelOffscreenContainer";

export function TerminalDockRegion() {
  const { shouldShowInLayout, isHydrated, hasDocked, hasStatus } = useDockRenderState();
  const dockRegionRef = useRef<HTMLElement>(null);
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "dock");
  const dockDensity = usePreferencesStore((state) => state.dockDensity);
  const shouldInertDock = !hasDocked && !hasStatus;

  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("dock", hasDocked);
    return () => useMacroFocusStore.getState().setVisibility("dock", false);
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
    <aside
      ref={dockRegionRef}
      // When the dock is empty, drop the landmark role/name so screen readers
      // don't announce a dead-end "Dock" region. `role="none"` strips the
      // landmark without affecting descendants — unlike `inert`, the always-
      // rendered launch button and right-click menu stay interactive so users
      // can still spawn an agent from an empty dock.
      role={shouldInertDock ? "none" : "region"}
      tabIndex={-1}
      aria-label={shouldInertDock ? undefined : "Dock"}
      data-macro-focus={isMacroFocused ? "true" : undefined}
      className="outline-hidden data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset"
    >
      <DockPanelOffscreenContainer>
        {shouldShowInLayout && (
          <ErrorBoundary variant="section" componentName="ContentDock">
            <ContentDock density={dockDensity} />
          </ErrorBoundary>
        )}
      </DockPanelOffscreenContainer>
    </aside>
  );
}
