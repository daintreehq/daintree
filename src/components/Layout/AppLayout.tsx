import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { TerminalDockRegion } from "./TerminalDockRegion";
import { DiagnosticsDock } from "../Diagnostics";
import { ErrorBoundary } from "../ErrorBoundary";
import { PortalDock, PortalVisibilityController } from "../Portal";
import { HelpPanel } from "../HelpPanel";
import { ThemeBrowser } from "../ThemeBrowser";
import { ProjectSwitchOverlay } from "@/components/Project";
import { FleetArmingRibbon } from "@/components/Fleet";
import { ChordIndicator } from "./ChordIndicator";
import { DemoCaptureBridge, DemoCursor, DemoOverlay } from "../Demo";

import { AllClearOverlay } from "../AllClearOverlay";
import {
  useDiagnosticsStore,
  useDockStore,
  useFocusStore,
  usePreferencesStore,
  useUIStore,
  type PanelState,
} from "@/store";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useProjectStore } from "@/store/projectStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { useCcrPresetsSubscription } from "@/hooks/useCcrPresetsSubscription";
import { useProjectPresetsSubscription } from "@/hooks/useProjectPresetsSubscription";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { useLayoutState } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { logError } from "@/utils/logger";

interface AppLayoutProps {
  children?: ReactNode;
  sidebarContent?: ReactNode;
  onLaunchAgent?: (type: string) => void;
  onSettings?: () => void;
  onPreloadSettings?: () => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
  isHydrated?: boolean;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
}

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;
export const DEFAULT_SIDEBAR_WIDTH = 350;

