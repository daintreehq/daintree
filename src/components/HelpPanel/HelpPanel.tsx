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
import {
  getTerminalFocusTarget,
  shouldShowHybridInputBar,
} from "@/components/Terminal/terminalFocus";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { HelpIntroBanner } from "./HelpIntroBanner";
import { HelpPanelHeader } from "./HelpPanelHeader";
import { HelpSessionTabs, type HelpSessionTab } from "./HelpSessionTabs";
import { HelpSessionLaneRuntime } from "./HelpSessionLaneRuntime";
import {
  acquireHelpSessionController,
  releaseHelpSessionController,
} from "@/controllers/helpSessionControllerRegistry";
import { HelpPanelBanners } from "./HelpPanelBanners";
import { HelpPanelVersionGate } from "./HelpPanelVersionGate";
import { HelpLaunchingState } from "./HelpLaunchingState";
import { McpActivityStrip } from "./McpActivityStrip";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { TurnOutcomePip } from "./TurnOutcomePip";
import { FigureRail } from "./FigureRail";
import {
  useHelpPanelStore,
  selectSlot,
  selectOpenSlots,
  HELP_PANEL_MIN_WIDTH,
  HELP_PANEL_MAX_WIDTH,
} from "@/store/helpPanelStore";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import {
  usePanelStore,
  getTerminalRefreshTier,
  useCliAvailabilityStore,
  useProjectStore,
  useWorktreeSelectionStore,
  useTerminalInputStore,
} from "@/store";
import { isAssistantFocused, useMacroFocusStore } from "@/store/macroFocusStore";
// Leaf import, not the `@/store` barrel: the barrel is mocked wholesale (with a
// hand-listed hook set) across the HelpPanel/controller suites, so pulling a new
// hook through it would crash every one of them on an undefined destructure.
import { useScratchStore } from "@/store/scratchStore";
import { useFocusStore } from "@/store/focusStore";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { buildResumeLatestCommand } from "@shared/types/agentSettings";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { dismissAllTooltips } from "@/lib/tooltipDismissRegistry";
import { TerminalRefreshTier } from "@/types";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const RESIZE_STEP = 10;
const RESIZE_PAGE_STEP = 50;

const ASSISTANT_DOCS_URL = "https://daintree.org/assistant";
const ASSISTANT_INSTALLER_URL = "https://daintree.org/download";

