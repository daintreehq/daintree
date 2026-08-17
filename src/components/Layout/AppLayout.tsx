import { useState, useCallback, useEffect, useRef, Suspense, lazy, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { TerminalDockRegion } from "./TerminalDockRegion";
const LazyDiagnosticsDock = lazy(() =>
  import("../Diagnostics").then((m) => ({ default: m.DiagnosticsDock }))
);
import { ErrorBoundary } from "../ErrorBoundary";
import { PortalDock, PortalVisibilityController } from "../Portal";
import { ThemeBrowser } from "../ThemeBrowser";
import { FleetArmingRibbon } from "@/components/Fleet";
import { TerminalDestructiveActionConfirmDialog } from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
import { WorktreeMoveDecisionDialog } from "@/components/Terminal/WorktreeMoveDecisionDialog";
import { WorktreeDivergenceWatcher } from "@/components/Terminal/WorktreeDivergenceWatcher";
import { PortalCloseConfirmDialog } from "@/components/Portal/PortalCloseConfirmDialog";
import { MoveOrRenameProjectDialog } from "@/components/Project/MoveOrRenameProjectDialog";
import { ChordIndicator } from "./ChordIndicator";

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
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { useCcrPresetsSubscription } from "@/hooks/useCcrPresetsSubscription";
import { useProjectPresetsSubscription } from "@/hooks/useProjectPresetsSubscription";
import { useDiagnosticsAutoOpen } from "@/hooks/useDiagnosticsAutoOpen";
import { useDockPopoverLayerSync } from "@/components/Layout/useOpenDockPopoverId";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { useLayoutState, useOverlayOpen } from "@/hooks";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import {
  createAssistantRevealCoordinator,
  suppressSidebarResizes,
  getSidebarAffectedTerminalIds,
} from "@/lib/sidebarToggle";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { unlockSidebarHydration } from "@/lib/layoutTransitionLock";
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

function preloadHelpPanel() {
  // Gate the panel chunk on the HybridInputBar chunk: the assistant always
  // mounts the bar (Suspense fallback null inside HelpPanel), so a bar chunk
  // that resolves AFTER the panel commits pops in BELOW the terminal and
  // shrinks its host rows mid-boot — a PTY resize landing in the CLI's most
  // fragile window (the splash→hand-off sequence). Awaiting both (not merely
  // fetching in parallel) guarantees the bar's lazy() resolves synchronously
  // on the panel's first render, so the terminal box is stable from first
  // paint. A failed bar chunk degrades to no bar rather than no panel.
  const inputBar = import("@/components/Terminal/HybridInputBar").catch(() => null);
  return Promise.all([import("../HelpPanel"), inputBar]).then(([m]) => m);
}
// Named `HelpPanel` (not Lazy*) because AppLayout.sidebar.test.ts asserts on
// the `<HelpPanel ...>` JSX shape. The render below is unconditional (panel
// visibility is CSS-width driven), so the chunk is always needed — fetch it
// eagerly to run in parallel with hydration instead of after first mount.
const HelpPanel = lazy(() => preloadHelpPanel().then((m) => ({ default: m.HelpPanel })));
void preloadHelpPanel();

// Demo-mode tooling is dev/recording-only and never reachable in production
// (the `window.electron?.demo` gate is undefined unless launched with
// `--demo-mode`). Lazy-load each component from its own file so ~1.5k lines of
// demo source stay out of the production first-paint chunk. Direct file imports
// (not the `../Demo` barrel) keep them as three independent async chunks.
const LazyDemoOverlay = lazy(() =>
  import("../Demo/DemoOverlay").then((m) => ({ default: m.DemoOverlay }))
);
const LazyDemoCursor = lazy(() =>
  import("../Demo/DemoCursor").then((m) => ({ default: m.DemoCursor }))
);
const LazyDemoCaptureBridge = lazy(() =>
  import("../Demo/DemoCaptureBridge").then((m) => ({ default: m.DemoCaptureBridge }))
);
// Preload only in demo mode so the chunks resolve before first mount (no
// Suspense flash). In production the gate is false, so this block never runs and
// the (still-emitted) demo chunks are never fetched. The `typeof window` guard
// keeps module evaluation safe under a non-DOM test environment.
if (typeof window !== "undefined" && window.electron?.demo) {
  void import("../Demo/DemoOverlay");
  void import("../Demo/DemoCursor");
  void import("../Demo/DemoCaptureBridge");
}

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

// #10827: upper bound on how long the grid-measurement hydration lock stays
// armed if the persisted-width restore IPC neither resolves nor rejects. After
// this the lock releases anyway so the grid still measures (pre-#10827 visible
// behavior) rather than staying blank. Far longer than a healthy restore.
const SIDEBAR_HYDRATION_UNLOCK_FALLBACK_MS = 5000;

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
  useDiagnosticsAutoOpen();
  // Published once for the whole view: every AppDialog layers itself against
  // this rather than each caller working it out (#11505).
  useDockPopoverLayerSync();
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
  // Issue #10321: sidebarWidth boots at DEFAULT_SIDEBAR_WIDTH and is only
  // replaced once the async appClient.getState() restore (restoreState below)
  // resolves ~50-100ms later. With the width transition live from first paint,
  // that late setSidebarWidth animates the sidebar from 350px to the persisted
  // width on every project switch — an animation the user never triggered.
  // Suppress the transition until the restore lands, then clear the flag in the
  // same synchronous post-await block so React batches both updates into one
  // paint (the new width arrives with the class already gone — no animation).
  const [isSidebarWidthHydrating, setIsSidebarWidthHydrating] = useState(true);
  const currentProject = useProjectStore((state) => state.currentProject);
  // Per-workspace state is keyed by workspace id, and a scratch owns one even
  // though it has no Project row. Persisting a scratch through the legacy
  // global fallback would overwrite the global focus record that unmigrated
  // real projects still migrate from, destroying it for every project the user
  // has not reopened yet (#11497). Only a renderer with no workspace at all may
  // fall back to the global write.
  //
  // The view's own workspace id is the identity to use here, never
  // `currentProject ?? currentScratch`: both of those are broadcast to every
  // view, so a cached project view momentarily without a project would write
  // its focus state into a sibling window's scratch.
  const workspaceId = getViewWorkspaceId() ?? currentProject?.id;
  const layout = useLayoutState();
  const diagnosticsMounted = useKeepMounted(layout.diagnosticsOpen);
  const isThemeBrowserOpen = useOverlayOpen("theme-browser");
  const themeBrowserOpen = useThemeBrowserStore((s) => s.isOpen);
  // The plugin manager (#9558) is a full-screen overlay; while it owns the
  // viewport its claim marks the app chrome inert, same as the theme browser.
  // The view itself is mounted in App.tsx (it carries deep-link props), so
  // AppLayout only needs the inert coordination, not the portal.
  const isPluginManagerOpen = useOverlayOpen("plugin-manager");
  const chromeInert = isThemeBrowserOpen || isPluginManagerOpen;
  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);
  // Every workspace kind has something for the sidebar to hold — a scratch and
  // a folder opened without git each have their own root — so the gate is "is
  // there a workspace at all", not "is there a project". Gating on the project
  // left the toggle and Cmd+B flipping `aria-pressed` over a slot that could
  // never appear in a scratch (#11499). Only the welcome screen, which has no
  // workspace of any kind, still has no sidebar (#5023).
  const hasWorkspace = useWorkspaceRoot() !== null;
  const showSidebar = !layout.gestureSidebarHidden && hasWorkspace;
  const showAssistant = !layout.gestureAssistantHidden && layout.helpPanelOpen;
  const effectiveAssistantWidth = showAssistant ? layout.helpPanelWidth : 0;
  // #10693 (off-canvas): the assistant wrapper is always full-width and slides
  // via transform, so when hidden it still has a real DOM box off-screen. Mark
  // it inert once it has finished sliding out so keyboard focus and scroll can't
  // land in the parked panel. Applied only AFTER the slide settles (and removed
  // immediately on show) so a Radix Presence teardown inside the panel keeps its
  // transitionend (#6182). pointer-events-none + the panel's own tabIndex gating
  // already cover the in-flight window.
  const [assistantInert, setAssistantInert] = useState(!showAssistant);

  // #11070: the assistant's post-transition reveal repaint is a durable
  // obligation, not a one-shot. On a cold first open the slide settles while the
  // session is still provisioning (no terminalId yet), so the coordinator retains
  // the repaint and discharges it once the terminal binds and attaches. Owned
  // here because the obligation's lifetime is exactly this DOM's lifetime; the
  // factory is pure, so Strict Mode's double-invoke of the initializer is free.
  const [assistantReveal] = useState(createAssistantRevealCoordinator);
  useEffect(() => assistantReveal.start(), [assistantReveal]);
  // Cancel on the visibility STATE change, not at the hide slide's end: a
  // terminal that binds mid-slide-out must not repaint into a hidden pane.
  useEffect(() => {
    assistantReveal.setVisible(showAssistant);
  }, [assistantReveal, showAssistant]);

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
    // #10321: while the width transition is suppressed during the initial
    // hydration window, transitionend never fires on a hide, so flush directly
    // here — otherwise sidebarFullyHidden stays false and a 6px clip-margin
    // strip lingers.
    if (
      reduceAnimations ||
      isSidebarResizing ||
      isSidebarWidthHydrating ||
      prefersReducedMotion ||
      layout.performanceMode
    ) {
      setSidebarFullyHidden(true);
    }
  }, [
    showSidebar,
    reduceAnimations,
    isSidebarResizing,
    isSidebarWidthHydrating,
    layout.performanceMode,
  ]);

  const handleSidebarTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // Only the wrapper's own width transition marks the end of the collapse.
      // Filter on propertyName to ignore other transitioned properties and on
      // target === currentTarget to ignore bubbled child transitions. Re-check
      // visibility so a stale transitionend from a hide that was reversed
      // mid-animation (hide then show) doesn't clip the now-visible sidebar.
      if (event.propertyName === "width" && event.target === event.currentTarget && !showSidebar) {
        setSidebarFullyHidden(true);
      }
    },
    [showSidebar]
  );

  // #10693 (off-canvas): the assistant slides via a composited transform on a
  // fixed-width wrapper, so the terminal box never resizes during show/hide and
  // the SIGWINCH storm can't form. The PUSH (main grid reclaiming the space) is
  // driven by a sibling layout spacer that animates its width — that spacer is
  // the <main> reflow driver, so arm the grid-resize lock when ITS width
  // transition starts, exactly as the wrapper's width transition used to do.
  // Filter on width + target===currentTarget to ignore other properties and
  // bubbled child transitions, mirroring the sidebar handler.
  const handleAssistantSpacerTransitionStart = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.propertyName === "width" && event.target === event.currentTarget) {
        suppressSidebarResizes();
      }
    },
    []
  );

  // When the wrapper's transform slide settles, issue the one corrective repaint
  // (reveal) and, on a hide, mark the parked wrapper inert. Filter on transform
  // because that is the property the wrapper now animates. transitioncancel is
  // intentionally unwired: a rapid hide→show re-targets the same transform and
  // the final transitionend resolves the correct state.
  const handleAssistantTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.propertyName === "transform" && event.target === event.currentTarget) {
        assistantReveal.settleAfterTransition(showAssistant);
        if (!showAssistant) setAssistantInert(true);
      }
    },
    [showAssistant, assistantReveal]
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
        // #10321: clear unconditionally (even when sidebarWidth is null) so a
        // session without a persisted width still gets a live transition. React
        // batches this with the setSidebarWidth above into a single paint.
        setIsSidebarWidthHydrating(false);
      } catch (error) {
        logError("Failed to restore app state", error);
        // #10321: a failed restore must still re-enable the transition, else
        // every later user resize/collapse would be silently suppressed.
        setIsSidebarWidthHydrating(false);
      }
    };
    restoreState();
  }, []);

  // #10827: release the grid-measurement hydration lock once the persisted
  // sidebar width has been restored. This passive effect runs after React
  // commits the restored `sidebarWidth` (and the cleared hydrating flag) into
  // the DOM, so grid/pane measurement subscribers fire against the correct
  // `<main>` width instead of the default 350px — eliminating the first-load
  // narrow-then-snap. `unlockSidebarHydration()` is idempotent.
  //
  // Gated on `isHydrated`: the pre-hydration skeleton AppLayout (App.tsx renders
  // `<AppLayout isHydrated={false}>` with no ContentGrid) runs the same
  // `restoreState()` effect, and its fast `appClient.getState()` typically
  // resolves before the real AppLayout + ContentGrid mount. Without this gate
  // the skeleton would release the global lock early, so the real grid would
  // hit the already-unlocked fast path and measure at the default width.
  useEffect(() => {
    if (!isHydrated) return;
    if (!isSidebarWidthHydrating) {
      unlockSidebarHydration();
      return;
    }
    // Safety net: if the width restore hangs (IPC never resolves *or* rejects),
    // `isSidebarWidthHydrating` would stay true forever and the grid would
    // never measure. Release the lock after a generous timeout so a stuck IPC
    // degrades to the pre-#10827 behavior (visible grid) rather than a blank
    // one. Cleared the instant the flag clears normally (effect re-runs).
    const fallback = window.setTimeout(
      unlockSidebarHydration,
      SIDEBAR_HYDRATION_UNLOCK_FALLBACK_MS
    );
    return () => window.clearTimeout(fallback);
  }, [isHydrated, isSidebarWidthHydrating]);

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
      if (!workspaceId) {
        // No workspace at all - fall back to global state for backward compatibility
        try {
          await appClient.setState({ focusMode: persistedFocusMode });
        } catch (error) {
          logError("Failed to persist focus mode to global state", error);
        }
        return;
      }

      try {
        await window.electron.project.setFocusMode(
          workspaceId,
          persistedFocusMode,
          layout.savedPanelState as PanelState | undefined
        );
      } catch (error) {
        logError("Failed to persist focus mode to project state", error);
      }
    };

    const timer = setTimeout(persistFocusMode, 100);
    return () => clearTimeout(timer);
  }, [layout.gestureSidebarHidden, layout.savedPanelState, workspaceId, isHydrated]);

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
      // Persist to per-workspace state
      if (workspaceId) {
        try {
          await window.electron.project.setFocusMode(workspaceId, false, undefined);
        } catch (error) {
          logError("Failed to clear focus panel state", error);
        }
      } else {
        // Fall back to global state only when there is no workspace at all
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
      if (workspaceId) {
        try {
          await window.electron.project.setFocusMode(workspaceId, true, currentPanelState);
        } catch (error) {
          logError("Failed to persist focus panel state", error);
        }
      } else {
        // Fall back to global state only when there is no workspace at all
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
    // No workspace means no sidebar mounts at all (welcome screen), so there is
    // nothing to hide or reveal. Flipping the gesture flag anyway is what let
    // the toolbar button and Cmd+B move their own aria-pressed over a slot that
    // could never appear (#11499). Also guards the `nav.toggleSidebar` action,
    // which reaches this through the window event below.
    if (!hasWorkspace) return;
    suppressSidebarResizes();
    const focus = useFocusStore.getState();
    focus.setSidebarGestureHidden(!focus.gestureSidebarHidden, {
      sidebarWidth,
      diagnosticsOpen: layout.diagnosticsOpen,
    });
  }, [hasWorkspace, sidebarWidth, layout.diagnosticsOpen]);

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

  // #10693 (off-canvas): drive the inert/repaint settle for the paths where no
  // transform transition fires. On show, clear inert immediately so focus can
  // enter before the slide finishes. When the slide is animated, the transition
  // handlers own the settle; when it is suppressed there is no transitionend, so
  // reconcile geometry and toggle inert synchronously here instead. A slide is
  // suppressed by the reduce-animations preference, performance mode, an OS
  // prefers-reduced-motion match, OR an in-flight drag-resize (which strips the
  // transition so the handle tracks the cursor 1:1). The media query is also
  // subscribed so flipping the OS setting mid-hide still parks the wrapper inert.
  useEffect(() => {
    const mql =
      typeof window !== "undefined"
        ? window.matchMedia?.("(prefers-reduced-motion: reduce)")
        : undefined;
    const settle = () => {
      const noTransition =
        reduceAnimations || layout.performanceMode || isAssistantResizing || mql?.matches === true;
      if (showAssistant) {
        setAssistantInert(false);
        // A drag-resize also strips the transition, but a drag is NOT a reveal:
        // the reveal repaint's reconcileGeometryFresh is lock-exempt, so settling
        // here would assert geometry mid-drag — at a width the cursor has already
        // moved past — against the very lock that keeps the handle tracking 1:1.
        // The drag owns its own geometry and runs its resize pass on release.
        if (noTransition && !isAssistantResizing) assistantReveal.settleAfterTransition(true);
      } else if (noTransition) {
        setAssistantInert(true);
      }
    };
    settle();
    mql?.addEventListener("change", settle);
    return () => mql?.removeEventListener("change", settle);
  }, [
    showAssistant,
    reduceAnimations,
    layout.performanceMode,
    isAssistantResizing,
    assistantReveal,
  ]);

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

  // While a sidebar/assistant divider is dragged, `<main flex:1>` reflows every
  // mousemove; each reflow fires xterm's ResizeObserver -> PTY SIGWINCH -> a
  // full alt-screen repaint of every agent pane on the active worktree plus the
  // assistant's own terminal (one full-frame TUI redraw per drag frame). Lock
  // resize on drag start and unlock + correct on drag end, mirroring the
  // two-pane divider (TwoPaneSplitLayout.handleDragStateChange). The explicit
  // runResizePass is required because ResizeObserver does not retroactively
  // fire when a lock releases (see suppressResizesDuringLayoutTransition) and no
  // grid-dep change fires at drag end to re-measure. lockResize's 5s default TTL
  // is the dead-man's switch for a drag whose end is lost (mid-drag project
  // switch): the lock expires and the next observer entry self-heals geometry.
  const dragLockedIdsRef = useRef<string[]>([]);
  const lockResizeForLayoutDrag = useCallback(() => {
    const ids = getSidebarAffectedTerminalIds();
    dragLockedIdsRef.current = ids;
    for (const id of ids) {
      terminalInstanceService.lockResize(id, true);
    }
  }, []);
  const unlockResizeForLayoutDrag = useCallback(() => {
    const ids = dragLockedIdsRef.current;
    dragLockedIdsRef.current = [];
    for (const id of ids) {
      terminalInstanceService.lockResize(id, false);
    }
    if (ids.length > 0) {
      terminalInstanceService.runResizePass(ids);
    }
  }, []);

  // Self-heal the drag lock every frame while a divider is being dragged.
  // Crossing an auto-grid breakpoint mid-drag makes useContentGridContext call
  // suppressResizesDuringLayoutTransition, whose 200ms unlock + explicit
  // lockResize(id, false) would otherwise wipe this drag lock (the controller
  // holds one expiry per id — last write wins) and let the SIGWINCH storm
  // resume for the rest of the drag. Re-arming on rAF recovers within a frame.
  // The loop reads dragLockedIdsRef, which the drag-end helper clears, so a
  // late rAF firing after unlock iterates an empty set and the effect cleanup
  // cancels the next one.
  useEffect(() => {
    if (!isSidebarResizing && !isAssistantResizing) return;
    let rafId = 0;
    const rearm = () => {
      for (const id of dragLockedIdsRef.current) {
        terminalInstanceService.lockResize(id, true);
      }
      rafId = requestAnimationFrame(rearm);
    };
    rafId = requestAnimationFrame(rearm);
    return () => cancelAnimationFrame(rafId);
  }, [isSidebarResizing, isAssistantResizing]);

  // flushSync on the start setter so the gating class is removed from the DOM
  // before the first mousemove fires — without it, React 19's batching can
  // leave one eased frame at the start of the drag.
  const handleSidebarResizeStart = useCallback(() => {
    flushSync(() => setIsSidebarResizing(true));
    lockResizeForLayoutDrag();
  }, [lockResizeForLayoutDrag]);

  const handleSidebarResizeEnd = useCallback(() => {
    setIsSidebarResizing(false);
    unlockResizeForLayoutDrag();
  }, [unlockResizeForLayoutDrag]);

  const handleAssistantResizeStart = useCallback(() => {
    flushSync(() => setIsAssistantResizing(true));
    lockResizeForLayoutDrag();
  }, [lockResizeForLayoutDrag]);

  const handleAssistantResizeEnd = useCallback(() => {
    setIsAssistantResizing(false);
    unlockResizeForLayoutDrag();
  }, [unlockResizeForLayoutDrag]);

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
          hasWorkspace={hasWorkspace}
          agentAvailability={agentAvailability}
          agentSettings={agentSettings}
          projectSwitcherPalette={projectSwitcherPalette}
        />
        <FleetArmingRibbon />
      </div>
      <TerminalDestructiveActionConfirmDialog />
      <WorktreeMoveDecisionDialog />
      <WorktreeDivergenceWatcher />
      <PortalCloseConfirmDialog />
      <MoveOrRenameProjectDialog />
      <div
        {...(chromeInert ? { inert: true } : {})}
        className="flex-1 flex flex-col overflow-hidden"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {/* #10693 (off-canvas): overflow MUST be `clip`, not `hidden`. The
            assistant wrapper is parked at right:0 + translateX(+helpPanelWidth),
            i.e. entirely beyond this row's right edge, so it extends the row's
            scrollable overflow rightward. `overflow:hidden` clips visually but is
            still a scroll container, so when the panel is shown the first time
            and HelpPanel programmatically focuses its freshly-mounted xterm while
            the slide is still off-screen, the browser's focus scrollIntoView
            scrolls this row right — shifting sidebar+main left and pushing the
            worktree sidebar off the left edge. `overflow:clip` is not a scroll
            container, so focus can never scroll it. Both the class and the inline
            style are set because the inline `overflow` wins over the utility.

            min-height MUST be 0 (#11024): because `clip` is not a scroll
            container, it does not zero the flex automatic minimum size the way
            `overflow:hidden` does — without it, any panel content with a large
            intrinsic height (file viewer) inflates this row past the window and
            wrecks the whole layout. */}
        <div
          className="flex-1 flex overflow-clip relative min-h-0"
          style={{ flex: 1, display: "flex", overflow: "clip", position: "relative", minHeight: 0 }}
        >
          <div
            className={cn(
              "relative h-full shrink-0 overflow-clip",
              !reduceAnimations &&
                !isSidebarResizing &&
                !isSidebarWidthHydrating &&
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
              {hasWorkspace && (
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
          {/* #10693 (off-canvas): this spacer drives the <main> push by
              animating its width 0↔helpPanelWidth, while the panel itself slides
              over the reclaimed space via the wrapper's transform. The spacer is
              the grid-reflow driver, so it carries the resize-lock arming
              transition handler the width-wrapper used to own. */}
          <div
            aria-hidden
            className={cn(
              "shrink-0 pointer-events-none",
              !reduceAnimations &&
                !isAssistantResizing &&
                (showAssistant
                  ? "transition-[width] duration-[var(--duration-200)] ease-[var(--ease-out-expo)] motion-reduce:transition-none"
                  : "transition-[width] duration-[var(--duration-120)] ease-[var(--ease-panel-minimize)] motion-reduce:transition-none")
            )}
            style={{ width: effectiveAssistantWidth }}
            onTransitionStart={handleAssistantSpacerTransitionStart}
          />
          <ErrorBoundary variant="section" componentName="HelpPanel">
            <div
              className={cn(
                "absolute top-0 right-0 h-full overflow-hidden",
                !reduceAnimations &&
                  !isAssistantResizing &&
                  (showAssistant
                    ? "transition-transform duration-[var(--duration-200)] ease-[var(--ease-out-expo)] motion-reduce:transition-none"
                    : "transition-transform duration-[var(--duration-120)] ease-[var(--ease-panel-minimize)] motion-reduce:transition-none"),
                !showAssistant && "pointer-events-none"
              )}
              style={{
                width: layout.helpPanelWidth,
                transform: showAssistant
                  ? "translateX(0)"
                  : `translateX(${layout.helpPanelWidth}px)`,
                contain: "layout paint",
              }}
              inert={assistantInert}
              onTransitionEnd={handleAssistantTransitionEnd}
            >
              <div
                className="absolute top-0 right-0 h-full"
                style={{ width: layout.helpPanelWidth }}
              >
                <Suspense fallback={null}>
                  <HelpPanel
                    width={layout.helpPanelWidth}
                    isVisible={showAssistant}
                    isReadyToLaunch={isHydrated}
                    onResizeStart={handleAssistantResizeStart}
                    onResizeEnd={handleAssistantResizeEnd}
                  />
                </Suspense>
              </div>
            </div>
          </ErrorBoundary>
        </div>
        {/* Unified diagnostics dock replaces LogsPanel, EventInspectorPanel, and ProblemsPanel */}
        {diagnosticsMounted && (
          <ErrorBoundary variant="section" componentName="DiagnosticsDock">
            <Suspense fallback={null}>
              <LazyDiagnosticsDock onRetry={onRetry} onCancelRetry={onCancelRetry} />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>

      <ChordIndicator />

      <AllClearOverlay />
      {themeBrowserOpen &&
        createPortal(
          <>
            {/* Opacity-only scrim: a hover-animated backdrop-filter here forced
                a full-viewport blur re-rasterization on every underlying frame
                exactly while the live theme preview is repainting beneath it. */}
            <div
              aria-hidden="true"
              className="fixed inset-0 z-30 bg-scrim-soft/30 transition-colors duration-150 hover:bg-scrim-soft/45"
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
        <Suspense fallback={null}>
          <LazyDemoOverlay />
          <LazyDemoCursor />
          <LazyDemoCaptureBridge />
        </Suspense>
      )}
    </div>
  );
}
