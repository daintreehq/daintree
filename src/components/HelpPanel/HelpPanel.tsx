import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
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
import { AssistantPanel } from "@/components/AssistantPanel";
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
import { DAINTREE_ASSISTANT_AGENT_ID } from "@shared/config/agentRegistry";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { HelpIntroBanner } from "./HelpIntroBanner";
import { HelpPanelHeader } from "./HelpPanelHeader";
import { HelpSessionTabs, helpSessionTabId, type HelpSessionTab } from "./HelpSessionTabs";
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
  // The lane a tab's close button is waiting on confirmation for (#12108).
  // Null means no close is pending — closing is destructive (the conversation
  // is discarded, not paused), so it takes the same gate the Stop control uses.
  const [pendingCloseSlot, setPendingCloseSlot] = useState<number | null>(null);
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

  /**
   * The Daintree Assistant renders NATIVELY; every other help agent keeps the xterm pane.
   *
   * There is deliberately no toggle. This is not a preference between two working
   * surfaces — the engine no longer HAS a terminal UI. Its cockpit was removed when
   * Daintree took over rendering, so pointing the PTY path at a current engine would
   * show the bare line REPL that exists for SSH sessions. Claude, Codex and the rest
   * are real terminal programs and stay on xterm.
   *
   * It is also the DEFAULT. The Daintree Assistant is the assistant — the picker,
   * the availability probe and the "Start assistant" consent CTA all exist because
   * this panel could host Claude or Codex instead, and none of that should stand
   * between someone opening the panel and seeing their own assistant. Another agent
   * takes the panel only when it has been chosen explicitly.
   *
   * Keyed off the preferred agent as well as the launched one: in native mode no
   * terminal is ever launched, so `agentId` stays null.
   */
  const useNativeAssistant =
    (agentId ?? preferredAgentId ?? DAINTREE_ASSISTANT_AGENT_ID) === DAINTREE_ASSISTANT_AGENT_ID;

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

  // Arms once the native panel has actually been opened, and stays armed across
  // close/reopen so dismissing the sidebar does not end the conversation.
  //
  // The arm names the workspace it belongs to, and is compared DURING RENDER rather
  // than cleared by an effect. A boolean cleared in an effect is a frame too late: on
  // an A→B switch, B's first render still sees A's `true`, starts B's engine, and the
  // clear then stops it — leaving a visible panel with no session and no way back,
  // because an effect keyed only on `isOpen`/`useNativeAssistant` never re-runs when
  // neither changed. Deriving it makes a new workspace unarmed before any effect runs.
  const [armedWorkspaceId, setArmedWorkspaceId] = useState<string | null>(null);
  // Bumped by "+ New session" in native mode. It is a dependency of the engine's start
  // effect, so a bump is what tears the old session down and starts a fresh one —
  // the native equivalent of respawning the PTY, expressed through the same lifecycle
  // rather than a second teardown path that could drift from it.
  const [nativeSessionNonce, setNativeSessionNonce] = useState(0);
  const nativeSessionArmed = armedWorkspaceId !== null && armedWorkspaceId === activeWorkspaceId;
  useEffect(() => {
    // Depends on the workspace too, so a switch re-arms immediately when the panel is
    // already open, and waits for a first open when it is not.
    if (isOpen && useNativeAssistant && armedWorkspaceId !== activeWorkspaceId) {
      setArmedWorkspaceId(activeWorkspaceId);
    }
  }, [isOpen, useNativeAssistant, activeWorkspaceId, armedWorkspaceId]);

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
    activeSlot,
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
  }, [activeWorkspaceId, activeSlot, terminalId, isReadyToLaunch, setOpen]);

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

  // Lifecycle is NOT driven from here (#12108). Every open lane — the active
  // one included — is armed by its own `HelpSessionLaneRuntime` below.
  //
  // Keying an arm/disarm effect on `controller` would tear the OUTGOING lane
  // down on every tab switch, and `stop()` is not a neutral pause: it bumps
  // `_launchGen`, which makes an in-flight launch bail at its next checkpoint.
  // Switching tabs mid-launch would silently abandon that launch.

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

  /**
   * Moves the panel to `targetAgentId`, from whatever surface it is on now.
   *
   * The native assistant is NOT a `selectAgent` target. `selectAgent` is the legacy
   * PTY path: it unbinds the current terminal and launches a new one for the chosen
   * agent. Pointed at "daintree-assistant" it would spawn the engine's CLI into an
   * xterm — the very cockpit this panel replaced — while unbinding the terminal also
   * mounts the native branch, leaving two assistants racing for the same project
   * lease. Switching TO native is therefore a teardown, not a launch: end the bound
   * session and the native branch takes the panel on the next render.
   */
  const switchToAgent = useCallback(
    (targetAgentId: string) => {
      if (targetAgentId === DAINTREE_ASSISTANT_AGENT_ID) {
        // `endSession` is the user-facing STOP: it tears the PTY down and closes the
        // sidebar. Closing is right when someone stops their assistant and wrong when
        // they are switching to another one — the panel they are switching INTO would
        // never appear, and the native engine would either not start (unarmed) or start
        // behind a closed panel. Re-open in the same tick so the surface swaps in place.
        controller.endSession();
        setOpen(true);
        return;
      }
      controller.selectAgent(targetAgentId);
    },
    [controller, setOpen]
  );

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
    switchToAgent(preferredAgentId);
  }, [
    switchToAgent,
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
  /**
   * Focuses the panel container itself — the last resort when it holds nothing tabbable.
   *
   * The `tabindex` is applied HERE rather than in the markup, and taken away again on
   * blur, because a permanently focusable region cannot be selected with the mouse:
   * Chromium focuses the nearest focusable ancestor on mousedown and collapses the
   * selection that press was beginning. Making it focusable only for the instant it is
   * actually the focus target keeps the keyboard path intact and gives the pointer the
   * region back.
   */
  /**
   * True for the duration of a mouse press that started inside the panel.
   *
   * A press on non-focusable panel chrome blurs whatever child held focus, and that blur
   * is shaped exactly like focus leaving for another pane. This is how `onBlur` tells
   * the two apart.
   */
  const pressInsidePanelRef = useRef(false);

  const focusPanelContainer = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    el.tabIndex = -1;
    el.focus();
  }, []);

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
          focusPanelContainer();
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
    focusPanelContainer,
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
  // One base for the whole tablist/tabpanel relationship. Both ends have to name
  // the same ids and neither can hold a ref to the other, so the panel owns the
  // base and both sides derive from it.
  const tabIdBase = useId();
  const sessionBodyId = `${tabIdBase}-body`;
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
        // Numbered by SLOT, which is the lane's durable identity, rather than by
        // position in the strip. Position renumbers: closing the first of three
        // lanes used to rename the two behind it, so a conversation the user had
        // been calling "Session 3" silently became "Session 2" and the name they
        // navigated back to belonged to a different session. A gap at 2 is a much
        // smaller cost than a label that lies, and the gap closes on its own —
        // `openSlot` always takes the lowest free slot.
        label: `Session ${slot + 1}`,
        agentState: laneAgentStates[index],
      })),
    [openSlots, laneAgentStates]
  );

  // Bring back the tabs for lanes whose conversations an eviction or crash
  // captured (#12108). A cold view starts at slot 0 alone, so lanes 1+ — whose
  // resume entries survived on disk — would have no tab to reach them from and
  // their conversations would be stranded despite still being there. The
  // listing is non-consuming, like the peeks: a recreated lane simply lands on
  // its own "Resume assistant" empty state, and nothing launches (or bills)
  // until the user asks. Background lanes report `isOpen: false` to their
  // controller, so auto-launch can't fire behind the tab strip either.
  //
  // One-shot per workspace, and only while the view is genuinely cold — a
  // single, unbound lane — so it can never fight the user's own tab edits.
  const restoredLaneWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || restoredLaneWorkspaceRef.current === activeWorkspaceId) return;
    if (openSlots.length > 1 || terminalId) return;
    // Optional-chained like the hibernation peeks: a missing binding degrades
    // to the pre-lane behaviour rather than throwing.
    const listing = window.electron.help.listPendingHibernationSlots?.(activeWorkspaceId);
    if (!listing) return;
    let cancelled = false;
    void listing
      .then((slots) => {
        if (cancelled || restoredLaneWorkspaceRef.current === activeWorkspaceId) return;
        restoredLaneWorkspaceRef.current = activeWorkspaceId;
        const store = useHelpPanelStore.getState();
        for (const slot of slots) store.ensureSlot(slot);
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to list pending hibernation lanes", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, openSlots.length, terminalId]);

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

  const closeSlotNow = useCallback((slot: number) => {
    const state = useHelpPanelStore.getState();
    const lane = state.sessions[slot];
    // Revoke and kill BEFORE dropping the lane. `stop()` only disarms
    // listeners — it deliberately does not end the session — so releasing the
    // controller first would strand a live agent with nothing to shut it down.
    if (lane?.terminalId || lane?.sessionId) {
      // Whether the panel slides out is the controller's call, made in one
      // place for every stop path: it stays on screen while any other lane is
      // open, and closes only for the last one — where the close is
      // load-bearing, because `closeSlot` recreates an empty slot 0 whose fresh
      // controller would auto-launch straight back into a session the user just
      // ended if the panel stayed open.
      acquireHelpSessionController(slot).endSession();
    }
    releaseHelpSessionController(slot);
    state.closeSlot(slot);
  }, []);

  // Same "something to lose" gate the Stop control uses, but evaluated against
  // the lane BEING CLOSED rather than the one on screen — a background lane is
  // exactly where a working agent goes unnoticed.
  const laneNeedsCloseConfirm = useCallback((slot: number) => {
    const lane = useHelpPanelStore.getState().sessions[slot];
    if (!lane) return false;
    if (lane.conversationTouched) return true;
    if (!lane.terminalId) return false;
    const panel = usePanelStore.getState().panelsById[lane.terminalId];
    const agentState = panel && isPtyPanel(panel) ? panel.agentState : undefined;
    return agentState !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(agentState);
  }, []);

  const handleCloseSlot = useCallback(
    (slot: number) => {
      if (laneNeedsCloseConfirm(slot)) {
        setPendingCloseSlot(slot);
        return;
      }
      closeSlotNow(slot);
    },
    [laneNeedsCloseConfirm, closeSlotNow]
  );

  const handleConfirmCloseSlot = useCallback(() => {
    const slot = pendingCloseSlot;
    setPendingCloseSlot(null);
    if (slot !== null) closeSlotNow(slot);
  }, [pendingCloseSlot, closeSlotNow]);

  const handleCancelCloseSlot = useCallback(() => {
    setPendingCloseSlot(null);
  }, []);

  const pendingCloseLabel =
    pendingCloseSlot === null
      ? null
      : (sessionTabs.find((tab) => tab.slot === pendingCloseSlot)?.label ?? "this session");

  const handleNewSession = useCallback(() => {
    if (useNativeAssistant) {
      // The native transcript lives only in the store, so "something to lose" is
      // whether anything has been said at all.
      setNativeSessionNonce((n) => n + 1);
      return;
    }
    if (!terminalId || !agentId) return;
    if (shouldConfirmNewSession) {
      setShowNewSessionConfirm(true);
      return;
    }
    controller.newSession();
  }, [controller, terminalId, agentId, shouldConfirmNewSession, useNativeAssistant]);

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
    if (useNativeAssistant) {
      // Disarming stops the engine through the same effect cleanup that a project
      // change uses; re-opening the panel arms it again.
      setArmedWorkspaceId(null);
      return;
    }
    if (!terminalId || !agentId) return;
    if (shouldConfirmNewSession) {
      setShowEndSessionConfirm(true);
      return;
    }
    controller.endSession();
  }, [controller, terminalId, agentId, shouldConfirmNewSession, useNativeAssistant]);

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
      switchToAgent(preferredAgentId);
    }
  }, [switchToAgent, preferredAgentId, agentId]);

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
  //
  // The sole-installed half is now a GUARD rather than a live path. This empty state
  // only renders when the panel is not on the native surface, which means
  // `agentId ?? preferredAgentId` is some other agent — and `setTerminal` initializes
  // a null preference from the agent it launches while `clearTerminal` drops `agentId`
  // with the terminal, so a set `agentId` always implies a set preference. The
  // preference therefore always wins here. Kept because it degrades gracefully if that
  // store invariant ever slips, and because #6612's reasoning still holds for whoever
  // reaches it; not kept because anything is expected to.
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
      // A sheet that binds Escape ITSELF answers it, and the panel must not also act.
      //
      // The native assistant's approval and question sheets both take focus and both
      // bind Escape — decline, and dismiss — because the cockpit did ("Esc decline" on
      // every approval it drew). Without this guard, Escape on an approval declined the
      // tool AND hid the panel in the same keystroke, and on a question it hid the panel
      // while leaving the engine parked waiting for an answer nobody could now give.
      //
      // Marked with a data attribute rather than inferred from the event, because these
      // are React synthetic handlers and the escape stack is a document-level listener:
      // whether one sees the key before the other is an ordering detail, and a
      // correctness rule should not rest on one.
      if (active.closest("[data-escape-owner]")) return;
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
      // NO permanent `tabindex`. It is added only while this element is itself the
      // focus target (`focusPanelContainer`) and removed the moment it is not.
      //
      // A `tabindex` that stays put makes the whole region focusable, and Chromium
      // focuses the nearest focusable ANCESTOR on mousedown — which collapses the
      // selection the press was starting. The effect is that no text anywhere inside
      // the assistant could be selected with the mouse: press, drag, release, nothing.
      // Not the transcript, not an answer worth quoting, not an error message someone
      // wanted to paste into an issue. Proved by removing the attribute at runtime and
      // watching the same drag select normally (`assistant-native-panel.spec.ts`).
      //
      // Nothing is lost by leaving it off at rest. The `onFocus` below is a bubbling
      // `focusin`, so a descendant taking focus still promotes the macro region, and
      // the container itself is only ever a focus target in the fallback case where the
      // panel has no tabbable child at all.
      aria-label="Daintree Assistant"
      // `inert` removes descendants from focus / a11y tree while the aside
      // is collapsed. Chromium 146 supports it natively, so we don't need a
      // matching `aria-hidden` (which would also be redundant on an `inert`
      // element per ARIA 1.2 and trips axe's `aria-hidden-focus` rule).
      inert={!isVisible || undefined}
      data-macro-focus={isHighlighted ? "true" : undefined}
      // A press anywhere in the panel claims the macro region, without taking DOM focus.
      //
      // The permanent `tabindex` above used to do this as a side effect: a click on inert
      // panel chrome focused the region, which fired `onFocus`, which claimed it. Dropping
      // the attribute is what made the transcript selectable, and it would have quietly
      // taken the claim with it — a press on a message or the masthead would leave the
      // grid's `terminal-selected` chrome lit while the user was plainly working in here.
      //
      // Claiming it directly is the better version of that anyway: the region is about
      // which surface the user is ATTENDING to, and a press says that without a focus
      // ring landing on a container nobody meant to focus.
      onMouseDown={() => {
        // Held across the blur this very press is about to cause — see `onBlur`.
        pressInsidePanelRef.current = true;
        // The default action (the focus change) runs after this dispatch completes but
        // in the same task, so a task-boundary reset is enough and does not depend on a
        // timing guess.
        setTimeout(() => {
          pressInsidePanelRef.current = false;
        }, 0);
        if (useMacroFocusStore.getState().focusedRegion !== "assistant") {
          useMacroFocusStore.setState({ focusedRegion: "assistant" });
        }
      }}
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
          // The container is focusable only while it holds focus — see the comment on
          // the missing `tabindex` above.
          e.currentTarget.removeAttribute("tabindex");
          setHasDomFocus(false);
          // Release the macro region only if we still own it — another region
          // may have already claimed focus by the time blur runs.
          //
          // And never when the blur was caused by a press INSIDE this panel. Selecting
          // transcript text starts by pressing on something unfocusable, which blurs the
          // composer with a null `relatedTarget` — indistinguishable here from focus
          // leaving for another pane. Without the guard the panel claimed the region on
          // mousedown and dropped it again microseconds later, so every drag-to-select
          // ended with the grid's "selected" chrome lit over a pane the user was not
          // working in.
          if (
            !pressInsidePanelRef.current &&
            useMacroFocusStore.getState().focusedRegion === "assistant"
          ) {
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
        canRestartConversation={Boolean((terminalId && agentId) || nativeSessionArmed)}
        canEndSession={Boolean((terminalId && agentId) || nativeSessionArmed)}
        onRestartConversation={handleNewSession}
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
        // The strip is the only home for this action now. It used to live in the
        // header's overflow menu as well, which put the one findable route to a
        // second session two clicks behind an ellipsis.
        canOpenSession={canOpenParallelSession}
        onOpenSession={handleOpenParallelSession}
        idBase={tabIdBase}
        panelId={sessionBodyId}
      />

      {/* One runtime per open lane. Background lanes need theirs so a session
          the user has tabbed away from still surfaces approvals and still
          hibernates when idle; the ACTIVE lane needs one too, so that switching
          tabs never disarms a live lane (see the lifecycle note above). */}
      {openSlots.map((slot) => (
        <HelpSessionLaneRuntime
          key={slot}
          slot={slot}
          isActive={slot === activeSlot}
          isOpen={isOpen}
          // Withheld for the native assistant: the launch controller exists to spawn a
          // PTY, and in native mode there is no terminal to spawn. Letting it run would
          // start a SECOND engine alongside the one the panel owns, and both would reach
          // for the same per-project state lease. Applied per lane, since #12108 moved
          // the `syncInputs` this used to gate into `HelpSessionLaneRuntime`.
          isReadyToLaunch={isReadyToLaunch && !useNativeAssistant}
          currentProject={activeWorkspace}
          preferredAgentId={preferredAgentId}
          supportedInstalledAgentIds={supportedInstalledAgentIds}
          autoLaunchEnabled={autoLaunchEnabled}
          visibilityEpoch={visibilityEpoch}
        />
      ))}

      {/* Content — the strip's `tabpanel`. Named by whichever tab is selected, so the
          relationship the tablist claims through `aria-controls` actually resolves.

          No `tabIndex` of its own. The pattern asks for one only on a panel with nothing
          focusable inside it, and every state this body settles into has something: the
          terminal's textarea, the empty state's starter prompts, a banner's recovery
          action. The launching skeleton is the one exception, and giving the body a
          permanent tab stop to cover a state that lasts under a second would cost every
          keyboard user an extra stop on the way past the terminal, forever. */}
      <div
        id={sessionBodyId}
        role="tabpanel"
        aria-labelledby={helpSessionTabId(tabIdBase, activeSlot)}
        className="flex-1 flex flex-col min-h-0 relative"
      >
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
        {useNativeAssistant ? (
          <div className="flex-1 relative min-h-0">
            <AssistantPanel
              projectId={activeWorkspaceId}
              projectPath={activeWorkspacePath}
              // Latched, not `isOpen`. The engine must not start for a panel the user
              // never opened — hiding slides it off-canvas rather than unmounting, so
              // every project view would otherwise spin one up unprompted. But it must
              // not STOP on close either: closing the sidebar is not ending a
              // conversation, and tying the engine to `isOpen` silently discarded the
              // transcript every time the panel was dismissed. Start on first open,
              // then live until the project changes or the view goes away.
              active={nativeSessionArmed}
              restartNonce={nativeSessionNonce}
              className="h-full"
            />
          </div>
        ) : showTerminal ? (
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
                      Starting fresh is the overflow menu's "Restart conversation". */}
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
              // recovery path is the overflow menu's "Restart conversation"
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
            {agentId === DAINTREE_ASSISTANT_AGENT_ID ? (
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
        // Matches the overflow item that opens it. The old wording ("Start a new
        // session?") described the outcome as a gain when the thing being confirmed
        // is a loss, and it collided with the strip's own new-session control.
        title="Restart this conversation?"
        description="The current agent will stop and the conversation will be discarded"
        confirmLabel="Restart conversation"
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
        isOpen={pendingCloseSlot !== null}
        title={`Close ${pendingCloseLabel ?? "this session"}?`}
        description="The assistant will stop and the conversation will be discarded"
        confirmLabel="Close session"
        onConfirm={handleConfirmCloseSlot}
        onClose={handleCancelCloseSlot}
        variant="destructive"
        // Where focus goes once the tab this was opened from no longer exists. The
        // strip has already moved its single tab stop to the lane that took over,
        // so asking for "the tab that currently holds the stop" lands on the same
        // element the strip chose, without this dialog needing to know which one.
        // On cancel the trigger still exists and the dialog restores to it directly.
        restoreFocusTo={() =>
          panelRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]') ?? null
        }
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
