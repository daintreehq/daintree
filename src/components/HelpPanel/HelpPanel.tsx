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
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, MessageCircle, Settings2, ShieldAlert, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { McpActivityStrip } from "./McpActivityStrip";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { TurnOutcomePip } from "./TurnOutcomePip";
import { FigureRail } from "./FigureRail";
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
import { buildResumeLatestCommand } from "@shared/types/agentSettings";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { TerminalRefreshTier } from "@/types";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";
import { HelpSessionController } from "@/controllers/HelpSessionController";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const RESIZE_STEP = 10;
const RESIZE_PAGE_STEP = 50;

const ASSISTANT_DOCS_URL = "https://daintree.org/assistant";
const ASSISTANT_INSTALLER_URL = "https://daintree.org/download";

// First-run starter prompts. Clicking one starts the assistant AND seeds the
// agent with the question, so the very first session is an explicit, useful
// action rather than a bare empty terminal. Shown only before the user has
// ever launched an agent (#10699).
const STARTER_PROMPTS = [
  "How do I set up a new worktree?",
  "Explain Daintree's panel system",
  "Help me configure my first agent",
] as const;

interface HelpPanelProps {
  /**
   * Configured panel width in pixels (the stable stored size, never 0).
   * Visibility is controlled by the `isVisible` prop; the panel always
   * renders at this width inside AppLayout's reserved right sidebar slot.
   */
  width: number;
  /**
   * Whether the panel is visible. When false, AppLayout slides the fixed-width
   * wrapper off-canvas via transform while a sibling spacer animates the <main>
   * push, and marks the parked wrapper inert once the slide settles (#10693).
   * Defaults to width > 0 for backward compatibility.
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
  // Idempotent teardown for an in-flight resize drag. Stored in a ref so an
  // unmount (or window blur) mid-drag can run it and never leak the document
  // listeners or the body userSelect/cursor overrides. Mirrors TwoPaneSplitDivider.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
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
    autoLaunchEnabled,
    droppedPreferredAgentId,
    introDismissed,
    conversationTouched,
    focusRequest,
    figures,
    markConversationStarted,
    setWidth,
    setOpen,
    setAutoLaunchEnabled,
    dismissIntro,
    clearDroppedPreferredAgent,
  } = useHelpPanelStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      width: s.width,
      terminalId: s.terminalId,
      sessionId: s.sessionId,
      agentId: s.agentId,
      preferredAgentId: s.preferredAgentId,
      autoLaunchEnabled: s.autoLaunchEnabled,
      droppedPreferredAgentId: s.droppedPreferredAgentId,
      introDismissed: s.introDismissed,
      conversationTouched: s.conversationTouched,
      focusRequest: s.focusRequest,
      figures: s.figures,
      markConversationStarted: s.markConversationStarted,
      setWidth: s.setWidth,
      setOpen: s.setOpen,
      setAutoLaunchEnabled: s.setAutoLaunchEnabled,
      dismissIntro: s.dismissIntro,
      clearDroppedPreferredAgent: s.clearDroppedPreferredAgent,
    }))
  );

  const terminal = usePanelStore((s) => (terminalId ? s.panelsById[terminalId] : undefined));
  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;
  // Mirrors useGettingStartedChecklist.ts:45-55 — must stay in sync. Gates the
  // intro banner so it never reappears once the user has launched any assistant
  // (`everDetectedAgent` is persisted via panelStore so this survives restarts).
  const hasEverLaunchedAgent = usePanelStore((s) =>
    s.panelIds.some((id) => {
      const p = s.panelsById[id];
      if (!p || !isPtyPanel(p)) return false;
      return Boolean(p.launchAgentId) || Boolean(p.detectedAgentId) || p.everDetectedAgent === true;
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
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  // Tool calls re-resolve their target terminal live at dispatch time, so the
  // frozen provision-time `pinnedContext.terminalId` going stale doesn't mean
  // they can't reach anything. The only recoverable mismatch worth surfacing in
  // the footer is divergence: the user focused a different worktree than the one
  // the session is bound to, fixable in one click. (Closing every grid terminal
  // is a normal action, not a failure — the dock-hosted chat keeps working — so
  // it no longer paints the footer red; #10792.)
  const isPinnedWorktreeDiverged =
    pinnedContext?.worktreeId != null &&
    focusedWorktreeId !== null &&
    pinnedContext.worktreeId !== focusedWorktreeId;

  const agentConfig = agentId ? getAgentConfig(agentId) : undefined;
  // The model the live session actually launched with, read from its persisted
  // launch flags (not current settings — those can drift after the session
  // starts). `lastIndexOf` so a custom-args `--model` override wins, matching the
  // CLI's last-flag semantics. Resolved to the catalog short label when known.
  const launchedModelLabel = useMemo(() => {
    const flags = terminalPty?.agentLaunchFlags;
    if (!flags || !agentId) return null;
    // Scan from the end so a later (custom-args) --model override wins, matching
    // the CLI's last-flag semantics. Handles both "--model X" and "--model=X",
    // and ignores a dangling "--model" or one followed by another flag.
    let modelId: string | null = null;
    for (let i = flags.length - 1; i >= 0; i--) {
      const flag = flags[i];
      if (!flag) continue;
      if (flag.startsWith("--model=")) {
        modelId = flag.slice("--model=".length);
        break;
      }
      const next = flags[i + 1];
      if (flag === "--model" && next && !next.startsWith("-")) {
        modelId = next;
        break;
      }
    }
    if (!modelId) return null;
    return getAgentConfig(agentId)?.models?.find((m) => m.id === modelId)?.shortLabel ?? modelId;
  }, [terminalPty?.agentLaunchFlags, agentId]);
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

  // A conversation the eviction/crash path captured for this project but never
  // resumed. On LRU eviction (or renderer crash) main kills the assistant PTY
  // via HelpSessionService.revokeByWebContentsId — grid PTYs survive in the
  // pty-host, the assistant doesn't — and stashes a resume token in its
  // pending-hibernation store. When the idle empty state is about to show, peek
  // that store so we can offer "Resume assistant" instead of a fresh "Start
  // assistant", making a project switch-back read as a recoverable pause rather
  // than a crash. The peek is non-consuming: the launch flow still consumes the
  // entry via takePendingHibernation. We stamp the entry with its projectId so a
  // mid-flight A→B switch can't show project A's Resume CTA over project B.
  const [resumablePending, setResumablePending] = useState<{
    projectId: string;
    agentId: string;
  } | null>(null);
  const currentProjectId = currentProject?.id ?? null;
  useEffect(() => {
    if (!isOpen || terminalId || !currentProjectId) {
      setResumablePending(null);
      return;
    }
    // Optional-chained like the `onViewRevealed` subscription below: a missing
    // binding degrades to the normal "Start assistant" CTA rather than throwing.
    const peek = window.electron.help.peekPendingHibernation?.(currentProjectId);
    if (!peek) {
      setResumablePending(null);
      return;
    }
    let cancelled = false;
    void peek
      .then((pending) => {
        if (cancelled) return;
        const pendingAgentId = pending?.agentId ?? null;
        // Offer Resume only for an agent that is BOTH still installed AND
        // actually resume-capable. A captured-but-non-resumable agent (e.g. the
        // built-in assistant — no `resume` config) would dead-end in
        // `_spawnResumed` and silently start fresh, so "Resume" would lie.
        // `buildResumeLatestCommand` is the same capability probe the controller
        // uses for live agents.
        const canResume =
          pendingAgentId != null &&
          supportedInstalledAgentIds.includes(pendingAgentId) &&
          buildResumeLatestCommand(pendingAgentId) !== undefined;
        setResumablePending(
          canResume ? { projectId: currentProjectId, agentId: pendingAgentId } : null
        );
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to peek pending hibernation", err);
        if (!cancelled) setResumablePending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    terminalId,
    currentProjectId,
    supportedInstalledAgentIdsKey,
    supportedInstalledAgentIds,
  ]);

  // Cross-project bleed guard: an A→B switch re-runs the peek effect, but B's
  // peek resolves asynchronously, so only trust a pending entry whose projectId
  // matches the project currently in view.
  const resumableAgentId =
    resumablePending && resumablePending.projectId === currentProjectId
      ? resumablePending.agentId
      : null;

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
      autoLaunchEnabled,
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
    autoLaunchEnabled,
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

  // Recover a launch stranded by a project switch-back (#10739). When a launch
  // is interrupted mid-flight, the view is parked in the LRU cache where the
  // watchdog timer can't fire, leaving the loading skeleton stuck with no
  // terminal bound. Key off the explicit `app:view-revealed` signal (reliable
  // for cached-view reveal, unlike DOM `visibilitychange`) so the controller can
  // reap the stall and re-drive. Gated only on `isOpen` — crucially NOT on
  // `terminalId`, since the stuck-launch case has no terminal yet, nor on
  // `isVisible`, so the subscription is live the moment the cached view reveals.
  useEffect(() => {
    if (!isOpen) return;
    const off = window.electron?.app?.onViewRevealed?.(() => {
      controller.handleViewRevealed();
    });
    return () => off?.();
  }, [controller, isOpen]);

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
    if (terminalId && terminalPty?.agentState !== undefined && terminalPty.agentState !== "idle") {
      const store = useHelpPanelStore.getState();
      if (store.terminalId === terminalId) {
        markConversationStarted();
      }
    }
  }, [terminalId, terminalPty?.agentState, markConversationStarted]);

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
      (terminalPty?.agentState !== undefined &&
        CLOSE_CONFIRM_AGENT_STATES.has(terminalPty.agentState)) ||
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
    terminalPty?.agentState,
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
        if (
          terminalId &&
          terminal &&
          terminalPty?.spawnStatus !== "missing-cli" &&
          terminalPty?.spawnStatus !== "failed"
        ) {
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

  // Pin the WebGL context to the assistant terminal while it owns focus (#10672).
  // The reveal effect above only calls `focus()` (xterm DOM focus); it never
  // routes through `setFocused()`, which is the sole service path that calls
  // `webGLManager.pinFocus()`. Without this, when the fleet falls to DOM mode
  // (WebGL context count at cap) the assistant could never become the pinned
  // context and rendered garbled. Drive it from real DOM focus — not the reveal
  // trigger — so a closed/hidden-but-mounted panel never grabs the pin. The
  // cleanup's `setFocused(false)` covers close, visibility collapse, terminal
  // change, blur, and unmount; it only clears `managed.isFocused` (it does not
  // release the pin — that resolves on the next grid-terminal focus).
  useEffect(() => {
    if (!terminalId) return undefined;
    terminalInstanceService.setFocused(terminalId, isOpen && isVisible && hasDomFocus);
    return () => {
      terminalInstanceService.setFocused(terminalId, false);
    };
  }, [isOpen, isVisible, hasDomFocus, terminalId]);

  // Post-reveal repaint for the assistant terminal (#10362). The project-level
  // reveal sweep folds the assistant into its targets, but it repaints on a
  // fixed double-rAF tuned to the project grid — and this slide-out panel can
  // finish laying out a few frames later, so that pass can land before this
  // container has real geometry and no-op. Re-run the repaint from the panel's
  // own context, gated on the terminal container actually being sized, so it
  // fires exactly when the assistant is paintable.
  useEffect(() => {
    if (!isOpen || !isVisible || !terminalId) return;
    if (typeof requestAnimationFrame !== "function") return;

    // One reveal-correction pass: poll a few frames for the slide-out panel to
    // settle to real width, then repaint. Visibility-guarded so a backstop that
    // fires after the user switched away again no-ops.
    const runRepaintPass = (): void => {
      if (document.visibilityState !== "visible") return;
      let frames = 0;
      const tick = (): void => {
        if (!useHelpPanelStore.getState().isOpen) return;
        if (document.visibilityState !== "visible") return;
        // Wait for the container to have real width before repainting —
        // repaintForReveal's own size guard would otherwise no-op against a
        // not-yet-laid-out panel. Give up after a bounded window.
        if ((contentRef.current?.clientWidth ?? 0) >= HELP_PANEL_MIN_WIDTH / 4) {
          terminalInstanceService.repaintForReveal(terminalId);
          return;
        }
        if (++frames < 8) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    // Timed redraw backstop, mirroring the worktree-terminal reveal cadence
    // (WorktreeStoreContext): the single frame-sweep above is bounded to ~130ms
    // and never retries, but that window falls before the compositor presents
    // the foreground view, before xterm's IntersectionObserver un-pauses the
    // renderer, and inside the project-switch resize lock — exactly when a
    // repaint can't stick, leaving the Assistant garbled with no Redraw button
    // to recover it. Re-run the same cheap, idempotent, box-/visibility-guarded
    // repaint on a fixed cadence so a late-settling panel self-corrects: 1s
    // catches the common settle, 3s a late straggler.
    const REVEAL_BACKSTOP_DELAYS_MS = [1000, 3000];
    let backstopTimers: ReturnType<typeof setTimeout>[] = [];
    const clearRevealBackstops = (): void => {
      for (const timer of backstopTimers) clearTimeout(timer);
      backstopTimers = [];
    };

    const off = window.electron?.app?.onViewRevealed?.(() => {
      runRepaintPass();
      // Cancel any backstops still pending from a prior switch so rapid
      // back-and-forth switching can't stack passes, then arm this switch's.
      clearRevealBackstops();
      for (const delay of REVEAL_BACKSTOP_DELAYS_MS) {
        backstopTimers.push(setTimeout(runRepaintPass, delay));
      }
    });

    return () => {
      clearRevealBackstops();
      off?.();
    };
  }, [isOpen, isVisible, terminalId]);

  // Resize via mouse drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
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

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;

      // Idempotent: removing absent listeners and reassigning styles is a no-op,
      // so unmount/blur/mouseup can all call this without double-restore hazards.
      const cleanup = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("blur", onWindowBlur);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        resizeCleanupRef.current = null;
      };

      const endResize = () => {
        // Tear down listeners/styles before user callbacks so a throwing
        // onResizeEnd can't leak the global userSelect/cursor overrides.
        cleanup();
        setIsResizing(false);
        onResizeEnd?.();
      };

      const onMouseUp = () => endResize();
      // Drag interrupted (alt-tab, OS gesture) — restore everything; no commit
      // needed since width is applied live during the drag.
      const onWindowBlur = () => endResize();

      resizeCleanupRef.current = cleanup;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      window.addEventListener("blur", onWindowBlur);
      // Drop any live selection before the drag. userSelect:none below only
      // stops NEW drag-selections from forming; a selection that already exists
      // in the terminal still gets torn as the rows reflow, firing a document
      // `selectionchange` that makes xterm's AccessibilityManager recompute an
      // inverted (start >= end) range and throw "invalid range". Collapsing it
      // up front leaves nothing to tear (the collapse itself is handled by the
      // manager's isCollapsed early-return).
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
      // Suppress text selection during the drag. Without this, a fast drag
      // selects across the terminal rows while they reflow, and xterm's
      // AccessibilityManager throws "invalid range" on the torn selection.
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [width, setWidth, onResizeStart, onResizeEnd]
  );

  // Run any in-flight resize teardown if the panel unmounts mid-drag.
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

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
    (terminalPty?.agentState !== undefined &&
      CLOSE_CONFIRM_AGENT_STATES.has(terminalPty.agentState)) ||
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

  const handleOpenLogs = useCallback(() => {
    void actionService.dispatch("errors.openLogs", undefined, { source: "user" });
  }, []);

  const handleOpenInstallerPage = useCallback(() => {
    void actionService.dispatch(
      "system.openExternal",
      { url: ASSISTANT_INSTALLER_URL },
      { source: "user" }
    );
  }, []);

  const handleRunAnyway = useCallback(() => {
    controller.runAnyway();
  }, [controller]);

  // The agent the idle empty state's "Start assistant" CTA would launch — the
  // user's preference, or the sole installed assistant backend. Mirrors the
  // controller's own auto-launch eligibility so the CTA is shown only when a
  // single unambiguous target exists; otherwise the user is sent to settings.
  const launchableAgentId =
    preferredAgentId ??
    (supportedInstalledAgentIds.length === 1 ? (supportedInstalledAgentIds[0] ?? null) : null);

  // Explicit, billed start (#10699). Records consent so future opens may
  // auto-launch, then launches directly — relying on syncInputs re-evaluation
  // would leave a render-cycle gap. An optional starter prompt seeds the first
  // turn (skips the resume path by design).
  const handleStartAssistant = useCallback(
    (seedPrompt?: string) => {
      if (!launchableAgentId) return;
      setAutoLaunchEnabled(true);
      controller.launch({
        agentId: launchableAgentId,
        replaceExisting: true,
        ...(seedPrompt ? { seedPrompt } : {}),
      });
    },
    [controller, launchableAgentId, setAutoLaunchEnabled]
  );

  // Recovery resume after the eviction/crash path killed the assistant PTY on a
  // project switch-away. Unlike "Start assistant", this deliberately does NOT
  // record auto-launch consent (#10699): resuming a stranded session is a
  // one-time, user-initiated recovery, not an opt-in to billed auto-launch on
  // every future open. The launch flow seeds the captured entry from main and
  // spawns a `--resume` process (HelpSessionController._executeLaunch). Launched
  // with the captured agent id (not the CTA agent) so the resume branch — gated
  // on `hibernated.agentId === launchAgentId` — actually fires.
  const handleResumeAssistant = useCallback(() => {
    if (!resumableAgentId) return;
    controller.launch({
      agentId: resumableAgentId,
      replaceExisting: true,
    });
  }, [controller, resumableAgentId]);

  const dismissResume = useCallback(() => controller.dismissResumeBanner(), [controller]);
  const dismissSnapshot = useCallback(() => controller.dismissPreflightSnapshot(), [controller]);
  const dismissTierMismatch = useCallback(() => controller.dismissTierMismatch(), [controller]);
  const approveTierOnce = useCallback(() => controller.approveTierOnce(), [controller]);
  const alwaysAllowTier = useCallback(() => controller.alwaysAllowTier(), [controller]);
  const revokeGrant = useCallback(() => controller.revokeGrant(), [controller]);
  const dismissGrantEnded = useCallback(() => controller.dismissGrantEnded(), [controller]);
  const cancelLaunch = useCallback(() => controller.cancelLaunch(), [controller]);
  const checkVersionAgain = useCallback(() => controller.checkVersionAgain(), [controller]);
  const dismissLaunchError = useCallback(() => controller.dismissLaunchError(), [controller]);
  const dismissSessionRevoked = useCallback(() => controller.dismissSessionRevoked(), [controller]);
  const dismissOutcomeAlert = useCallback(() => controller.dismissOutcomeAlert(), [controller]);
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
    const active = document.activeElement;
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
  const isMissingCli = showTerminal && terminalPty?.spawnStatus === "missing-cli";

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
      data-macro-focus={isHighlighted ? "true" : undefined}
      onFocus={() => {
        setHasDomFocus(true);
        // Promote the assistant to the active macro region whenever DOM focus
        // lands inside the aside (mouse click, programmatic focus). Without
        // this, only keyboard cycling via Cmd+` would mark the assistant
        // active, leaving the grid's `terminal-selected` highlight stuck on
        // while the user is actually typing into the assistant.
        if (useMacroFocusStore.getState().focusedRegion !== "assistant") {
          useMacroFocusStore.setState({ focusedRegion: "assistant" });
        }
      }}
      onBlur={(e) => {
        // Keep the highlight while focus moves between controls inside the
        // aside (xterm textarea ↔ header buttons). `contains(null)` is false,
        // so window/page blur correctly clears it.
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setHasDomFocus(false);
          // Release the macro region only if we still own it — another region
          // may have already claimed focus by the time blur runs.
          if (useMacroFocusStore.getState().focusedRegion === "assistant") {
            useMacroFocusStore.setState({ focusedRegion: null });
          }
        }
      }}
      className={cn(
        "relative shrink-0 flex flex-col h-full overflow-hidden outline-hidden",
        "bg-daintree-bg border-l border-daintree-border transition-[border-left-color,box-shadow] duration-150",
        isHighlighted && "assistant-focused",
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
        agentState={terminalPty?.agentState}
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
          sessionRevoked={session.sessionRevoked}
          isApprovingTier={session.isApprovingTier}
          activeGrant={session.activeGrant}
          grantEnded={session.grantEnded}
          isRevokingGrant={session.isRevokingGrant}
          onDismissResume={dismissResume}
          onDismissSnapshot={dismissSnapshot}
          onDismissTierMismatch={dismissTierMismatch}
          onApproveOnce={approveTierOnce}
          onAlwaysAllow={alwaysAllowTier}
          onRevokeGrant={revokeGrant}
          onDismissGrantEnded={dismissGrantEnded}
          onRetryLaunch={retryLaunch}
          onDismissLaunchError={dismissLaunchError}
          onOpenAssistantSettings={handleOpenSettings}
          onOpenLogs={handleOpenLogs}
          onOpenInstallerPage={handleOpenInstallerPage}
          onStartNewSession={handleNewSession}
          onDismissSessionRevoked={dismissSessionRevoked}
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
                    cwd={terminalPty?.cwd}
                    hasBottomBar={showHybridInputBar}
                  />
                </Suspense>
              </div>
              {showHybridInputBar && (
                <Suspense fallback={null}>
                  <LazyHybridInputBar
                    ref={inputBarRef}
                    terminalId={terminalId}
                    cwd={terminalPty?.cwd ?? ""}
                    agentId={effectiveAgentId}
                    agentHasLifecycleEvent={terminalPty?.stateChangeTrigger !== undefined}
                    agentState={terminalPty?.agentState}
                    disabled={terminalPty?.isInputLocked === true}
                    onSend={({ text }) => {
                      if (terminalPty?.isInputLocked === true) return;
                      terminalInstanceService.notifyUserInput(terminalId);
                      // submit can now reject for dead PTYs (#8706); swallow
                      // to log so the unhandled rejection doesn't leak — the
                      // help panel is a one-shot send with no recovery UI.
                      terminalClient.submit(terminalId, text).catch((err) => {
                        logWarn("[HelpPanel] submit failed", { terminalId, error: err });
                      });
                    }}
                    onSendKey={(key) => {
                      if (terminalPty?.isInputLocked === true) return;
                      terminalInstanceService.notifyUserInput(terminalId);
                      terminalClient.sendKey(terminalId, key);
                    }}
                  />
                </Suspense>
              )}
              {figures.length > 0 && <FigureRail figures={figures} />}
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
                  "bg-status-warning/10 border border-status-warning/20",
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
                    The agent was removed or is no longer supported as an assistant backend
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
                  aria-label="Dismiss agent unavailable notice"
                  className="text-daintree-text/50 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
              <p className="text-sm text-daintree-text/70 max-w-[30ch]">
                {resumableAgentId
                  ? "Your last assistant session is paused"
                  : "Use Daintree Assistant to configure and navigate Daintree."}
              </p>
              {resumableAgentId ? (
                <div className="flex flex-col items-center gap-4 w-full max-w-[34ch]">
                  {/* Recovery resume — the eviction/crash path killed the PTY on
                      switch-away, but the conversation can be picked back up.
                      Does not record auto-launch consent (#10699), unlike "Start
                      assistant". This is the single load-bearing accent here.
                      Starting a fresh session is the header's "+ New session". */}
                  <Button
                    type="button"
                    onClick={handleResumeAssistant}
                    data-testid="help-resume-assistant"
                  >
                    <Sparkles />
                    Resume assistant
                  </Button>
                </div>
              ) : launchableAgentId ? (
                <div className="flex flex-col items-center gap-4 w-full max-w-[34ch]">
                  {/* Explicit start — opening the panel no longer auto-bills a
                      session (#10699); the user kicks it off here. This is the
                      single load-bearing accent in the idle focus region. */}
                  <Button
                    type="button"
                    onClick={() => handleStartAssistant()}
                    data-testid="help-start-assistant"
                  >
                    <Sparkles />
                    Start assistant
                  </Button>
                  {!hasEverLaunchedAgent && (
                    <div className="flex flex-col gap-1.5 w-full">
                      <p className="text-[11px] text-daintree-text/60">Or start with a question</p>
                      {STARTER_PROMPTS.map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => handleStartAssistant(prompt)}
                          className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/80 hover:text-daintree-text hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                        >
                          <MessageCircle className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" />
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-daintree-text/70 max-w-[32ch]">
                  Configure an assistant agent in settings to get started.
                </p>
              )}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className="flex items-center gap-1 text-[11px] text-daintree-text/70 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  Assistant settings
                </button>
                <button
                  type="button"
                  onClick={handleOpenAssistantDocs}
                  className="flex items-center gap-1 text-[11px] text-daintree-text/70 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Daintree Assistant guide
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom info bar — a single status row (#9763). Left: the live/recent
          tool-call activity element (popover trigger). Right: the pinned
          worktree·branch binding, then the agent identity anchored at the
          edge. Raw args, the elapsed ticker, and the marketing link live in
          the popover / hover titles / header docs button now. */}
      {showTerminal && agentConfig && !isMissingCli && (
        <div className="flex items-center justify-between gap-3 border-t border-daintree-border shrink-0 px-3 py-1.5 text-[11px] text-daintree-text/40">
          <span className="flex items-center gap-2 min-w-0">
            <McpActivityStrip sessionId={sessionId} activity={session.mcpActivity} />
            <TurnOutcomePip outcome={session.outcomeAlert} onDismiss={dismissOutcomeAlert} />
          </span>
          <span className="flex items-center gap-2 min-w-0 shrink-0 max-w-[70%]">
            {pinnedContext &&
              // A diverged worktree is recoverable in one click — switch focus
              // back to the worktree the session is pinned to. A pinned terminal
              // with no live grid target is no longer a failure to shout about:
              // tool calls re-resolve at dispatch time and the dock-hosted chat
              // keeps working, so it stays a quiet neutral indicator. The
              // recovery path lives on the header's "Start new session" button
              // (#10792).
              (isPinnedWorktreeDiverged ? (
                <button
                  type="button"
                  onClick={() => {
                    if (pinnedContext.worktreeId) {
                      selectWorktree(pinnedContext.worktreeId, { source: "user" });
                    }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 min-w-0 p-0 bg-transparent border-none text-[11px]",
                    "text-status-warning hover:text-status-warning/80 transition-colors duration-150",
                    "rounded-[var(--radius-sm)]",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                  )}
                  title="Switch to the worktree this assistant is pinned to"
                >
                  <span
                    aria-hidden
                    className="w-1.5 h-1.5 rounded-full shrink-0 bg-status-warning"
                  />
                  <span className="truncate">
                    {[pinnedContext.worktreeName, pinnedContext.worktreeBranch]
                      .filter(Boolean)
                      .join(" · ") || "Pinned session"}
                  </span>
                </button>
              ) : (
                <span
                  className="flex items-center gap-1.5 min-w-0"
                  title="Assistant tool calls are pinned to this worktree and terminal."
                >
                  <span
                    aria-hidden
                    className="w-1.5 h-1.5 rounded-full shrink-0 bg-daintree-text/30"
                  />
                  <span className="truncate">
                    {[pinnedContext.worktreeName, pinnedContext.worktreeBranch]
                      .filter(Boolean)
                      .join(" · ") || "Pinned session"}
                  </span>
                </span>
              ))}
            {agentId === "daintree-assistant" ? (
              // The Daintree Assistant is the workspace's own conductor, so the
              // brand mark already says "Daintree" — pairing it with just
              // "assistant" keeps this status row from repeating the word twice
              // and frees up the tight footer width.
              <span
                className="flex items-center gap-1 shrink-0"
                title={
                  launchedModelLabel
                    ? `Assistant agent: ${agentConfig.name} · ${launchedModelLabel}`
                    : `Assistant agent: ${agentConfig.name}`
                }
              >
                <DaintreeIcon className="w-3.5 h-3.5" />
                Assistant
                {launchedModelLabel && (
                  <span className="text-daintree-text/50">· {launchedModelLabel}</span>
                )}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 shrink-0"
                title={
                  launchedModelLabel
                    ? `Assistant agent: ${agentConfig.name} · ${launchedModelLabel}`
                    : `Assistant agent: ${agentConfig.name}`
                }
              >
                <agentConfig.icon className="w-3.5 h-3.5" />
                {agentConfig.name}
                {launchedModelLabel && (
                  <span className="text-daintree-text/50">· {launchedModelLabel}</span>
                )}
              </span>
            )}
          </span>
        </div>
      )}
      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title="Start a new session?"
        description="The current agent will stop and the conversation will be discarded"
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
        description="The current session will end and the conversation will be discarded"
        confirmLabel="Switch agent"
        onConfirm={handleConfirmAgentSwitch}
        onClose={handleCancelAgentSwitch}
        variant="destructive"
      />
    </aside>
  );
}
