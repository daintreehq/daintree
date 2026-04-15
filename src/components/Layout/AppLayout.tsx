import { useState, useCallback, useEffect, type ReactNode } from "react";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { TerminalDockRegion } from "./TerminalDockRegion";
import { DiagnosticsDock } from "../Diagnostics";
import { ErrorBoundary } from "../ErrorBoundary";
import { PortalDock, PortalVisibilityController } from "../Portal";
import { HelpPanel } from "../HelpPanel";
import { ProjectSwitchOverlay } from "@/components/Project";
import { ChordIndicator } from "./ChordIndicator";
import { DemoCursor, DemoOverlay } from "../Demo";

import { AllClearOverlay } from "../AllClearOverlay";
import { useDiagnosticsStore, useDockStore, type PanelState } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { useLayoutState } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";

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
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const currentProject = useProjectStore((state) => state.currentProject);
  const layout = useLayoutState();
  const showSidebar = !layout.isFocusMode && currentProject != null;

  useEffect(() => {
    if (layout.performanceMode) {
      document.body.setAttribute("data-performance-mode", "true");
    } else {
      document.body.removeAttribute("data-performance-mode");
    }
  }, [layout.performanceMode]);

  const handleToggleProblems = useCallback(() => {
    const dock = useDiagnosticsStore.getState();
    if (!dock.isOpen || dock.activeTab !== "problems") {
      layout.openDiagnosticsDock("problems");
    } else {
      layout.setDiagnosticsOpen(false);
    }
  }, [layout.openDiagnosticsDock, layout.setDiagnosticsOpen]);

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
      } catch (error) {
        console.error("Failed to restore app state:", error);
      }
    };
    restoreState();
  }, []);

  useEffect(() => {
    if (layout.isFocusMode) return;

    const persistSidebarWidth = async () => {
      try {
        await appClient.setState({ sidebarWidth });
      } catch (error) {
        console.error("Failed to persist sidebar width:", error);
      }
    };

    const timer = setTimeout(persistSidebarWidth, 300);
    return () => clearTimeout(timer);
  }, [sidebarWidth, layout.isFocusMode]);

  useEffect(() => {
    // Gate persistence until hydration completes and project switching ends
    // to avoid overwriting restored focus mode during initial load or project switches
    if (!isHydrated) {
      return;
    }

    const persistFocusMode = async () => {
      // Persist focus mode to per-project state if a project is active
      if (!currentProject?.id) {
        // No project - fall back to global state for backward compatibility
        try {
          await appClient.setState({ focusMode: layout.isFocusMode });
        } catch (error) {
          console.error("Failed to persist focus mode to global state:", error);
        }
        return;
      }

      try {
        await window.electron.project.setFocusMode(
          currentProject.id,
          layout.isFocusMode,
          layout.savedPanelState as PanelState | undefined
        );
      } catch (error) {
        console.error("Failed to persist focus mode to project state:", error);
      }
    };

    const timer = setTimeout(persistFocusMode, 100);
    return () => clearTimeout(timer);
  }, [layout.isFocusMode, layout.savedPanelState, currentProject?.id, isHydrated]);

  const handleToggleFocusMode = useCallback(async () => {
    if (layout.isFocusMode) {
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
          console.error("Failed to clear focus panel state:", error);
        }
      } else {
        // Fall back to global state if no project
        try {
          await appClient.setState({ focusPanelState: undefined });
        } catch (error) {
          console.error("Failed to clear focus panel state:", error);
        }
      }
    } else {
      const currentPanelState: PanelState = {
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      };
      layout.toggleFocusMode(currentPanelState);
      // Persist to per-project state
      if (currentProject?.id) {
        try {
          await window.electron.project.setFocusMode(currentProject.id, true, currentPanelState);
        } catch (error) {
          console.error("Failed to persist focus panel state:", error);
        }
      } else {
        // Fall back to global state if no project
        try {
          await appClient.setState({ focusPanelState: currentPanelState });
        } catch (error) {
          console.error("Failed to persist focus panel state:", error);
        }
      }
    }
  }, [
    layout.isFocusMode,
    layout.savedPanelState,
    layout.toggleFocusMode,
    layout.diagnosticsOpen,
    sidebarWidth,
    currentProject?.id,
  ]);

  useEffect(() => {
    const handleFocusModeToggle = () => {
      handleToggleFocusMode();
    };

    window.addEventListener("daintree:toggle-focus-mode", handleFocusModeToggle);
    return () => {
      window.removeEventListener("daintree:toggle-focus-mode", handleFocusModeToggle);
    };
  }, [handleToggleFocusMode]);

  useEffect(() => {
    const handlePortalToggle = () => {
      layout.togglePortal();
    };

    window.addEventListener("daintree:toggle-portal", handlePortalToggle);
    return () => window.removeEventListener("daintree:toggle-portal", handlePortalToggle);
  }, [layout.togglePortal]);

  useEffect(() => {
    const handleResetSidebarWidth = () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    window.addEventListener("daintree:reset-sidebar-width", handleResetSidebarWidth);
    return () =>
      window.removeEventListener("daintree:reset-sidebar-width", handleResetSidebarWidth);
  }, []);

  // Sync macro focus region visibility from layout state
  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("sidebar", showSidebar);
  }, [showSidebar]);

  useEffect(() => {
    useMacroFocusStore.getState().setVisibility("portal", layout.portalOpen);
  }, [layout.portalOpen]);

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

  const effectiveSidebarWidth = layout.isFocusMode ? 0 : sidebarWidth;

  useEffect(() => {
    const offset = layout.portalOpen ? `${layout.portalWidth}px` : "0px";
    document.body.style.setProperty("--portal-right-offset", offset);

    return () => {
      document.body.style.removeProperty("--portal-right-offset");
    };
  }, [layout.portalOpen, layout.portalWidth]);

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
      <Toolbar
        onLaunchAgent={handleLaunchAgent}
        onSettings={handleSettings}
        onPreloadSettings={onPreloadSettings}
        errorCount={layout.errorCount}
        onToggleProblems={handleToggleProblems}
        isFocusMode={layout.isFocusMode}
        onToggleFocusMode={handleToggleFocusMode}
        agentAvailability={agentAvailability}
        agentSettings={agentSettings}
        projectSwitcherPalette={projectSwitcherPalette}
      />
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div
          className="flex-1 flex overflow-hidden"
          style={{ flex: 1, display: "flex", overflow: "hidden" }}
        >
          {showSidebar && (
            <ErrorBoundary variant="section" componentName="Sidebar">
              <Sidebar width={effectiveSidebarWidth} onResize={handleSidebarResize}>
                {sidebarContent}
              </Sidebar>
            </ErrorBoundary>
          )}
          <ErrorBoundary variant="section" componentName="MainContent">
            <main
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
              {layout.helpPanelOpen && (
                <ErrorBoundary variant="section" componentName="HelpPanel">
                  <div
                    className="absolute top-0 bottom-0 z-40"
                    style={{
                      right: layout.portalOpen ? `${layout.portalWidth}px` : "0px",
                    }}
                  >
                    <HelpPanel />
                  </div>
                </ErrorBoundary>
              )}
              {layout.portalOpen && (
                <ErrorBoundary variant="section" componentName="PortalDock">
                  <div className="absolute right-0 top-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border">
                    <PortalDock />
                  </div>
                </ErrorBoundary>
              )}
            </main>
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
      {window.electron?.demo && (
        <>
          <DemoOverlay />
          <DemoCursor />
        </>
      )}
    </div>
  );
}
