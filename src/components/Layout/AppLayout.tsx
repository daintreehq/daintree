import { useState, useCallback, useEffect, type ReactNode } from "react";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { TerminalDockRegion } from "./TerminalDockRegion";
import { DiagnosticsDock } from "../Diagnostics";
import { ErrorBoundary } from "../ErrorBoundary";
import { SidecarDock, SidecarVisibilityController } from "../Sidecar";
import { ProjectSettingsDialog, ProjectSwitchOverlay } from "@/components/Project";
import { useDiagnosticsStore, useDockStore, type PanelState } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { useLayoutState } from "@/hooks";

interface AppLayoutProps {
  children?: ReactNode;
  sidebarContent?: ReactNode;
  onLaunchAgent?: (
    type: "claude" | "gemini" | "codex" | "opencode" | "terminal" | "browser"
  ) => void;
  onSettings?: () => void;
  onOpenAgentSettings?: () => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
  isHydrated?: boolean;
}

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;
export const DEFAULT_SIDEBAR_WIDTH = 350;

export function AppLayout({
  children,
  sidebarContent,
  onLaunchAgent,
  onSettings,
  onOpenAgentSettings,
  onRetry,
  agentAvailability,
  agentSettings,
  isHydrated = true,
}: AppLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);

  const currentProject = useProjectStore((state) => state.currentProject);
  const isProjectSwitching = useProjectStore((state) => state.isSwitching);
  const switchingToProjectName = useProjectStore((state) => state.switchingToProjectName);
  const layout = useLayoutState();

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
        // Hydrate dock state with legacy migration and validation
        const validModes: Array<"expanded" | "slim" | "hidden"> = ["expanded", "slim", "hidden"];
        const validBehaviors: Array<"auto" | "manual"> = ["auto", "manual"];
        const rawMode = appState.dockMode;
        const rawBehavior = appState.dockBehavior;
        const isValidMode = rawMode && validModes.includes(rawMode as any);
        const isValidBehavior = rawBehavior && validBehaviors.includes(rawBehavior as any);
        const dockMode = isValidMode ? (rawMode === "expanded" ? "expanded" : "hidden") : "hidden";
        const dockBehavior = isValidBehavior ? rawBehavior : "auto";
        useDockStore.getState().hydrate({
          mode: dockMode,
          behavior: dockBehavior,
          autoHideWhenEmpty: Boolean(appState.dockAutoHideWhenEmpty),
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
    if (!isHydrated || isProjectSwitching) {
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
  }, [
    layout.isFocusMode,
    layout.savedPanelState,
    currentProject?.id,
    isHydrated,
    isProjectSwitching,
  ]);

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

    window.addEventListener("canopy:toggle-focus-mode", handleFocusModeToggle);
    return () => {
      window.removeEventListener("canopy:toggle-focus-mode", handleFocusModeToggle);
    };
  }, [handleToggleFocusMode]);

  useEffect(() => {
    const handleSidecarToggle = () => {
      layout.toggleSidecar();
    };

    window.addEventListener("canopy:toggle-sidecar", handleSidecarToggle);
    return () => window.removeEventListener("canopy:toggle-sidecar", handleSidecarToggle);
  }, [layout.toggleSidecar]);

  useEffect(() => {
    const handleOpenProjectSettings = () => setIsProjectSettingsOpen(true);
    window.addEventListener("canopy:open-project-settings", handleOpenProjectSettings);
    return () =>
      window.removeEventListener("canopy:open-project-settings", handleOpenProjectSettings);
  }, []);

  useEffect(() => {
    const handleResetSidebarWidth = () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    window.addEventListener("canopy:reset-sidebar-width", handleResetSidebarWidth);
    return () => window.removeEventListener("canopy:reset-sidebar-width", handleResetSidebarWidth);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      layout.updateSidecarLayoutMode(window.innerWidth, layout.isFocusMode ? 0 : sidebarWidth);
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [sidebarWidth, layout.updateSidecarLayoutMode, layout.isFocusMode, layout.sidecarWidth]);

  useEffect(() => {
    if (!layout.sidecarOpen) {
      window.electron.sidecar.hide();
    }
  }, [layout.sidecarOpen]);

  const handleSidebarResize = useCallback((newWidth: number) => {
    const clampedWidth = Math.min(Math.max(newWidth, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
    setSidebarWidth(clampedWidth);
  }, []);

  const handleLaunchAgent = useCallback(
    (type: "claude" | "gemini" | "codex" | "opencode" | "terminal" | "browser") => {
      onLaunchAgent?.(type);
    },
    [onLaunchAgent]
  );

  const handleSettings = useCallback(() => {
    onSettings?.();
  }, [onSettings]);

  const effectiveSidebarWidth = layout.isFocusMode ? 0 : sidebarWidth;

  useEffect(() => {
    const offset = layout.sidecarOpen ? `${layout.sidecarWidth}px` : "0px";
    document.body.style.setProperty("--sidecar-right-offset", offset);

    return () => {
      document.body.style.removeProperty("--sidecar-right-offset");
    };
  }, [layout.sidecarOpen, layout.sidecarWidth]);

  return (
    <div
      className="h-screen flex flex-col bg-canopy-bg"
      style={{
        height: "100vh",
        width: "100vw",
        backgroundColor: "var(--color-canopy-bg)",
        display: "flex",
        flexDirection: "column",
        color: "var(--color-canopy-text)",
      }}
    >
      <SidecarVisibilityController />
      <Toolbar
        onLaunchAgent={handleLaunchAgent}
        onSettings={handleSettings}
        onOpenAgentSettings={onOpenAgentSettings}
        errorCount={layout.errorCount}
        onToggleProblems={handleToggleProblems}
        isFocusMode={layout.isFocusMode}
        onToggleFocusMode={handleToggleFocusMode}
        agentAvailability={agentAvailability}
        agentSettings={agentSettings}
      />
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div
          className="flex-1 flex overflow-hidden"
          style={{ flex: 1, display: "flex", overflow: "hidden" }}
        >
          {!layout.isFocusMode && (
            <ErrorBoundary variant="section" componentName="Sidebar">
              <Sidebar width={effectiveSidebarWidth} onResize={handleSidebarResize}>
                {sidebarContent}
              </Sidebar>
            </ErrorBoundary>
          )}
          <ErrorBoundary variant="section" componentName="MainContent">
            <main
              className="flex-1 flex flex-col overflow-hidden bg-canopy-bg relative"
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                backgroundColor: "var(--color-canopy-bg)",
              }}
            >
              <div className="flex-1 overflow-hidden min-h-0">{children}</div>
              {/* Terminal Dock Region - manages dock visibility and overlays */}
              <TerminalDockRegion />
              {/* Overlay mode - sidecar floats over content */}
              {layout.sidecarOpen && layout.sidecarLayoutMode === "overlay" && (
                <ErrorBoundary variant="section" componentName="SidecarDock">
                  <div className="absolute right-0 top-0 bottom-0 z-50 shadow-2xl border-l border-canopy-border">
                    <SidecarDock />
                  </div>
                </ErrorBoundary>
              )}
            </main>
          </ErrorBoundary>
          {/* Push mode - sidecar is part of flex layout */}
          {layout.sidecarOpen && layout.sidecarLayoutMode === "push" && (
            <ErrorBoundary variant="section" componentName="SidecarDock">
              <div className="border-l border-canopy-border flex-shrink-0">
                <SidecarDock />
              </div>
            </ErrorBoundary>
          )}
        </div>
        {/* Unified diagnostics dock replaces LogsPanel, EventInspectorPanel, and ProblemsPanel */}
        <ErrorBoundary variant="section" componentName="DiagnosticsDock">
          <DiagnosticsDock onRetry={onRetry} />
        </ErrorBoundary>
      </div>

      {currentProject && isProjectSettingsOpen && (
        <ProjectSettingsDialog
          projectId={currentProject.id}
          isOpen={isProjectSettingsOpen}
          onClose={() => setIsProjectSettingsOpen(false)}
        />
      )}

      <ProjectSwitchOverlay
        isSwitching={isProjectSwitching}
        projectName={switchingToProjectName ?? undefined}
      />
    </div>
  );
}
