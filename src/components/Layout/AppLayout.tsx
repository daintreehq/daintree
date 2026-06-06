import { useState, useCallback, useEffect, useRef, Suspense, lazy, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { cn } from "@/lib/utils";
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
import { TerminalDestructiveActionConfirmDialog } from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
import { PortalCloseConfirmDialog } from "@/components/Portal/PortalCloseConfirmDialog";
import { ChordIndicator } from "./ChordIndicator";
import { DemoCaptureBridge, DemoCursor, DemoOverlay } from "../Demo";

import { AllClearOverlay } from "../AllClearOverlay";
import {
  useDiagnosticsStore,
  useDockStore,
  useFocusStore,
  useHelpPanelStore,
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
import { useLayoutState, useOverlayOpen } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { logError } from "@/utils/logger";

function preloadGlobalBannerCoordinator() {
  return import("../Recovery/GlobalBannerCoordinator");
}
const LazyGlobalBannerCoordinator = lazy(() =>
  preloadGlobalBannerCoordinator().then((m) => ({ default: m.GlobalBannerCoordinator }))
);
// Fetch eagerly: `safeMode` is set synchronously during hydration, so the
// first post-hydration render can suspend before the idle preload fires.
void preloadGlobalBannerCoordinator();

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
  // Issue #7627: track active drag-resize per panel so AppLayout can suppress
  // the 250ms ease-out-expo width transition during the drag (the transition
  // restarts on every mousemove, which makes the rendered edge lag the cursor).
  // Toggling these flags via flushSync at drag start guarantees the class
  // gate disappears synchronously before the first mousemove frame; the
  // transition is restored on drag end so collapse/expand and double-click
  // reset still animate.
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isAssistantResizing, setIsAssistantResizing] = useState(false);
  const currentProject = useProjectStore((state) => state.currentProject);
  const layout = useLayoutState();
  const isThemeBrowserOpen = useOverlayOpen("theme-browser");
  const themeBrowserOpen = useThemeBrowserStore((s) => s.isOpen);
  // The plugin manager (#9558) is a full-screen overlay; while it owns the
  // viewport its claim marks the app chrome inert, same as the theme browser.
  // The view itself is mounted in App.tsx (it carries deep-link props), so
  // AppLayout only needs the inert coordination, not the portal.
  const isPluginManagerOpen = useOverlayOpen("plugin-manager");
  const chromeInert = isThemeBrowserOpen || isPluginManagerOpen;
  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);
  const showSidebar = !layout.gestureSidebarHidden && currentProject != null;
  const showAssistant = !layout.gestureAssistantHidden && layout.helpPanelOpen;
  const effectiveAssistantWidth = showAssistant ? layout.helpPanelWidth : 0;

  // Issue #9864: the sidebar wrapper carries overflowClipMargin: 6px so the
  // resize handle's overhang paints outside the contain boundary. But
  // overflow-clip-margin is a discrete (non-animatable) property — when the
  // wrapper width animates to 0 on hide, the clip edge stays 6px out and the
  // full-width inner content bleeds a 6px strip at the left edge. Track when
  // the sidebar is *fully* hidden (after the collapse animation) and only then
  // zero the clip margin, so the handle overhang survives the whole animation
  // while no strip remains at rest. Initialize from !showSidebar to avoid a
  // 6px flash on startup when the app boots with the sidebar hidden.
  const [sidebarFullyHidden, setSidebarFullyHidden] = useState(() => !showSidebar);

  useEffect(() => {
    if (showSidebar) {
      // Restore the clip margin immediately on show so the resize handle
      // overhang is live before/throughout the reveal animation.
      setSidebarFullyHidden(false);
      return;
    }
    // Hiding: when no width transition will actually run, transitionend never
    // fires, so flush directly. The width transition is suppressed by the
    // in-app reduceAnimations toggle, an active drag-resize, OS-level reduced
    // motion (the motion-reduce:transition-none variant), or performance mode
    // (data-performance-mode narrows transition-property to exclude width).
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (
      reduceAnimations ||
      isSidebarResizing ||
      prefersReducedMotion ||
      layout.performanceMode
    ) {
      setSidebarFullyHidden(true);
    }
  }, [showSidebar, reduceAnimations, isSidebarResizing, layout.performanceMode]);

  const handleSidebarTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // Only the wrapper's own width transition marks the end of the collapse.
      // Filter on propertyName to ignore other transitioned properties and on
      // target === currentTarget to ignore bubbled child transitions. Re-check
      // visibility so a stale transitionend from a hide that was reversed
      // mid-animation (hide then show) doesn't clip the now-visible sidebar.
      if (
        event.propertyName === "width" &&
        event.target === event.currentTarget &&
        !showSidebar
      ) {
        setSidebarFullyHidden(true);
      }
    },
    [showSidebar]
  );

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
    // The assistant's own visibility is owned by `helpPanelStore.isOpen` at
    // runtime and intentionally starts hidden on app boot, so it doesn't need
    // to round-trip through the per-project focus state.
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
    const snapshot = useFocusStore.getState().gestureSnapshot;
    const gestureActive = snapshot !== null;
    if (gestureActive) {
      if (layout.savedPanelState) {
        setSidebarWidth((layout.savedPanelState as PanelState).sidebarWidth);
      }
      // Read the assistant's pre-entry isOpen before toggleFocusMode clears the
      // snapshot. Restore it only when the gesture itself hid the assistant —
      // symmetric with the sidebar revert, which the store gates on hidSidebar
      // ("the snapshot only owns the deltas it caused"). If the assistant was
      // never gesture-hidden (e.g. a sidebar-only gesture), an explicit toolbar
      // open during focus mode must survive the exit rather than be snapped shut.
      const restoreAssistant = snapshot.hidAssistant;
      const assistantWasOpen = snapshot.assistantWasOpen;
      layout.toggleFocusMode({
        sidebarWidth,
        diagnosticsOpen: layout.diagnosticsOpen,
      } as PanelState);
      if (restoreAssistant) {
        useHelpPanelStore.getState().setOpen(assistantWasOpen);
      }
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
      // Capture the persistent toolbar preference synchronously at gesture
      // entry so the exit path can restore it (see GestureSnapshot.assistantWasOpen).
      // Derive assistantVisible from the same live read rather than the render
      // closure's showAssistant, so the snapshot's hidAssistant and
      // assistantWasOpen can't diverge if isOpen changed since the last render.
      const assistantWasOpen = useHelpPanelStore.getState().isOpen;
      layout.toggleFocusMode(
        currentPanelState,
        {
          sidebarVisible: showSidebar,
          assistantVisible: !layout.gestureAssistantHidden && assistantWasOpen,
        },
        assistantWasOpen
      );
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

  // Clear macro focus on mouse interaction. A click inside the currently-
  // focused region must NOT clear the claim — otherwise a click within the
  // already-focused assistant (or any other claimed region) drops the macro
  // region while DOM focus remains in place, and no new `focus` event fires
  // to reclaim it. That recreates the "two active surfaces" bug where the
  // grid panel re-shows its `.terminal-selected` chrome while the user is
  // still typing into the assistant.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const state = useMacroFocusStore.getState();
      const focused = state.focusedRegion;
      if (focused && e.target instanceof Node) {
        const ref = state.refs.get(focused);
        if (ref && ref.contains(e.target)) return;
      }
      state.clearFocus();
    };
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

  // flushSync on the start setter so the gating class is removed from the DOM
  // before the first mousemove fires — without it, React 19's batching can
  // leave one eased frame at the start of the drag.
  const handleSidebarResizeStart = useCallback(() => {
    flushSync(() => setIsSidebarResizing(true));
  }, []);

  const handleSidebarResizeEnd = useCallback(() => {
    setIsSidebarResizing(false);
  }, []);

  const handleAssistantResizeStart = useCallback(() => {
    flushSync(() => setIsAssistantResizing(true));
  }, []);

  const handleAssistantResizeEnd = useCallback(() => {
    setIsAssistantResizing(false);
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

  const effectiveSidebarWidth = showSidebar ? sidebarWidth : 0;

  useEffect(() => {
    const portalOffset = layout.portalOpen ? layout.portalWidth : 0;
    // Two separate vars because they encode different layout truths.
    // --portal-right-offset: width of the body-portaled Portal (web chat) only.
    //   Used by toolbar dropdowns, which sit above the main row and only need
    //   to dodge body-portaled overlays — the Assistant is a flex sibling
    //   below the toolbar, not an overlay (issue #6800).
    // --right-obstruction-offset: max of Portal and Assistant width — the
    //   total occupied right-edge viewport space. Used by fixed body-portaled
    //   elements (toaster, popovers, ReEntrySummary, GettingStartedChecklist,
    //   ThemeBrowser overlay) that would otherwise be hidden behind whichever
    //   is wider. Portal overlays the Assistant when both are open, so the
    //   rightmost obstruction is max, not sum (issue #6629).
    const obstructionOffset = Math.max(portalOffset, effectiveAssistantWidth);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--portal-right-offset", `${portalOffset}px`);
    rootStyle.setProperty("--right-obstruction-offset", `${obstructionOffset}px`);

    return () => {
      rootStyle.removeProperty("--portal-right-offset");
      rootStyle.removeProperty("--right-obstruction-offset");
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
      <Suspense fallback={null}>
        <LazyGlobalBannerCoordinator />
      </Suspense>
      <div {...(chromeInert ? { inert: true } : {})}>
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
      <TerminalDestructiveActionConfirmDialog />
      <PortalCloseConfirmDialog />
      <div
        {...(chromeInert ? { inert: true } : {})}
        className="flex-1 flex flex-col overflow-hidden"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div
          className="flex-1 flex overflow-hidden relative"
          style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}
        >
          <div
            className={cn(
              "relative h-full shrink-0 overflow-clip",
              !reduceAnimations &&
                !isSidebarResizing &&
                "transition-[width] duration-[var(--duration-250)] ease-[var(--ease-out-expo)] motion-reduce:transition-none",
              !showSidebar && "pointer-events-none"
            )}
            onTransitionEnd={handleSidebarTransitionEnd}
            style={{
              width: effectiveSidebarWidth,
              overflowClipMargin: sidebarFullyHidden ? "0px" : "6px", // #9864
              contain: "layout paint",
              // The contain boundary makes this wrapper a stacking context, so
              // the resize handle's 6px overhang (-right-1.5, z-50) would fall
              // behind <main>'s opaque background by DOM order. z-index 1 keeps
              // the sidebar painting above the later <main> sibling.
              zIndex: 1,
            }}
          >
            <div className="absolute top-0 left-0 h-full" style={{ width: sidebarWidth }}>
              {currentProject != null && (
                <ErrorBoundary variant="section" componentName="Sidebar">
                  <Sidebar
                    width={sidebarWidth}
                    onResize={handleSidebarResize}
                    onResizeStart={handleSidebarResizeStart}
                    onResizeEnd={handleSidebarResizeEnd}
                    isVisible={showSidebar}
                  >
                    {sidebarContent}
                  </Sidebar>
                </ErrorBoundary>
              )}
            </div>
          </div>
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
            <div
              className={cn(
                "relative h-full shrink-0 overflow-hidden",
                !reduceAnimations &&
                  !isAssistantResizing &&
                  "transition-[width] duration-[var(--duration-250)] ease-[var(--ease-out-expo)] motion-reduce:transition-none",
                !showAssistant && "pointer-events-none"
              )}
              style={{ width: effectiveAssistantWidth, contain: "layout paint" }}
            >
              <div
                className="absolute top-0 right-0 h-full"
                style={{ width: layout.helpPanelWidth }}
              >
                <HelpPanel
                  width={layout.helpPanelWidth}
                  isVisible={showAssistant}
                  isReadyToLaunch={isHydrated}
                  onResizeStart={handleAssistantResizeStart}
                  onResizeEnd={handleAssistantResizeEnd}
                />
              </div>
            </div>
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
              {/* Offset the panel below the top toolbar. The toolbar is z-[60]
                  / h-12 (Toolbar.tsx) and paints over the viewport's top 48px, so
                  a top-0 panel had its top strip (hero ✕ close, any top bar) hidden
                  behind it. Start at top-12 (= toolbar h-12) so the whole panel —
                  including the close button — is visible. */}
              <div
                className="fixed top-12 bottom-0 z-40 pointer-events-auto"
                style={{
                  right: "var(--right-obstruction-offset, 0px)",
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
              {...(chromeInert ? { inert: true } : {})}
              className="fixed top-12 right-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border"
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
