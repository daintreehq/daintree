import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ExternalLink, Settings2, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import { shouldShowHybridInputBar } from "@/components/Terminal/terminalFocus";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { HelpIntroBanner } from "./HelpIntroBanner";
import { HelpPanelHeader } from "./HelpPanelHeader";
import { HelpPanelBanners } from "./HelpPanelBanners";
import { HelpPanelVersionGate } from "./HelpPanelVersionGate";
import { HelpLaunchingState } from "./HelpLaunchingState";
import {
  useHelpPanelStore,
  HELP_PANEL_MIN_WIDTH,
  HELP_PANEL_MAX_WIDTH,
} from "@/store/helpPanelStore";
import {
  usePanelStore,
  getTerminalRefreshTier,
  useCliAvailabilityStore,
  useProjectStore,
  useWorktreeSelectionStore,
  useTerminalInputStore,
} from "@/store";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { TerminalRefreshTier } from "@/types";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";
import { HelpSessionController } from "@/controllers/HelpSessionController";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const RESIZE_STEP = 10;
const RESIZE_PAGE_STEP = 50;

const DAINTREE_HOME_URL = "https://daintree.org";
const ASSISTANT_DOCS_URL = "https://daintree.org/assistant";

interface HelpPanelProps {
  /**
   * Configured panel width in pixels (the stable stored size, never 0).
   * Visibility is controlled by the `isVisible` prop; the panel always
   * renders at this width inside AppLayout's reserved right sidebar slot.
   */
  width: number;
  /**
   * Whether the panel is visible. When false, AppLayout collapses the clipped
   * right-sidebar slot so the panel grid slides over it. Defaults to width > 0
   * for backward compatibility.
   */
  isVisible?: boolean;
  /**
   * Startup gate supplied by AppLayout. The help panel can mount while global
   * state is still hydrating, but it must not launch the assistant terminal
   * until project state is available because provisioning is what proves MCP
   * readiness and writes the session-scoped .mcp.json.
   */
  isReadyToLaunch?: boolean;
  /**
   * Fires at the start of a pointer drag-resize so AppLayout can suppress
   * its `transition-[width]` while the user drags. Issue #7627.
   */
  onResizeStart?: () => void;
  /**
   * Fires at the end of a pointer drag-resize. Restores the parent transition
   * for non-drag width changes (collapse/expand toggle).
   */
  onResizeEnd?: () => void;
}