// How long `agentState` must stay "exited" before the assistant self-stops and
// slides the sidebar out. The FSM's "exited" is sticky (only a `respawn` leaves
// it), so a real `/exit` easily clears this, while a transient mis-detection
// flap (#10911) bounces back to a live state well within the window — keeping a
// spurious tick from tearing down a running conversation.
const ASSISTANT_AGENT_EXIT_SETTLE_MS = 750;

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
  const inputBarRef = useRef<HybridInputBarHandle>(null);
  // Element that owned focus when the panel last opened. We restore focus to
  // it on close so keyboard users return to where they were rather than
  // body. Mirrors the pattern in AppDialog/AppPaletteDialog.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Invalidates any deferred reveal-focus frame whose authorizing effect run has
  // already been torn down. Mirrors HybridInputBar's `focusGenerationRef`
  // (#8487) — a frame that was already dequeued can't be stopped by
  // `cancelAnimationFrame`, so it has to check that it still owns the grab.
  const revealFocusGenerationRef = useRef(0);
  // The last (isOpen, isVisible, focusRequest) tuple whose focus grab actually
  // completed. Tracking *completion* rather than the previous effect setup is
  // what makes the grab survive StrictMode: the first setup schedules a frame,
  // the immediate cleanup cancels it, and the replayed setup must still see an
  // outstanding request. A "previous setup" ref would mark it consumed and the
  // panel would open unfocused (#11472).
  const lastCompletedFocusTriggerRef = useRef<{
    isOpen: boolean;
    isVisible: boolean;
    focusRequest: number;
  } | null>(null);
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
  const [showEndSessionConfirm, setShowEndSessionConfirm] = useState(false);
  const [showAgentSwitchConfirm, setShowAgentSwitchConfirm] = useState(false);
  // Tracks the last preferredAgentId the switch effect acted on so a single
  // preference change drives at most one switch attempt (the effect re-runs
  // on unrelated dep changes while the async launch settles).
  const prevPreferredAgentIdRef = useRef<string | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);

  // The lane this panel body is showing, and its controller (#12108).
  //
  // The controller comes from the per-view registry rather than `useState`:
  // switching tabs must hand this component a DIFFERENT controller while
  // leaving the previous lane's instance running, and a lane that scrolls off
  // screen keeps its launch phase, banners and IPC subscriptions intact. A
  // `useState` instance would be per-component and would die on tab switch.
  const activeSlot = useHelpPanelStore((s) => s.activeSlot);
  const controller = acquireHelpSessionController(activeSlot);

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
      terminalId: selectSlot(s, s.activeSlot).terminalId,
      sessionId: selectSlot(s, s.activeSlot).sessionId,
      agentId: selectSlot(s, s.activeSlot).agentId,
      preferredAgentId: s.preferredAgentId,
      autoLaunchEnabled: s.autoLaunchEnabled,
      droppedPreferredAgentId: s.droppedPreferredAgentId,
      introDismissed: s.introDismissed,
      conversationTouched: selectSlot(s, s.activeSlot).conversationTouched,
      focusRequest: s.focusRequest,
      figures: selectSlot(s, s.activeSlot).figures,
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
  // Narrow structural triggers for the reveal-focus effect below. A live
  // assistant replaces its whole panel object constantly — `updateAgentState`,
  // `updateLastObservedTitle` on every distinct OSC title, and the RAF-coalesced
  // activity buffer all swap the identity — so depending on `terminal` itself
  // made every one of those a focus trigger (#11472). These two primitives move
  // only when the terminal genuinely appears or changes spawn phase, which is
  // the only structural churn worth retrying a focus grab for. Same shape as
  // useContentGridContext.tsx (#8593): subscribe to primitives, read the map
  // non-reactively at execution time.
  const terminalExists = terminal !== undefined;
  const terminalSpawnStatus = terminalPty?.spawnStatus;
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
  const currentScratch = useScratchStore((s) => s.currentScratch);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);

  // The assistant launches into the active *workspace*, which is a project OR a
  // scratch (#11068). The two pointers are mutually exclusive by design — a
  // scratch switch clears `currentProject`, a project switch clears
  // `currentScratch` — so the fallback never has to disambiguate a both-set
  // state; project-first only guards against a transient inconsistency.
  // Everything downstream (provisioning, hibernation, `ctx.projectId` in main)
  // treats this id as an opaque workspace key, so a scratch id flows through
  // unchanged. Memoized on the primitive id/path so the identity is stable
  // across renders — `syncInputs` below patches controller state, which can
  // re-render this component, and an inline object would churn the effect.
  const activeWorkspaceId = currentProject?.id ?? currentScratch?.id ?? null;
  const activeWorkspacePath = currentProject?.path ?? currentScratch?.path ?? null;
  const activeWorkspace = useMemo(
    () =>
      activeWorkspaceId && activeWorkspacePath
        ? { id: activeWorkspaceId, path: activeWorkspacePath }
        : null,
    [activeWorkspaceId, activeWorkspacePath]
  );

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

  // A conversation the eviction/crash path captured for this workspace but never
  // resumed. On LRU eviction (or renderer crash) main kills the assistant PTY
  // via HelpSessionService.revokeByWebContentsId — grid PTYs survive in the
  // pty-host, the assistant doesn't — and stashes a resume token in its
  // pending-hibernation store. When the idle empty state is about to show, peek
  // that store so we can offer "Resume assistant" instead of a fresh "Start
  // assistant", making a workspace switch-back read as a recoverable pause rather
  // than a crash. The peek is non-consuming: the launch flow still consumes the
  // entry via takePendingHibernation. We stamp the entry with its workspace id so
  // a mid-flight A→B switch can't show workspace A's Resume CTA over workspace B.
  const [resumablePending, setResumablePending] = useState<{
    workspaceId: string;
    agentId: string;
  } | null>(null);
  useEffect(() => {
    if (!isOpen || terminalId || !activeWorkspaceId) {
      setResumablePending(null);
      return;
    }
    // Optional-chained like the `onViewRevealed` subscription below: a missing
    // binding degrades to the normal "Start assistant" CTA rather than throwing.
    const peek = window.electron.help.peekPendingHibernation?.(activeWorkspaceId, activeSlot);
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
          canResume ? { workspaceId: activeWorkspaceId, agentId: pendingAgentId } : null
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
    activeWorkspaceId,
    supportedInstalledAgentIdsKey,
    supportedInstalledAgentIds,
  ]);

  // Cross-workspace bleed guard: an A→B switch re-runs the peek effect, but B's
  // peek resolves asynchronously, so only trust a pending entry whose workspace
  // id matches the workspace currently in view.
  const resumableAgentId =
    resumablePending && resumablePending.workspaceId === activeWorkspaceId
      ? resumablePending.agentId
      : null;

  // #10815: report this workspace's panel open-state to main on every change so
  // an LRU eviction / crash capture can stamp `panelWasOpen` onto the resume
  // token. Fire-and-forget — a slow or missing binding must never block the UI.
  //
  // Visibility rides along as a second fact, because the project tallies want a
  // different question answered: focus mode parks the panel off-canvas without
  // touching `isOpen` (`AppLayout`'s `showAssistant`), and an assistant nobody
  // can see must not put its project in the switcher's attention band. The open
  // flag stays exactly what it was so the cold-resume decision it feeds is
  // unchanged — a panel parked by a gesture is still one the user expects back.
  const gestureAssistantHidden = useFocusStore((s) => s.gestureAssistantHidden);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const reported = window.electron.help.reportPanelOpen?.(
      activeWorkspaceId,
      isOpen,
      isOpen && !gestureAssistantHidden
    );
    if (reported) safeFireAndForget(reported, { context: "HelpPanel.reportPanelOpen" });
  }, [isOpen, gestureAssistantHidden, activeWorkspaceId]);

  // #10815: cold switch-back auto-resume — driven by the reliable pull-on-mount
  // peek, NOT a racy main→renderer push. The lazy HelpPanel mounts behind
  // hydration gates and subscribes long after main's `did-finish-load` fires, so
  // a one-shot push was dropped on a true cold restore (the exact scenario this
  // targets). The peek is request/response and can't be missed: when this
  // project's view was evicted (or crashed) with the assistant open, main's
  // capture stamped `panelWasOpen` onto the resume token (in-memory only —
  // disk-loaded prior-session entries lack it, so app restart reads false and
  // never auto-resumes). Runs even while closed: the panel is closed by design
  // after a cold restore, so gating on `isOpen` would drop the signal.
  // `coldResumeArmedRef` plus the `!terminalId` gate keep it one-shot — a
  // re-peek on a dep change can't re-arm, and a DevTools reload that still holds
  // a live session never arms a second backend. `peekPendingHibernation` is
  // non-consuming; the launch flow below does the atomic `take`.
  //
  // Gated on `isReadyToLaunch` so we don't arm — or even peek — until the
  // controller can actually accept the launch (#10815). A true cold restore
  // renders with workspace state still hydrating (`isReadyToLaunch === false`);
  // arming then would set `autoResumeAgentId`, and the fire-effect would call
  // `launch()` against a not-ready controller, which rejects and burns the
  // one-shot intent — silently losing the resume in exactly the target scenario.
  // Deferring the whole effect until ready preserves the intent (the peek is
  // non-consuming, so main keeps the entry until the atomic take): the effect
  // re-runs when `isReadyToLaunch` flips true, by which point `syncInputs` has
  // already pushed the ready state into the controller, so no fire-vs-sync race.
  const [autoResumeAgentId, setAutoResumeAgentId] = useState<string | null>(null);
  const coldResumeArmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || terminalId || !isReadyToLaunch) return;
    if (coldResumeArmedRef.current === activeWorkspaceId) return;
    const peek = window.electron.help.peekPendingHibernation?.(activeWorkspaceId, activeSlot);
    if (!peek) return;
    let cancelled = false;
    void peek
      .then((pending) => {
        if (cancelled || coldResumeArmedRef.current === activeWorkspaceId) return;
        if (!pending?.panelWasOpen || !pending.agentId) return;
        coldResumeArmedRef.current = activeWorkspaceId;
        setOpen(true);
        setAutoResumeAgentId(pending.agentId);
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to peek cold-resume hibernation", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, terminalId, isReadyToLaunch, setOpen]);

  // Fire the captured resume once the panel has opened. The `!terminalId` guard
  // covers two cases: a DevTools reload that still holds a live session, and the
  // controller's own auto-launch (when consent is on) already having spawned —
  // either way a live session means the resume already happened (or shouldn't
  // double), so drop the intent. Deliberately omits `setAutoLaunchEnabled`:
  // auto-resuming a stranded session is one-time recovery, not an opt-in to
  // billed auto-launch on every future open (#10699). Mirrors
  // `handleResumeAssistant`. `resumeOnly` makes the launch restore-or-nothing:
  // if main's pending entry is already gone (another window won the atomic take,
  // or a stale peek), the controller aborts instead of fresh-launching a blank
  // session that would displace the resumed backend (#10815).
  useEffect(() => {
    if (!autoResumeAgentId || !isOpen) return;
    if (terminalId) {
      setAutoResumeAgentId(null);
      return;
    }
    controller.launch({ agentId: autoResumeAgentId, replaceExisting: true, resumeOnly: true });
    setAutoResumeAgentId(null);
  }, [autoResumeAgentId, isOpen, terminalId, controller]);

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
      // Legacy field name — carries the active workspace, project or scratch.
      currentProject: activeWorkspace,
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
    activeWorkspace,
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
      if (selectSlot(store, store.activeSlot).terminalId === terminalId) {
        markConversationStarted(store.activeSlot);
      }
    }
  }, [terminalId, terminalPty?.agentState, markConversationStarted]);

  // When the agent CLI exits from inside its own terminal (`/exit`, or the
  // agent quits), the FSM lands on "exited" while the wrapping shell PTY stays
  // alive — so `handleTerminalPanelMissing` never fires and the sidebar would
  // otherwise linger on a dead shell. Fully stop the session and slide the
  // panel out, debounced past a mis-detection flap (see the constant). Directly
  // launched agents that exit their PTY are covered by the removeOnExit →
  // `handleTerminalPanelMissing` path instead.
  useEffect(() => {
    if (!terminalId || terminalPty?.agentState !== "exited") return;
    const timer = setTimeout(() => {
      controller.handleAgentExited(terminalId);
    }, ASSISTANT_AGENT_EXIT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [controller, terminalId, terminalPty?.agentState]);

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
    const focusTrigger = { isOpen, isVisible, focusRequest };
    const lastCompleted = lastCompletedFocusTriggerRef.current;
    // Only opening, revealing and an explicit focusRequest authorize taking
    // focus away from wherever the user is actually typing. Everything else
    // that re-runs this effect is structural (the terminal appeared, finished
    // spawning, was replaced, or the input bar came and went) and may only
    // re-target focus the assistant already owns.
    const hasNewFocusTrigger =
      lastCompleted === null ||
      lastCompleted.isOpen !== isOpen ||
      lastCompleted.isVisible !== isVisible ||
      lastCompleted.focusRequest !== focusRequest;

    if (isOpen && isVisible) {
      // Only remember a restore target when this run is actually authorized to
      // move focus. A structural re-run that the ownership gate goes on to
      // reject must not overwrite it with whatever unrelated pane the user
      // happens to be typing in.
      const active = document.activeElement;
      if (
        hasNewFocusTrigger &&
        active instanceof HTMLElement &&
        !panelRef.current?.contains(active)
      ) {
        previousFocusRef.current = active;
      }

      const generation = ++revealFocusGenerationRef.current;
      let hybridCompletionRaf: number | null = null;
      // The exact bar we handed a focus request to, so cleanup revokes that one
      // rather than whatever `inputBarRef` happens to point at by then.
      let pendingFocusBar: HybridInputBarHandle | null = null;

      const raf = requestAnimationFrame(() => {
        if (revealFocusGenerationRef.current !== generation) return;

        const state = useHelpPanelStore.getState();
        // The panel can close, or rebind to a different session, between this
        // effect and the frame that runs it. A frame already dequeued when
        // cleanup ran can't be cancelled, so re-read both.
        if (!state.isOpen || selectSlot(state, state.activeSlot).terminalId !== terminalId) return;

        // Ownership is re-checked here, on the final deferred frame, rather
        // than in the effect body — focus can move during the frame boundary,
        // and a decision made one frame ago is exactly the stale authorization
        // that let a background agent-state update yank the caret out of
        // another pane's editor (#11472).
        if (!hasNewFocusTrigger && !isAssistantFocused()) return;

        const completeFocusTrigger = () => {
          if (hasNewFocusTrigger) lastCompletedFocusTriggerRef.current = focusTrigger;
        };

        const current = document.activeElement;
        if (
          (current?.closest?.(".xterm-helper-textarea") || current?.closest?.(".cm-editor")) &&
          panelRef.current?.contains(current)
        ) {
          completeFocusTrigger();
          return;
        }

        // Read the panel non-reactively at execution time. The effect no longer
        // subscribes to the panel object, so this is both the freshest value
        // and the only one that reflects a terminal removed or failed between
        // the effect and this frame.
        const currentTerminal = terminalId
          ? usePanelStore.getState().panelsById[terminalId]
          : undefined;
        const currentTerminalPty =
          currentTerminal && isPtyPanel(currentTerminal) ? currentTerminal : undefined;

        // Ownership is settled by this point, so now — and only now — the
        // remembered preference gets to pick which surface receives focus.
        // Resolving it here rather than letting HybridInputBar's own
        // `preferredTerminalFocusTarget` check veto the grab matters: that
        // check aborts silently, which would leave an authorized open request
        // marked complete with focus still in another pane.
        const bar = inputBarRef.current;
        const focusTarget = getTerminalFocusTarget({
          preferredTarget: usePanelStore.getState().preferredTerminalFocusTarget,
          hasHybridInputSurface: showHybridInputBar && bar !== null,
          isInputDisabled: currentTerminalPty?.isInputLocked === true,
          hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
        });

        // When an agent terminal is running, focus the surface the preference
        // resolved to, falling back to xterm when the editor can't take it.
        //
        // `focusWithCursorAtEnd()` schedules `view.focus()` inside its own
        // requestAnimationFrame, so we cannot synchronously check
        // `document.activeElement` after calling it. We trust the bar's
        // internal rAF when it reports it scheduled the grab — no xterm
        // fallback in that branch, otherwise CodeMirror would steal focus from
        // xterm one frame later and produce a focus flicker. A `false` return
        // means no editor was mounted (the lazy Suspense window) and nothing
        // was scheduled, so falling through to xterm is safe and still focuses
        // something on a cold open.
        if (
          terminalId &&
          currentTerminal &&
          currentTerminalPty?.spawnStatus !== "missing-cli" &&
          currentTerminalPty?.spawnStatus !== "failed"
        ) {
          if (focusTarget === "hybridInput" && bar) {
            // The bar defers the real `view.focus()` to a frame of its own,
            // which is the LAST frame in this grab — so the last ownership
            // check has to run inside it. We can't edit that shared component,
            // but a frame queued here, before the bar schedules its own, is
            // dequeued ahead of it: it gets to re-read ownership and revoke the
            // grab via `cancelPendingFocus()` when the user has moved on in the
            // gap. Without it a structural retry that was legitimate one frame
            // ago still lands in the other pane's editor (#11472).
            hybridCompletionRaf = requestAnimationFrame(() => {
              if (revealFocusGenerationRef.current !== generation) return;
              if (!hasNewFocusTrigger && !isAssistantFocused()) {
                bar.cancelPendingFocus();
                return;
              }
              completeFocusTrigger();
            });
            pendingFocusBar = bar;
            if (bar.focusWithCursorAtEnd()) return;
            // No editor was mounted, so nothing is pending to guard.
            cancelAnimationFrame(hybridCompletionRaf);
            hybridCompletionRaf = null;
            pendingFocusBar = null;
          }
          terminalInstanceService.focus(terminalId);
          const after = document.activeElement;
          if (after?.closest?.(".xterm-helper-textarea") && panelRef.current?.contains(after)) {
            completeFocusTrigger();
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
        completeFocusTrigger();
      });

      return () => {
        cancelAnimationFrame(raf);
        if (hybridCompletionRaf !== null) cancelAnimationFrame(hybridCompletionRaf);
        // Invalidate any frame this run already handed out, including the one
        // nested inside HybridInputBar — `cancelAnimationFrame` can't reach
        // that one, and without this it lands after the panel closed (#11472).
        revealFocusGenerationRef.current += 1;
        pendingFocusBar?.cancelPendingFocus();
      };
    }

    // Record the closed/hidden tuple so the next open or reveal reads as a new
    // request rather than one already satisfied.
    lastCompletedFocusTriggerRef.current = focusTrigger;

    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    // Hand focus back only if the assistant still had it. Closing a panel the
    // user already left must not drag them out of wherever they went — that is
    // the same steal this effect exists to prevent, just on the way out.
    // `body`/null covers the panel tearing down its focused descendant, which
    // is the normal close path.
    const activeOnClose = document.activeElement;
    const assistantStillOwnedFocus =
      activeOnClose === null ||
      activeOnClose === document.body ||
      panelRef.current?.contains(activeOnClose) === true;
    if (
      el &&
      assistantStillOwnedFocus &&
      document.contains(el) &&
      !panelRef.current?.contains(el)
    ) {
      // Radix opens tooltips on focus as well as hover, so handing focus back
      // to a tooltip trigger — the toolbar assistant button is the usual opener
      // — pops a tooltip nothing is hovering. Same failure the dialog
      // primitives already arm against (#11030); the suppression window is
      // honored by both the tooltip open path and useShortcutHintHover's focus
      // branch, and any real pointerenter clears it, so genuine hovers still
      // teach. Inside the guard on purpose: a restore we decline must not
      // suppress a tooltip the user did ask for.
      dismissAllTooltips();
      el.focus();
    }
    return undefined;
  }, [
    isOpen,
    isVisible,
    focusRequest,
    terminalId,
    terminalExists,
    terminalSpawnStatus,
    showHybridInputBar,
  ]);

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

  // --- Parallel lanes (#12108) -------------------------------------------
  const openSlots = useHelpPanelStore(useShallow(selectOpenSlots));
  const canOpenParallelSession = openSlots.length < MAX_ASSISTANT_SLOTS;

  const laneAgentStates = usePanelStore(
    useShallow((s: ReturnType<typeof usePanelStore.getState>) =>
      openSlots.map((slot) => {
        const laneTerminalId = useHelpPanelStore.getState().sessions[slot]?.terminalId;
        if (!laneTerminalId) return undefined;
        const panel = s.panelsById[laneTerminalId];
        return panel && isPtyPanel(panel) ? panel.agentState : undefined;
      })
    )
  );

  const sessionTabs = useMemo<HelpSessionTab[]>(
    () =>
      openSlots.map((slot, index) => ({
        slot,
        // Numbered by position rather than by slot, so closing lane 1 of three
        // leaves "Session 1 / Session 2" rather than a gap at 2.
        label: `Session ${index + 1}`,
        agentState: laneAgentStates[index],
      })),
    [openSlots, laneAgentStates]
  );

  const handleOpenParallelSession = useCallback(() => {
    const slot = useHelpPanelStore.getState().openSlot();
    if (slot === null) return;
    useHelpPanelStore.getState().setOpen(true);
    useHelpPanelStore.getState().requestFocus();
  }, []);

  const handleSelectSlot = useCallback((slot: number) => {
    useHelpPanelStore.getState().setActiveSlot(slot);
    // A lane's xterm was hidden while it was in the background, so it has no
    // trustworthy geometry until it is measured on screen. `requestFocus`
    // drives HelpPanel's existing reveal path, which fits and repaints before
    // handing it the caret — the same treatment a panel reveal gets.
    useHelpPanelStore.getState().requestFocus();
  }, []);

  const handleCloseSlot = useCallback((slot: number) => {
    const state = useHelpPanelStore.getState();
    const lane = state.sessions[slot];
    // Revoke and kill BEFORE dropping the lane. `stop()` only disarms
    // listeners — it deliberately does not end the session — so releasing the
    // controller first would strand a live agent with nothing to shut it down.
    if (lane?.terminalId || lane?.sessionId) {
      acquireHelpSessionController(slot).endSession();
    }
    releaseHelpSessionController(slot);
    state.closeSlot(slot);
  }, []);

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

  // Stop reuses the same "something to lose" gate as +New session — confirm
  // only when a working agent or an engaged conversation would be discarded.
  const handleEndSession = useCallback(() => {
    if (!terminalId || !agentId) return;
    if (shouldConfirmNewSession) {
      setShowEndSessionConfirm(true);
      return;
    }
    controller.endSession();
  }, [controller, terminalId, agentId, shouldConfirmNewSession]);

  const handleConfirmEndSession = useCallback(() => {
    setShowEndSessionConfirm(false);
    controller.endSession();
  }, [controller]);

  const handleCancelEndSession = useCallback(() => {
    setShowEndSessionConfirm(false);
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

  // Once a re-check confirms the CLI, the launch no longer needs to bypass the
  // probe — take the ordinary session path so the gate can still catch a state
  // that changed again underneath us.
  const handleAvailabilityReady = useCallback(() => {
    controller.newSession();
  }, [controller]);

  const handleOpenAgentSettings = useCallback(() => {
    if (!agentId) return;
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: agentId },
      { source: "user" }
    );
  }, [agentId]);

  // The agent the idle empty state's "Start assistant" CTA would launch — the
  // user's preference, or the sole installed assistant backend. Mirrors the
  // controller's own auto-launch eligibility so the CTA is shown only when a
  // single unambiguous target exists; otherwise the user is sent to settings.
  const launchableAgentId =
    preferredAgentId ??
    (supportedInstalledAgentIds.length === 1 ? (supportedInstalledAgentIds[0] ?? null) : null);

  // Each empty-state CTA wears the mark of the agent it would actually launch,
  // so the button says what's about to start. Rendered bare: the Button variant
  // sizes descendant svgs and it is not wrapped in `BrandMark`, so the glyph
  // inherits the accent fill's foreground rather than the brand hue. Falls
  // back to the generic mark when an id outlives its registry entry — stored
  // preferences are only revalidated on hydration, and uninstalling a CLI flips
  // availability without dropping its config, so the live gap is an entry that
  // disappears after selection. Mirrors the droppedPreferredAgentId lookup below.
  const StartAssistantIcon = launchableAgentId
    ? (getAgentConfig(launchableAgentId)?.icon ?? Sparkles)
    : Sparkles;
  const ResumeAssistantIcon = resumableAgentId
    ? (getAgentConfig(resumableAgentId)?.icon ?? Sparkles)
    : Sparkles;

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
        "bg-surface-canvas border-l border-border-default transition-[border-left-color,box-shadow] duration-150",
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
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
          isResizing && "bg-overlay-medium"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />

      <HelpPanelHeader
        agentState={terminalPty?.agentState}
        canStartNewSession={Boolean(terminalId && agentId)}
        canEndSession={Boolean(terminalId && agentId)}
        canOpenParallelSession={canOpenParallelSession}
        onNewSession={handleNewSession}
        onOpenParallelSession={handleOpenParallelSession}
        onEndSession={handleEndSession}
        onOpenDocs={handleOpenAssistantDocs}
        onClose={handleClose}
        isFocused={isHighlighted}
      />

      <HelpSessionTabs
        tabs={sessionTabs}
        activeSlot={activeSlot}
        onSelect={handleSelectSlot}
        onClose={handleCloseSlot}
      />

      {/* Background lanes: no body, but their controllers must keep running so
          a session the user has tabbed away from still surfaces approvals and
          still hibernates when idle. */}
      {openSlots
        .filter((slot) => slot !== activeSlot)
        .map((slot) => (
          <HelpSessionLaneRuntime
            key={slot}
            slot={slot}
            isActive={false}
            isOpen={isOpen}
            isReadyToLaunch={isReadyToLaunch}
            currentProject={activeWorkspace}
            preferredAgentId={preferredAgentId}
            supportedInstalledAgentIds={supportedInstalledAgentIds}
            autoLaunchEnabled={autoLaunchEnabled}
            visibilityEpoch={visibilityEpoch}
          />
        ))}

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {/* Banners render above every content state — the launch-error banner
            must stay visible in the empty state a failed launch falls back to.
            The other banners are null unless a session is live, so this mount
            position is behaviorally identical for them. */}
        <HelpPanelBanners
          showResumeBanner={session.showResumeBanner}
          tierMismatch={session.tierMismatch}
          launchError={session.launchError}
          sessionRevoked={session.sessionRevoked}
          isApprovingTier={session.isApprovingTier}
          activeGrant={session.activeGrant}
          grantEnded={session.grantEnded}
          isRevokingGrant={session.isRevokingGrant}
          onDismissResume={dismissResume}
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
              onAvailabilityReady={handleAvailabilityReady}
              onOpenAgentSettings={handleOpenAgentSettings}
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
                    detectedAgentId={terminalPty?.detectedAgentId}
                    agentState={terminalPty?.agentState}
                    // Without this the adapter's layout effect drives
                    // setInputLocked(id, false) on mount, unlocking the very
                    // terminal the hybrid input below is disabling itself for.
                    isInputLocked={terminalPty?.isInputLocked === true}
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
                  "text-xs text-text-primary"
                )}
                data-testid="help-dropped-agent-banner"
              >
                <ShieldAlert
                  className="w-3.5 h-3.5 shrink-0 mt-0.5 text-status-warning"
                  aria-hidden="true"
                />
                <div className="flex-1 select-text">
                  <p className="font-medium text-text-primary">
                    {getAgentConfig(droppedPreferredAgentId)?.name ?? droppedPreferredAgentId} is no
                    longer available
                  </p>
                  <p className="mt-0.5 text-text-secondary">
                    The agent was removed or is no longer supported as an assistant backend
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenSettings}
                    className="mt-1 text-text-secondary hover:text-text-primary underline underline-offset-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                  >
                    Open assistant settings
                  </button>
                </div>
                <button
                  type="button"
                  onClick={clearDroppedPreferredAgent}
                  aria-label="Dismiss agent unavailable notice"
                  className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
              <p className="text-sm text-text-secondary max-w-[30ch]">
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
                    <ResumeAssistantIcon />
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
                    <StartAssistantIcon />
                    Start assistant
                  </Button>
                  {!hasEverLaunchedAgent && (
                    <div className="flex flex-col gap-1.5 w-full">
                      <p className="text-2xs text-text-secondary">Or start with a question</p>
                      {STARTER_PROMPTS.map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => handleStartAssistant(prompt)}
                          className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs rounded-[var(--radius-md)] border border-border-default text-daintree-text/80 hover:text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                        >
                          <MessageCircle className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" />
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-text-secondary max-w-[32ch]">
                  Configure an assistant agent in settings to get started.
                </p>
              )}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className="flex items-center gap-1 text-2xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  Assistant settings
                </button>
                <button
                  type="button"
                  onClick={handleOpenAssistantDocs}
                  className="flex items-center gap-1 text-2xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
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
        <div className="flex items-center justify-between gap-3 border-t border-border-default shrink-0 px-3 py-1.5 text-2xs text-text-secondary">
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
                    "flex items-center gap-1.5 min-w-0 p-0 bg-transparent border-none text-2xs",
                    "text-status-warning hover:text-status-warning/80 transition-colors duration-150",
                    "rounded-[var(--radius-sm)]",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                  )}
                  title="Switch to the worktree this assistant is pinned to"
                >
                  <span
                    aria-hidden
                    className="status-mark w-1.5 h-1.5 rounded-full shrink-0 bg-status-warning"
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
                    className="status-mark w-1.5 h-1.5 rounded-full shrink-0 bg-daintree-text/30"
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
                  <span className="text-text-secondary">· {launchedModelLabel}</span>
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
                  <span className="text-text-secondary">· {launchedModelLabel}</span>
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
        isOpen={showEndSessionConfirm}
        title="Stop assistant?"
        description="The assistant will stop and the conversation will be discarded"
        confirmLabel="Stop assistant"
        onConfirm={handleConfirmEndSession}
        onClose={handleCancelEndSession}
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