export function AppLayout({
  children,
  sidebarContent,
  onLaunchAgent,
  onSettings,
  onPreloadSettings,
  onRetry,
  onCancelRetry,
  agentAvailability,
  agentSettings,
  isHydrated = true,
  projectSwitcherPalette,
}: AppLayoutProps) {
  useCcrPresetsSubscription();
  useProjectPresetsSubscription();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const currentProject = useProjectStore((state) => state.currentProject);
  const layout = useLayoutState();
  const overlayClaims = useUIStore((s) => s.overlayClaims);
  const isThemeBrowserOpen = overlayClaims.has("theme-browser");
  const themeBrowserOpen = useThemeBrowserStore((s) => s.isOpen);
  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);
  const showSidebar = !layout.gestureSidebarHidden && currentProject != null;
  const showAssistant = !layout.gestureAssistantHidden && layout.helpPanelOpen;
  const effectiveAssistantWidth = showAssistant ? layout.helpPanelWidth : 0;

  useEffect(() => {
    if (layout.performanceMode) {
      document.body.setAttribute("data-performance-mode", "true");
    } else {
      document.body.removeAttribute("data-performance-mode");
    }
  }, [layout.performanceMode]);

  useEffect(() => {
    if (reduceAnimations) {
      document.body.setAttribute("data-reduce-animations", "true");
    } else {
      document.body.removeAttribute("data-reduce-animations");
    }
    return () => {
      document.body.removeAttribute("data-reduce-animations");
    };
  }, [reduceAnimations]);

  const handleToggleProblems = () => {
    const dock = useDiagnosticsStore.getState();
    if (!dock.isOpen || dock.activeTab !== "problems") {
      layout.openDiagnosticsDock("problems");
    } else {
      layout.setDiagnosticsOpen(false);
    }
  };

  useEffect(() => {
    const restoreState = async () => {
      try {
        const appState = await appClient.getState();
        if (appState.sidebarWidth != null) {
          const clampedWidth = Math.min(
            Math.max(appState.sidebarWidth, MIN_SIDEBAR_WIDTH),
            MAX_SIDEBAR_WIDTH
          );
          setSidebarWidth(clampedWidth);
        }
        // Note: Focus mode is now restored via hydration callback (setFocusMode in HydrationCallbacks)
        // which reads per-project focus mode state. This ensures each project has its own focus mode.
        useDockStore.getState().hydrate({
          popoverHeight: appState.dockedPopoverHeight,
        });
        useFleetScopeFlagStore.getState().hydrate(appState.fleetScopeMode);
      } catch (error) {
        logError("Failed to restore app state", error);
      }
    };
    restoreState();
  }, []);

  useEffect(() => {
    if (layout.gestureSidebarHidden) return;
    // Skip until hydration completes — the pre-hydration mount uses the
    // default 350px and would otherwise overwrite the persisted value before
    // restoreState() reads it back.
    if (!isHydrated) return;

    const persistSidebarWidth = async () => {
      try {
        await appClient.setState({ sidebarWidth });
      } catch (error) {
        logError("Failed to persist sidebar width", error);
      }
    };

    const timer = setTimeout(persistSidebarWidth, 300);
    return () => clearTimeout(timer);
  }, [sidebarWidth, layout.gestureSidebarHidden, isHydrated]);

  useEffect(() => {
    // Gate persistence until hydration completes and project switching ends
    // to avoid overwriting restored focus mode during initial load or project switches
    if (!isHydrated) {
      return;
    }

    // Persist worktree-sidebar suppression as the legacy `focusMode` boolean.
    // The assistant's own visibility is owned by `helpPanelStore.isOpen` (its
    // own persisted store), so it doesn't need to round-trip through the
    // per-project focus state.
    const persistedFocusMode = layout.gestureSidebarHidden;

    const persistFocusMode = async () => {
      // Persist focus mode to per-project state if a project is active
      if (!currentProject?.id) {
        // No project - fall back to global state for backward compatibility
        try {
          await appClient.setState({ focusMode: persistedFocusMode });
        } catch (error) {
          logError("Failed to persist focus mode to global state", error);
        }
        return;
      }

      try {
        await window.electron.project.setFocusMode(
          currentProject.id,
          persistedFocusMode,
          layout.savedPanelState as PanelState | undefined
        );
      } catch (error) {
        logError("Failed to persist focus mode to project state", error);
      }
    };

    const timer = setTimeout(persistFocusMode, 100);
    return () => clearTimeout(timer);
  }, [layout.gestureSidebarHidden, layout.savedPanelState, currentProject?.id, isHydrated]);

  const handleToggleFocusMode = async () => {
    // Gesture-active signal is "snapshot present", not the combined
    // isFocusMode flag — that flag also flips when the Toolbar button hides
    // only the worktree sidebar, and using it here would treat that single
    // toolbar action as a gesture exit (clearing the sidebar gesture instead
    // of entering the gesture and hiding the assistant).
    const gestureActive = useFocusStore.getState().gestureSnapshot !== null;
    if (gestureActive) {
      if (layout.savedPanelState) {
        setSidebarWidth((layout.savedPanelState as PanelState).sidebarWidth);
      }
      layout.toggleFocusMode({
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      } as PanelState);
      // Persist to per-project state
      if (currentProject?.id) {
        try {
          await window.electron.project.setFocusMode(currentProject.id, false, undefined);
        } catch (error) {
          logError("Failed to clear focus panel state", error);
        }
      } else {
        // Fall back to global state if no project
        try {
          await appClient.setState({ focusPanelState: undefined });
        } catch (error) {
          logError("Failed to clear focus panel state", error);
        }
      }
    } else {
      const currentPanelState: PanelState = {
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      };
      layout.toggleFocusMode(currentPanelState, {
        sidebarVisible: showSidebar,
        assistantVisible: showAssistant,
      });
      // Persist to per-project state — only when something actually changed.
      // toggleFocusMode is a no-op if neither sidebar was visible.
      const persistFocusMode = useFocusStore.getState().isFocusMode || showSidebar || showAssistant;
      if (!persistFocusMode) return;
      if (currentProject?.id) {
        try {
          await window.electron.project.setFocusMode(currentProject.id, true, currentPanelState);
        } catch (error) {
          logError("Failed to persist focus panel state", error);
        }
      } else {
        // Fall back to global state if no project
        try {
          await appClient.setState({ focusPanelState: currentPanelState });
        } catch (error) {
          logError("Failed to persist focus panel state", error);
        }
      }
    }
  };

  const handleToggleFocusModeRef = useRef(handleToggleFocusMode);
  useEffect(() => {
    handleToggleFocusModeRef.current = handleToggleFocusMode;
  });

  // Worktree-sidebar-only toggle (Toolbar button + nav.toggleSidebar action).
  // Independent from the assistant: clicking this button hides/shows only the
  // worktree sidebar, leaving the Daintree Assistant untouched.
  const handleToggleSidebar = useCallback(() => {
    suppressSidebarResizes();
    const focus = useFocusStore.getState();
    focus.setSidebarGestureHidden(!focus.gestureSidebarHidden, {
      sidebarWidth,
      diagnosticsOpen: layout.diagnosticsOpen,
    });
  }, [sidebarWidth, layout.diagnosticsOpen]);

  const handleToggleSidebarRef = useRef(handleToggleSidebar);
  useEffect(() => {
    handleToggleSidebarRef.current = handleToggleSidebar;
  });

  useEffect(() => {
    const handleSidebarToggle = () => {
      if (useUIStore.getState().hasOpenOverlays()) return;
      handleToggleSidebarRef.current();
    };

    window.addEventListener("daintree:toggle-sidebar", handleSidebarToggle);
    return () => {
      window.removeEventListener("daintree:toggle-sidebar", handleSidebarToggle);
    };
  }, []);

  useEffect(() => {
    const handleFocusModeToggle = () => {
      if (useUIStore.getState().hasOpenOverlays()) return;
      suppressSidebarResizes();
      void handleToggleFocusModeRef.current();
    };

    window.addEventListener("daintree:toggle-focus-mode", handleFocusModeToggle);
    return () => {
      window.removeEventListener("daintree:toggle-focus-mode", handleFocusModeToggle);
    };
  }, []);

  useEffect(() => {
    const handlePortalToggle = () => {
      if (useUIStore.getState().hasOpenOverlays()) return;
      layout.togglePortal();
    };

    window.addEventListener("daintree:toggle-portal", handlePortalToggle);
    return () => window.removeEventListener("daintree:toggle-portal", handlePortalToggle);
  }, [layout.togglePortal]);

  useEffect(() => {
    const handleResetSidebarWidth = () => {
      if (useUIStore.getState().hasOpenOverlays()) return;
      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    };
    window.addEventListener("daintree:reset-sidebar-width", handleResetSidebarWidth);
    return () =>
      window.removeEventListener("daintree:reset-sidebar-width", handleResetSidebarWidth);
  }, []);

  useEffect(() => {
    // Bridge for stores that need to suppress xterm resize events without
    // pulling sidebarToggle directly (avoids circular imports — sidebarToggle
    // reads worktree state). Stores dispatch this event; AppLayout invokes
    // the suppression helper that knows about both grid panels and the
    // assistant terminal.
    const handleSuppress = () => suppressSidebarResizes();
    window.addEventListener("daintree:suppress-sidebar-resizes", handleSuppress);
    return () => window.removeEventListener("daintree:suppress-sidebar-resizes", handleSuppress);
  }, []);

  // Sync macro focus region visibility from layout state
  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("sidebar", showSidebar);
  }, [showSidebar]);

  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("portal", layout.portalOpen);
  }, [layout.portalOpen]);

  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("assistant", showAssistant);
  }, [showAssistant]);

  // Clear macro focus on mouse interaction
  useEffect(() => {
    const handleMouseDown = () => useMacroFocusStore.getState().clearFocus();
    window.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => window.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, []);

  useEffect(() => {
    if (!layout.portalOpen) {
      window.electron.portal.hide();
    }
  }, [layout.portalOpen]);

  const handleSidebarResize = useCallback((newWidth: number) => {
    const clampedWidth = Math.min(Math.max(newWidth, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
    setSidebarWidth(clampedWidth);
  }, []);

  const handleLaunchAgent = useCallback(
    (type: string) => {
      onLaunchAgent?.(type);
    },
    [onLaunchAgent]
  );

  const handleSettings = useCallback(() => {
    onSettings?.();
  }, [onSettings]);

  const effectiveSidebarWidth = layout.gestureSidebarHidden ? 0 : sidebarWidth;

  useEffect(() => {
    const portalOffset = layout.portalOpen ? layout.portalWidth : 0;
    // Portal overlays the Assistant when both are open, so the rightmost fixed
    // obstruction is the wider of the two — not their sum. Toaster, popovers,
    // dropdowns, ReEntrySummary, and GettingStartedChecklist all read this var.
    const totalOffset = Math.max(portalOffset, effectiveAssistantWidth);
    document.body.style.setProperty("--portal-right-offset", `${totalOffset}px`);

    return () => {
      document.body.style.removeProperty("--portal-right-offset");
    };
  }, [layout.portalOpen, layout.portalWidth, effectiveAssistantWidth]);

  return (
    <div
      className="h-screen flex flex-col bg-daintree-bg"
      style={{
        height: "100vh",
        width: "100vw",
        backgroundColor: "var(--color-daintree-bg)",
        display: "flex",
        flexDirection: "column",
        color: "var(--color-daintree-text)",
      }}
    >
      <PortalVisibilityController />
      <div {...(isThemeBrowserOpen ? { inert: true } : {})}>
        <Toolbar
          onLaunchAgent={handleLaunchAgent}
          onSettings={handleSettings}
          onPreloadSettings={onPreloadSettings}
          errorCount={layout.errorCount}
          onToggleProblems={handleToggleProblems}
          isFocusMode={layout.gestureSidebarHidden}
          onToggleFocusMode={handleToggleSidebar}
          agentAvailability={agentAvailability}
          agentSettings={agentSettings}
          projectSwitcherPalette={projectSwitcherPalette}
        />
        <FleetArmingRibbon />
      </div>
      <div
        {...(isThemeBrowserOpen ? { inert: true } : {})}
        className="flex-1 flex flex-col overflow-hidden"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div
          className="flex-1 flex overflow-hidden"
          style={{ flex: 1, display: "flex", overflow: "hidden" }}
        >
          {currentProject != null && (
            <ErrorBoundary variant="section" componentName="Sidebar">
              <Sidebar width={effectiveSidebarWidth} onResize={handleSidebarResize}>
                {sidebarContent}
              </Sidebar>
            </ErrorBoundary>
          )}
          <ErrorBoundary variant="section" componentName="MainContent">
            <main
              aria-label="Content"
              className="flex-1 flex flex-col overflow-hidden bg-daintree-bg relative"
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                backgroundColor: "var(--color-daintree-bg)",
              }}
            >
              <div className="flex-1 overflow-hidden min-h-0">{children}</div>
              {/* Terminal Dock Region - manages dock visibility and overlays */}
              <TerminalDockRegion />
            </main>
          </ErrorBoundary>
          <ErrorBoundary variant="section" componentName="HelpPanel">
            <HelpPanel width={effectiveAssistantWidth} />
          </ErrorBoundary>
        </div>
        {/* Unified diagnostics dock replaces LogsPanel, EventInspectorPanel, and ProblemsPanel */}
        <ErrorBoundary variant="section" componentName="DiagnosticsDock">
          <DiagnosticsDock onRetry={onRetry} onCancelRetry={onCancelRetry} />
        </ErrorBoundary>
      </div>

      <ProjectSwitchOverlay isSwitching={false} projectName={undefined} />
      <ChordIndicator />

      <AllClearOverlay />
      {themeBrowserOpen &&
        createPortal(
          <>
            <div
              aria-hidden="true"
              className="fixed inset-0 z-30 bg-scrim-soft/30 transition-[backdrop-filter] duration-150 hover:backdrop-blur-[2px]"
            />
            <ErrorBoundary
              variant="section"
              componentName="ThemeBrowser"
              onError={() => useThemeBrowserStore.getState().close()}
            >
              <div
                className="fixed inset-y-0 z-40 pointer-events-auto"
                style={{
                  right: "var(--portal-right-offset, 0px)",
                }}
              >
                <ThemeBrowser />
              </div>
            </ErrorBoundary>
          </>,
          document.body
        )}
      {layout.portalOpen &&
        createPortal(
          <ErrorBoundary variant="section" componentName="PortalDock">
            {/* inert mirrors the toolbar / main-content wrappers: when the
                ThemeBrowser overlay is open, the Portal's React chrome (tabs,
                toolbar, resize handle) must not be interactive. The native
                WebContentsView is already hidden via PortalVisibilityController. */}
            <div
              {...(isThemeBrowserOpen ? { inert: true } : {})}
              className="fixed top-0 right-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border"
            >
              <PortalDock />
            </div>
          </ErrorBoundary>,
          document.body
        )}
      {window.electron?.demo && (
        <>
          <DemoOverlay />
          <DemoCursor />
          <DemoCaptureBridge />
        </>
      )}
    </div>
  );
}