export function HelpPanel({
  width: effectiveWidth,
  isVisible: isVisibleProp,
  isReadyToLaunch = true,
  onResizeStart,
  onResizeEnd,
}: HelpPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HybridInputBarHandle>(null);
  // Element that owned focus when the panel last opened. We restore focus to
  // it on close so keyboard users return to where they were rather than
  // body. Mirrors the pattern in AppDialog/AppPaletteDialog.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const isMacroFocused = useMacroFocusStore((s) => s.focusedRegion === "assistant");
  // Ordinary DOM focus (click-to-focus, programmatic) inside the aside — the
  // macro-focus signal only fires on keyboard region cycling, so without this
  // the panel shows no "active surface" affordance when the user clicks in.
  const [hasDomFocus, setHasDomFocus] = useState(false);
  const isHighlighted = isMacroFocused || hasDomFocus;
  const isVisible = isVisibleProp ?? effectiveWidth > 0;
  // Clear the focus highlight when the panel collapses — a width collapse can
  // tear down the focused descendant (e.g. xterm) without firing a blur,
  // which would otherwise leave the lift stuck on across a reopen.
  useEffect(() => {
    if (!isVisible) setHasDomFocus(false);
  }, [isVisible]);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showAgentSwitchConfirm, setShowAgentSwitchConfirm] = useState(false);
  // Tracks the last preferredAgentId the switch effect acted on so a single
  // preference change drives at most one switch attempt (the effect re-runs
  // on unrelated dep changes while the async launch settles).
  const prevPreferredAgentIdRef = useRef<string | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  // useState lazy initializer guarantees a single instantiation across
  // renders and StrictMode double-mount, and unlike a ref it doesn't trip
  // React Compiler's "no ref access during render" rule. The constructor is
  // pure; side effects live in `start()` which fires from the lifecycle
  // effect below.
  const [controller] = useState(() => new HelpSessionController());

  const session = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const {
    isOpen,
    width,
    terminalId,
    sessionId,
    agentId,
    preferredAgentId,
    droppedPreferredAgentId,
    introDismissed,
    conversationTouched,
    focusRequest,
    markConversationStarted,
    setWidth,
    setOpen,
    dismissIntro,
    clearDroppedPreferredAgent,
  } = useHelpPanelStore();

  const terminal = usePanelStore((s) => (terminalId ? s.panelsById[terminalId] : undefined));
  // Mirrors useGettingStartedChecklist.ts:45-55 — must stay in sync. Gates the
  // intro banner so it never reappears once the user has launched any assistant
  // (`everDetectedAgent` is persisted via panelStore so this survives restarts).
  const hasEverLaunchedAgent = usePanelStore((s) =>
    s.panelIds.some((id) => {
      const p = s.panelsById[id];
      return (
        Boolean(p?.launchAgentId) || Boolean(p?.detectedAgentId) || p?.everDetectedAgent === true
      );
    })
  );
  const cliDetail = useCliAvailabilityStore((s) => (agentId ? s.details[agentId] : undefined));
  const cliAvailability = useCliAvailabilityStore((s) => s.availability);
  const cliHasRealData = useCliAvailabilityStore((s) => s.hasRealData);
  const currentProject = useProjectStore((s) => s.currentProject);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);

  // The ActionContext pinned to this session at launch (#8772). Fetched once
  // per session id — the binding is fixed at provision time and only changes
  // when the session itself is replaced, which swaps `sessionId`. The token
  // never crosses the bridge; the getter is keyed on the public session id.
  const [pinnedContext, setPinnedContext] = useState<PinnedActionContextSnapshot | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setPinnedContext(null);
      return;
    }
    let cancelled = false;
    void window.electron.help
      .getPinnedActionContext(sessionId)
      .then((snapshot) => {
        if (!cancelled) setPinnedContext(snapshot);
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to fetch pinned action context", err);
        if (!cancelled) setPinnedContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const focusedWorktreeId = useWorktreeSelectionStore((s) => s.focusedWorktreeId);
  const pinnedTerminalPanel = usePanelStore((s) =>
    pinnedContext?.terminalId ? s.panelsById[pinnedContext.terminalId] : undefined
  );
  // Escalation: danger when the pinned terminal is gone or has exited (its
  // PTY can no longer receive dispatched commands), warning when the user has
  // since focused a different worktree than the one the session is bound to.
  // Danger wins — a dead target is the more urgent mismatch.
  const isPinnedTerminalDead =
    pinnedContext?.terminalId != null &&
    (!pinnedTerminalPanel || pinnedTerminalPanel.exitCode !== undefined);
  const isPinnedWorktreeDiverged =
    pinnedContext?.worktreeId != null &&
    focusedWorktreeId !== null &&
    pinnedContext.worktreeId !== focusedWorktreeId;

  const agentConfig = agentId ? getAgentConfig(agentId) : undefined;
  const effectiveAgentId = isBuiltInAgentId(agentId) ? agentId : undefined;
  const showHybridInputBar = shouldShowHybridInputBar({
    hasAgentIdentity: effectiveAgentId !== undefined,
    hybridInputEnabled,
    isFleetArmed: false,
    fleetSize: 0,
  });

  // Intersection of "wired for the assistant overlay" and "CLI is installed".
  // Drives the single-supported-agent auto-skip in the controller.
  const supportedInstalledAgentIds = useMemo(() => {
    if (!cliHasRealData) return [];
    return getAssistantSupportedAgentIds().filter((id) => isAgentInstalled(cliAvailability[id]));
  }, [cliHasRealData, cliAvailability]);
  const supportedInstalledAgentIdsKey = supportedInstalledAgentIds.join(",");

  // Lifecycle — arms IPC subscriptions on mount, clears all timers on
  // unmount. `start()` is idempotent across StrictMode's double-mount.
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  // Sync the controller's inputs whenever the upstream state changes. The
  // controller decides what to do (clear version block, arm hibernate,
  // attempt auto-launch). Centralizing the inputs means the controller can
  // reason about transitions (e.g. preferredAgentId changing mid-launch)
  // without scattering effects across the component.
  useEffect(() => {
    controller.syncInputs({
      isOpen,
      isReadyToLaunch,
      currentProject: currentProject ? { id: currentProject.id, path: currentProject.path } : null,
      terminalId,
      preferredAgentId,
      supportedInstalledAgentIds,
      visibilityEpoch,
    });
  }, [
    controller,
    isOpen,
    isReadyToLaunch,
    currentProject,
    terminalId,
    preferredAgentId,
    supportedInstalledAgentIdsKey,
    supportedInstalledAgentIds,
    visibilityEpoch,
  ]);

  // The renderer being hidden is NOT a teardown signal. A hidden renderer
  // means one of: project-switch cached, project-switch about-to-be-evicted,
  // window minimize, or system sleep. The assistant must survive all four —
  // PTY/MCP lifecycle is owned by main, hibernation capture for true eviction
  // happens in `HelpSessionService.revokeByWebContentsId`, and sleep is
  // already a no-op because PTY pauses/resumes. Restore bumps the epoch so
  // `_maybeAutoLaunch` re-evaluates (the auto-launch path short-circuits
  // while hidden).
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) {
        setVisibilityEpoch((e) => e + 1);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
    };
  }, []);

  // Revoke the bound help session if the underlying PTY panel disappears
  // from the panel store. The controller's `_pendingNewTerminalId` guard
  // keeps the reservation alive across the brief addPanel/setTerminal gap.
  useEffect(() => {
    if (terminalId) {
      controller.handleTerminalPanelMissing({
        terminalId,
        terminalExists: Boolean(terminal),
      });
    }
  }, [controller, terminalId, terminal]);

  // Latch conversationTouched when the terminal's agent state first leaves
  // idle so the close-confirm guard protects accumulated chat history
  // indefinitely.
  useEffect(() => {
    if (terminalId && terminal?.agentState !== undefined && terminal.agentState !== "idle") {
      const store = useHelpPanelStore.getState();
      if (store.terminalId === terminalId) {
        markConversationStarted();
      }
    }
  }, [terminalId, terminal?.agentState, markConversationStarted]);

  // React to a Settings agent change while a session is already bound.
  // `setTerminal` no longer overwrites `preferredAgentId`, so a user choice
  // made in the Daintree Assistant settings tab reaches here as a genuine
  // change. Replace the live session with the chosen agent, gated by the
  // same D1 confirm as a new session when there's a conversation to lose.
  // (#8353 — switching the assistant agent was a silent no-op.)
  useEffect(() => {
    // No preference, or no live session to replace. Do NOT record the value
    // yet — a preference chosen before a terminal binds must still trigger
    // the switch once the terminal appears (#8353 critical fix).
    if (!preferredAgentId || !terminalId) return;
    // Already running the preferred agent — covers first-mount hydration and
    // the user reverting the dropdown back to the live agent. Reconcile any
    // open confirm so a stale "Switch to X?" prompt can't fire the wrong
    // agent after the preference moved on.
    if (preferredAgentId === agentId) {
      prevPreferredAgentIdRef.current = preferredAgentId;
      if (showAgentSwitchConfirm) setShowAgentSwitchConfirm(false);
      return;
    }
    // Dedupe: this preference, against the current live agent, was already
    // acted on (the effect re-runs on unrelated dep changes while the async
    // launch settles).
    if (prevPreferredAgentIdRef.current === preferredAgentId) return;
    prevPreferredAgentIdRef.current = preferredAgentId;
    const shouldConfirm =
      (terminal?.agentState !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(terminal.agentState)) ||
      conversationTouched;
    if (shouldConfirm) {
      // The dialog title and confirm action both read live `preferredAgentId`,
      // so a retarget to a third agent while the dialog is open tracks the
      // latest preference without needing a separate pending field.
      setShowAgentSwitchConfirm(true);
      return;
    }
    controller.selectAgent(preferredAgentId);
  }, [
    controller,
    preferredAgentId,
    terminalId,
    agentId,
    terminal?.agentState,
    conversationTouched,
    showAgentSwitchConfirm,
  ]);

  // Auto-snapshot pre-flight: when the project's MCP tier is `system`, take
  // a pre-flight snapshot once per session and surface a Tier-1 banner.
  useEffect(() => {
    if (!terminalId || !terminal) return;
    const worktreeId = terminal.worktreeId ?? activeWorktreeId;
    return controller.maybeRunPreflightSnapshot({
      terminalId,
      terminalExists: true,
      projectId: currentProject?.id ?? null,
      worktreeId,
    });
  }, [controller, terminalId, terminal, currentProject?.id, activeWorktreeId]);

  // Register the panel root with the macro-focus store so the assistant
  // participates in cross-region cycling.
  useEffect(() => {
    useMacroFocusStore.getState().setRegionRef("assistant", panelRef.current);
    return () => useMacroFocusStore.getState().setRegionRef("assistant", null);
  }, []);

  // Move keyboard focus into the panel on open and restore it on close.
  // focusRequest re-triggers this effect so repeated Cmd+L presses can
  // re-focus a blurred panel without closing it.
  useEffect(() => {
    if (isOpen && isVisible) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !panelRef.current?.contains(active)) {
        previousFocusRef.current = active;
      }
      const raf = requestAnimationFrame(() => {
        const state = useHelpPanelStore.getState();
        if (!state.isOpen) return;

        const current = document.activeElement;
        if (
          (current?.closest?.(".xterm-helper-textarea") || current?.closest?.(".cm-editor")) &&
          panelRef.current?.contains(current)
        ) {
          return;
        }

        // When an agent terminal is running, target the HybridInputBar editor
        // first (when available), then the xterm input as fallback. The bar
        // ref is null during the lazy Suspense window — in that case fall back
        // to xterm so cold-load opens still focus something.
        //
        // `focusWithCursorAtEnd()` schedules `view.focus()` inside its own
        // requestAnimationFrame (HybridInputBar.tsx:538), so we cannot
        // synchronously check `document.activeElement` after calling it. We
        // trust the bar's internal rAF to take focus when its ref is present
        // — no xterm fallback in that branch, otherwise CodeMirror would
        // steal focus from xterm one frame later and produce a focus flicker.
        if (terminalId && terminal && terminal.spawnStatus !== "missing-cli") {
          if (showHybridInputBar && inputBarRef.current) {
            inputBarRef.current.focusWithCursorAtEnd();
            return;
          }
          terminalInstanceService.focus(terminalId);
          const after = document.activeElement;
          if (after?.closest?.(".xterm-helper-textarea") && panelRef.current?.contains(after)) {
            return;
          }
        }

        const candidates = panelRef.current?.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
        let first: HTMLElement | undefined;
        for (const el of candidates ?? []) {
          if (el.getAttribute("role") === "separator") continue;
          first = el;
          break;
        }
        if (first) {
          first.focus();
        } else {
          panelRef.current?.focus();
        }
      });
      return () => cancelAnimationFrame(raf);
    }
    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    if (el && document.contains(el) && !panelRef.current?.contains(el)) {
      el.focus();
    }
    return undefined;
  }, [isOpen, isVisible, focusRequest, terminalId, terminal, showHybridInputBar]);

  // Resize via mouse drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onResizeStart?.();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(
          Math.max(startWidth + delta, HELP_PANEL_MIN_WIDTH),
          HELP_PANEL_MAX_WIDTH
        );
        setWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        onResizeEnd?.();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [width, setWidth, onResizeStart, onResizeEnd]
  );

  // Resize via keyboard.
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidth(Math.min(width + RESIZE_STEP, HELP_PANEL_MAX_WIDTH));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidth(Math.max(width - RESIZE_STEP, HELP_PANEL_MIN_WIDTH));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setWidth(Math.min(width + RESIZE_PAGE_STEP, HELP_PANEL_MAX_WIDTH));
      } else if (e.key === "PageDown") {
        e.preventDefault();
        setWidth(Math.max(width - RESIZE_PAGE_STEP, HELP_PANEL_MIN_WIDTH));
      } else if (e.key === "Home") {
        e.preventDefault();
        setWidth(HELP_PANEL_MIN_WIDTH);
      } else if (e.key === "End") {
        e.preventDefault();
        setWidth(HELP_PANEL_MAX_WIDTH);
      }
    },
    [width, setWidth]
  );

  // Hide the panel without tearing down the agent or conversation.
  const handleClose = useCallback(() => {
    suppressSidebarResizes();
    setOpen(false);
  }, [setOpen]);

  // Confirm only when there's something to lose — a working agent or a
  // conversation the user has actually engaged with.
  const shouldConfirmNewSession =
    (terminal?.agentState !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(terminal.agentState)) ||
    conversationTouched;

  const handleNewSession = useCallback(() => {
    if (!terminalId || !agentId) return;
    if (shouldConfirmNewSession) {
      setShowNewSessionConfirm(true);
      return;
    }
    controller.newSession();
  }, [controller, terminalId, agentId, shouldConfirmNewSession]);

  const handleConfirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    controller.newSession();
  }, [controller]);

  const handleCancelNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
  }, []);

  const handleConfirmAgentSwitch = useCallback(() => {
    setShowAgentSwitchConfirm(false);
    // Guard against the preference having moved back to the running agent (or
    // cleared) between opening the dialog and confirming.
    if (preferredAgentId && preferredAgentId !== agentId) {
      controller.selectAgent(preferredAgentId);
    }
  }, [controller, preferredAgentId, agentId]);

  // Leave preferredAgentId as the user set it — reverting it on cancel would
  // be a silent fallback the dropdown wouldn't reflect. The session simply
  // stays on the running agent until the user confirms a switch.
  const handleCancelAgentSwitch = useCallback(() => {
    setShowAgentSwitchConfirm(false);
  }, []);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "assistant" }, { source: "user" });
  }, []);

  const handleOpenAssistantDocs = useCallback(() => {
    void actionService.dispatch(
      "system.openExternal",
      { url: ASSISTANT_DOCS_URL },
      { source: "user" }
    );
  }, []);

  const handleRunAnyway = useCallback(() => {
    controller.runAnyway();
  }, [controller]);

  const dismissResume = useCallback(() => controller.dismissResumeBanner(), [controller]);
  const dismissSnapshot = useCallback(() => controller.dismissPreflightSnapshot(), [controller]);
  const dismissTierMismatch = useCallback(() => controller.dismissTierMismatch(), [controller]);
  const approveTierOnce = useCallback(() => controller.approveTierOnce(), [controller]);
  const alwaysAllowTier = useCallback(() => controller.alwaysAllowTier(), [controller]);
  const cancelLaunch = useCallback(() => controller.cancelLaunch(), [controller]);
  const checkVersionAgain = useCallback(() => controller.checkVersionAgain(), [controller]);
  const dismissLaunchError = useCallback(() => controller.dismissLaunchError(), [controller]);
  const retryLaunch = useCallback(() => {
    const agentId = session.launchError?.agentId;
    if (agentId) controller.launch({ agentId });
  }, [controller, session.launchError]);

  // Esc-to-close. The xterm-helper-textarea check lets Escape reach the
  // running PTY when the assistant terminal has focus; the .cm-editor check
  // lets the HybridInputBar dismiss its autocomplete / expanded modal first.
  // Both guards are scoped to the panel so a focused CodeMirror or xterm in a
  // different panel (e.g. FileViewer, a grid terminal) can't trap Escape here.
  const handleEscape = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && panelRef.current?.contains(active)) {
      if (active.closest(".xterm-helper-textarea")) return;
      if (active.closest(".cm-editor")) return;
    }
    handleClose();
  }, [handleClose]);
  useEscapeStack(isOpen, handleEscape);

  const getRefreshTier = useMemo(() => {
    return () => {
      if (!isOpen) return TerminalRefreshTier.BACKGROUND;
      return getTerminalRefreshTier(terminal, true);
    };
  }, [isOpen, terminal]);

  const showTerminal = terminalId && terminal;
  const isMissingCli = showTerminal && terminal?.spawnStatus === "missing-cli";

  return (
    <aside
      ref={panelRef}
      id="daintree-assistant-panel"
      role="region"
      tabIndex={-1}
      aria-label="Daintree Assistant"
      // `inert` removes descendants from focus / a11y tree while the aside
      // is collapsed. Chromium 146 supports it natively, so we don't need a
      // matching `aria-hidden` (which would also be redundant on an `inert`
      // element per ARIA 1.2 and trips axe's `aria-hidden-focus` rule).
      inert={!isVisible || undefined}
      data-macro-focus={isMacroFocused ? "true" : undefined}
      onFocus={() => setHasDomFocus(true)}
      onBlur={(e) => {
        // Keep the highlight while focus moves between controls inside the
        // aside (xterm textarea ↔ header buttons). `contains(null)` is false,
        // so window/page blur correctly clears it.
        if (!e.currentTarget.contains(e.relatedTarget)) setHasDomFocus(false);
      }}
      className={cn(
        "relative shrink-0 flex flex-col h-full overflow-hidden outline-hidden",
        "bg-daintree-bg border-l border-daintree-border",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
        !isVisible && "pointer-events-none"
      )}
      style={{ width: effectiveWidth }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Daintree Assistant panel"
        aria-controls="daintree-assistant-panel"
        aria-valuenow={width}
        aria-valuemin={HELP_PANEL_MIN_WIDTH}
        aria-valuemax={HELP_PANEL_MAX_WIDTH}
        tabIndex={isVisible ? 0 : -1}
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10",
          "hover:bg-overlay-soft active:bg-overlay-medium transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2",
          isResizing && "bg-overlay-medium"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />

      <HelpPanelHeader
        agentState={terminal?.agentState}
        canStartNewSession={Boolean(terminalId && agentId)}
        onNewSession={handleNewSession}
        onOpenDocs={handleOpenAssistantDocs}
        onClose={handleClose}
        isFocused={isHighlighted}
      />

      {/* Content */}
      <div ref={contentRef} className="flex-1 flex flex-col min-h-0 relative">
        {/* Banners render above every content state — the launch-error banner
            must stay visible in the empty state a failed launch falls back to.
            The other banners are null unless a session is live, so this mount
            position is behaviorally identical for them. */}
        <HelpPanelBanners
          showResumeBanner={session.showResumeBanner}
          preflightSnapshot={session.preflightSnapshot}
          tierMismatch={session.tierMismatch}
          launchError={session.launchError}
          isApprovingTier={session.isApprovingTier}
          onDismissResume={dismissResume}
          onDismissSnapshot={dismissSnapshot}
          onDismissTierMismatch={dismissTierMismatch}
          onApproveOnce={approveTierOnce}
          onAlwaysAllow={alwaysAllowTier}
          onRetryLaunch={retryLaunch}
          onDismissLaunchError={dismissLaunchError}
          onOpenAssistantSettings={handleOpenSettings}
        />
        {showTerminal ? (
          isMissingCli && agentId ? (
            <MissingCliGate
              agentId={agentId}
              detail={cliDetail ?? { state: "missing", resolvedPath: null, via: null }}
              onRunAnyway={handleRunAnyway}
            />
          ) : (
            <>
              {!introDismissed && !hasEverLaunchedAgent && (
                <HelpIntroBanner onDismiss={dismissIntro} />
              )}
              <div className="flex-1 relative min-h-0">
                <Suspense fallback={null}>
                  <XtermAdapter
                    terminalId={terminalId}
                    launchAgentId={agentId ?? undefined}
                    getRefreshTier={getRefreshTier}
                    cwd={terminal.cwd}
                    hasBottomBar={showHybridInputBar}
                  />
                </Suspense>
              </div>
              {showHybridInputBar && (
                <Suspense fallback={null}>
                  <LazyHybridInputBar
                    ref={inputBarRef}
                    terminalId={terminalId}
                    cwd={terminal?.cwd ?? ""}
                    agentId={effectiveAgentId}
                    agentHasLifecycleEvent={terminal?.stateChangeTrigger !== undefined}
                    agentState={terminal?.agentState}
                    disabled={terminal?.isInputLocked === true}
                    onSend={({ text }) => {
                      if (terminal?.isInputLocked === true) return;
                      terminalInstanceService.notifyUserInput(terminalId);
                      // submit can now reject for dead PTYs (#8706); swallow
                      // to log so the unhandled rejection doesn't leak — the
                      // help panel is a one-shot send with no recovery UI.
                      terminalClient.submit(terminalId, text).catch((err) => {
                        logWarn("[HelpPanel] submit failed", { terminalId, error: err });
                      });
                    }}
                    onSendKey={(key) => {
                      if (terminal?.isInputLocked === true) return;
                      terminalInstanceService.notifyUserInput(terminalId);
                      terminalClient.sendKey(terminalId, key);
                    }}
                  />
                </Suspense>
              )}
            </>
          )
        ) : session.assistantVersionTooOld ? (
          <HelpPanelVersionGate
            versionTooOld={session.assistantVersionTooOld}
            onOpenSettings={handleOpenSettings}
            onCheckAgain={checkVersionAgain}
            isCheckingVersion={session.isCheckingVersion}
          />
        ) : session.phase !== "idle" && session.phase !== "live" ? (
          <HelpLaunchingState phase={session.phase} isLoading onCancel={cancelLaunch} />
        ) : (
          <div className="flex-1 flex flex-col">
            {droppedPreferredAgentId && (
              <div
                role="alert"
                className={cn(
                  "flex items-start gap-2 px-3 py-2.5 mx-3 mt-3 mb-1",
                  "rounded-[var(--radius-md)]",
                  "bg-status-warning/10 border border-status-warning/40",
                  "text-xs text-daintree-text/85"
                )}
                data-testid="help-dropped-agent-banner"
              >
                <ShieldAlert
                  className="w-3.5 h-3.5 shrink-0 mt-0.5 text-status-warning"
                  aria-hidden="true"
                />
                <div className="flex-1 select-text">
                  <p className="font-medium text-daintree-text">
                    {getAgentConfig(droppedPreferredAgentId)?.name ?? droppedPreferredAgentId} is no
                    longer available
                  </p>
                  <p className="mt-0.5 text-daintree-text/70">
                    The agent was removed or is no longer supported as an assistant backend.
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenSettings}
                    className="mt-1 text-daintree-text/70 hover:text-daintree-text underline underline-offset-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                  >
                    Open assistant settings
                  </button>
                </div>
                <button
                  type="button"
                  onClick={clearDroppedPreferredAgent}
                  aria-label="Dismiss"
                  className="text-daintree-text/50 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
              <p className="text-sm text-daintree-text/70 max-w-[30ch]">
                Use Daintree Assistant to configure and navigate Daintree.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className="flex items-center gap-1 text-[11px] text-daintree-text/40 hover:text-daintree-text/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  Assistant settings
                </button>
                <button
                  type="button"
                  onClick={handleOpenAssistantDocs}
                  className="flex items-center gap-1 text-[11px] text-daintree-text/40 hover:text-daintree-text/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Daintree Assistant guide
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom info bar */}
      {showTerminal && agentConfig && !isMissingCli && (
        <div className="flex flex-col gap-1 border-t border-daintree-border shrink-0 px-3 py-1.5 text-[11px] text-daintree-text/40">
          {pinnedContext && (
            <span
              className="flex items-center gap-1.5 min-w-0"
              title={
                isPinnedTerminalDead
                  ? "The terminal this assistant was pinned to has closed — its tool calls can't reach it."
                  : isPinnedWorktreeDiverged
                    ? "This assistant is pinned to a different worktree than the one you have focused."
                    : "Assistant tool calls are pinned to this worktree and terminal."
              }
            >
              <span
                aria-hidden
                className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  isPinnedTerminalDead
                    ? "bg-status-danger"
                    : isPinnedWorktreeDiverged
                      ? "bg-status-warning"
                      : "bg-daintree-text/30"
                )}
              />
              <span className="truncate">
                {[pinnedContext.worktreeName, pinnedContext.worktreeBranch]
                  .filter(Boolean)
                  .join(" · ") || "Pinned session"}
              </span>
            </span>
          )}
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              Using
              <agentConfig.icon className="w-3.5 h-3.5" />
              {agentConfig.name}
            </span>
            <button
              type="button"
              onClick={() =>
                void actionService.dispatch(
                  "system.openExternal",
                  { url: DAINTREE_HOME_URL },
                  { source: "user" }
                )
              }
              className="flex items-center gap-1 hover:text-daintree-text/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            >
              <DaintreeIcon className="w-3.5 h-3.5" />
              Daintree.org
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title="Start a new session?"
        description="The current agent will stop and the conversation will be discarded."
        confirmLabel="Start new session"
        onConfirm={handleConfirmNewSession}
        onClose={handleCancelNewSession}
        variant="destructive"
      />
      <ConfirmDialog
        isOpen={showAgentSwitchConfirm}
        title={`Switch to ${
          getAgentConfig(preferredAgentId ?? "")?.name ?? preferredAgentId ?? "agent"
        }?`}
        description="The current session will end and the conversation will be discarded."
        confirmLabel="Switch agent"
        onConfirm={handleConfirmAgentSwitch}
        onClose={handleCancelAgentSwitch}
        variant="destructive"
      />
    </aside>
  );
}
