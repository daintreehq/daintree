import { useState, useCallback, useEffect, type ReactNode } from "react";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { ContentDock } from "./ContentDock";
import { DiagnosticsDock } from "../Diagnostics";
import { ErrorBoundary } from "../ErrorBoundary";
import { SidecarDock, SidecarVisibilityController } from "../Sidecar";
import { ProjectSettingsDialog } from "@/components/Project";
import { useDiagnosticsStore, type PanelState } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { useLayoutState } from "@/hooks";

interface AppLayoutProps {
  children?: ReactNode;
  sidebarContent?: ReactNode;
  onLaunchAgent?: (type: "claude" | "gemini" | "codex" | "terminal" | "browser") => void;
  onSettings?: () => void;
  onOpenAgentSettings?: () => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
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
}: AppLayoutProps) {
  const [isTerminalDockVisible, setIsTerminalDockVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);

  const currentProject = useProjectStore((state) => state.currentProject);
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
        if (appState.focusMode) {
          const legacyState = appState.focusPanelState as
            | PanelState
            | { sidebarWidth: number; logsOpen?: boolean; eventInspectorOpen?: boolean }
            | undefined;

          const savedState: PanelState = legacyState
            ? {
                sidebarWidth: legacyState.sidebarWidth,
                diagnosticsOpen:
                  "diagnosticsOpen" in legacyState
                    ? legacyState.diagnosticsOpen
                    : (legacyState.logsOpen ?? false) || (legacyState.eventInspectorOpen ?? false),
              }
            : {
                sidebarWidth: appState.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
                diagnosticsOpen: false,
              };
          layout.setFocusMode(true, savedState);
        }
      } catch (error) {
        console.error("Failed to restore app state:", error);
      }
    };
    restoreState();
  }, [layout.setFocusMode]);

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
    const persistFocusMode = async () => {
      try {
        await appClient.setState({ focusMode: layout.isFocusMode });
      } catch (error) {
        console.error("Failed to persist focus mode:", error);
      }
    };

    const timer = setTimeout(persistFocusMode, 100);
    return () => clearTimeout(timer);
  }, [layout.isFocusMode]);

  const handleToggleFocusMode = useCallback(async () => {
    if (layout.isFocusMode) {
      if (layout.savedPanelState) {
        setSidebarWidth((layout.savedPanelState as PanelState).sidebarWidth);
      }
      layout.toggleFocusMode({
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      } as PanelState);
      try {
        await appClient.setState({ focusPanelState: undefined });
      } catch (error) {
        console.error("Failed to clear focus panel state:", error);
      }
    } else {
      const currentPanelState: PanelState = {
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      };
      layout.toggleFocusMode(currentPanelState);
      try {
        await appClient.setState({ focusPanelState: currentPanelState });
      } catch (error) {
        console.error("Failed to persist focus panel state:", error);
      }
    }
  }, [
    layout.isFocusMode,
    layout.savedPanelState,
    layout.toggleFocusMode,
    layout.diagnosticsOpen,
    sidebarWidth,
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
    const handleDockToggle = () => {
      setIsTerminalDockVisible((visible) => !visible);
    };

    window.addEventListener("canopy:toggle-terminal-dock", handleDockToggle);
    return () => window.removeEventListener("canopy:toggle-terminal-dock", handleDockToggle);
  }, []);

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
  }, [sidebarWidth, layout.updateSidecarLayoutMode, layout.isFocusMode]);

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
    (type: "claude" | "gemini" | "codex" | "terminal" | "browser") => {
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
              {/* Content Dock - appears at bottom only when panels are docked */}
              {isTerminalDockVisible && (
                <ErrorBoundary variant="section" componentName="ContentDock">
                  <ContentDock />
                </ErrorBoundary>
              )}
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
    </div>
  );
}
