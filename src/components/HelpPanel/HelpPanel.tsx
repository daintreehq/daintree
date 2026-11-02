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
import { ExternalLink, History, MessageCircle, RotateCw, Settings2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { reportCanopySent } from "@/lib/canopySeen";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { VoiceMicNoticeBanner } from "@/components/Terminal/VoiceMicNoticeBanner";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import { shouldShowHybridInputBar } from "@/components/Terminal/terminalFocus";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import {
  subscribeWhenReady as subscribeTerminalServiceWhenReady,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { HelpIntroBanner } from "./HelpIntroBanner";
import { usePaletteStore } from "@/store/paletteStore";
import { HelpPanelHeader, summarizeLaneActivity, type AssistantScope } from "./HelpPanelHeader";
import { HelpSessionTabs, helpSessionTabId } from "./HelpSessionTabs";
import { HelpSessionLaneRuntime } from "./HelpSessionLaneRuntime";
import {
  markHelpPanelRuntimeMounted,
  markHelpPanelRuntimeUnmounted,
} from "@/lib/helpPanelRuntimeGate";
import {
  acquireHelpSessionController,
  useHelpSessionController,
} from "@/controllers/helpSessionControllerRegistry";
import { assistantSlotKey } from "@shared/config/assistantSlots";
import { HelpPanelBanners } from "./HelpPanelBanners";
import {
  closeSessionDescription,
  useLatchedWhileOpen,
  usePastSessionsNote,
} from "./pastSessionsNote";
import { HelpPanelVersionGate } from "./HelpPanelVersionGate";
import { HelpAssistantAgentChooser } from "./HelpAssistantAgentChooser";
import { HelpLaunchingState } from "./HelpLaunchingState";
import { HelpPanelFooter } from "./HelpPanelFooter";
import { HelpPanelResizeHandle } from "./HelpPanelResizeHandle";
import { useHelpPanelResize } from "./useHelpPanelResize";
import { useHelpPanelRevealFocus } from "./useHelpPanelRevealFocus";
import { useHelpSessionLanes, type PausedLane } from "./useHelpSessionLanes";
import { useGlobalAssistantActivity } from "./useGlobalAssistantActivity";
import { FigureRail } from "./FigureRail";
import { useHelpPanelStore, selectSlot } from "@/store/helpPanelStore";
import {
  usePanelStore,
  getTerminalRefreshTier,
  useCliAvailabilityStore,
  useProjectStore,
  useWorktreeSelectionStore,
  useTerminalInputStore,
} from "@/store";
import { useMacroFocusStore } from "@/store/macroFocusStore";
// Leaf import, not the `@/store` barrel: the barrel is mocked wholesale (with a
// hand-listed hook set) across the HelpPanel/controller suites, so pulling a new
// hook through it would crash every one of them on an undefined destructure.
import { useScratchStore } from "@/store/scratchStore";
import { selectMicNoticeForPanel, useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useFocusStore } from "@/store/focusStore";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { buildResumeCommand } from "@shared/types/agentSettings";
import { actionService } from "@/services/ActionService";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useAssistantAgentChoices } from "@/hooks/useAssistantAgentChoices";
import { resolveLaunchableAssistantAgentId } from "@/hooks/assistantAgentSelection";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { TerminalRefreshTier } from "@/types";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// Loaded on first open: the picker reads the panel store and the agents'
// history, none of which the panel needs until someone asks for it.
// Loaded on first selecting the global tab: a view that never shows it pays nothing.
const LazyGlobalAssistantPane = lazy(() =>
  import("./GlobalAssistantPane").then((m) => ({ default: m.GlobalAssistantPane }))
);
const LazyHelpPastSessionsPalette = lazy(() =>
  import("./HelpPastSessionsPalette").then((m) => ({ default: m.HelpPastSessionsPalette }))
);

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const ASSISTANT_DOCS_URL = "https://daintree.org/docs/daintree-assistant";
const ASSISTANT_INSTALLER_URL = "https://daintree.org/download";

// How long `agentState` must stay "exited" before the assistant self-stops and
// slides the sidebar out. The FSM's "exited" is sticky (only a `respawn` leaves
// it), so a real `/exit` easily clears this, while a transient mis-detection
// flap (#10911) bounces back to a live state well within the window — keeping a
// spurious tick from tearing down a running conversation.
const ASSISTANT_AGENT_EXIT_SETTLE_MS = 750;

/** "Claude or Codex": the agents that can run the assistant, for the line saying what to install. */
function assistantAgentNames(): string {
  const names = getAssistantSupportedAgentIds().map((id) => getAgentConfig(id)?.name ?? id);
  if (names.length === 0) return "a supported agent";
  return new Intl.ListFormat("en", { type: "disjunction" }).format(names);
}

// Stock starter prompts, shown whenever the assistant has no session and the
// project supplies none of its own. Clicking one starts the assistant AND seeds
// the agent with the question, so the card text is exactly what gets sent.
const DEFAULT_STARTER_PROMPTS: readonly string[] = [
  "How do I set up a new worktree?",
  "Explain Daintree's panel system",
  "Help me configure my first agent",
];

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
  const [showEndSessionConfirm, setShowEndSessionConfirm] = useState(false);
  const [showAgentSwitchConfirm, setShowAgentSwitchConfirm] = useState(false);
  // The switch request the effect last acted on, so one Settings pick drives at
  // most one switch attempt (the effect re-runs on unrelated dep changes while
  // the async launch settles).
  const handledSwitchRequestIdRef = useRef<number | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);

  // The lane this panel body is showing, and its controller (#12108).
  //
  // The controller comes from the per-view registry rather than `useState`:
  // switching tabs must hand this component a DIFFERENT controller while
  // leaving the previous lane's instance running, and a lane that scrolls off
  // screen keeps its launch phase, banners and IPC subscriptions intact. A
  // `useState` instance would be per-component and would die on tab switch.
  const activeSlot = useHelpPanelStore((s) => s.activeSlot);
  // The global assistant replaces the lane body while its tab is selected
  // (#14454); every lane keeps running behind it, as a background lane does.
  const globalSelected = useHelpPanelStore((s) => s.globalSelected);
  const controller = useHelpSessionController(activeSlot);

  const session = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const {
    isOpen,
    width,
    terminalId,
    sessionId,
    agentId,
    preferredAgentId,
    agentSwitchRequest,
    autoLaunchEnabled,
    droppedPreferredAgentId,
    introDismissed,
    conversationTouched,
    focusRequest,
    figures,
    activeFigureNumber,
    figureRequest,
    markConversationStarted,
    setWidth,
    setOpen,
    setAutoLaunchEnabled,
    setPreferredAgent,
    clearAgentSwitchRequest,
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
      agentSwitchRequest: s.agentSwitchRequest,
      autoLaunchEnabled: s.autoLaunchEnabled,
      droppedPreferredAgentId: s.droppedPreferredAgentId,
      introDismissed: s.introDismissed,
      conversationTouched: selectSlot(s, s.activeSlot).conversationTouched,
      focusRequest: s.focusRequest,
      figures: selectSlot(s, s.activeSlot).figures,
      activeFigureNumber: selectSlot(s, s.activeSlot).activeFigureNumber,
      figureRequest: selectSlot(s, s.activeSlot).figureRequest,
      markConversationStarted: s.markConversationStarted,
      setWidth: s.setWidth,
      setOpen: s.setOpen,
      setAutoLaunchEnabled: s.setAutoLaunchEnabled,
      setPreferredAgent: s.setPreferredAgent,
      clearAgentSwitchRequest: s.clearAgentSwitchRequest,
      dismissIntro: s.dismissIntro,
      clearDroppedPreferredAgent: s.clearDroppedPreferredAgent,
    }))
  );

  const terminal = usePanelStore((s) => (terminalId ? s.panelsById[terminalId] : undefined));
  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;
  const voiceMicNotice = useVoiceRecordingStore((s) => selectMicNoticeForPanel(s, terminalId));
  // Narrow structural triggers for the reveal-focus effect (useHelpPanelRevealFocus). A live
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

  // A project's own starter prompts replace the stock ones. Read on demand —
  // on open and on project switch — so an edit to the file shows up without a
  // watcher. `null` while the read is in flight: the cards stay hidden until it
  // settles, so a stock card is never clickable while replacements are pending.
  const [projectStarterPrompts, setProjectStarterPrompts] = useState<string[] | null>(null);
  useEffect(() => {
    setProjectStarterPrompts(null);
    if (!isOpen) return;
    if (!activeWorkspaceId) {
      setProjectStarterPrompts([]);
      return;
    }
    let cancelled = false;
    const request =
      window.electron.help.getStarterPrompts?.(activeWorkspaceId) ?? Promise.resolve([]);
    void request
      .then((prompts) => {
        if (!cancelled) setProjectStarterPrompts(prompts);
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to load project starter prompts", err);
        if (!cancelled) setProjectStarterPrompts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeWorkspaceId]);
  const starterPrompts =
    projectStarterPrompts === null
      ? []
      : projectStarterPrompts.length > 0
        ? projectStarterPrompts
        : DEFAULT_STARTER_PROMPTS;

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
  const pinnedWorktreeId = pinnedContext?.worktreeId;
  const returnToPinnedWorktree = useCallback(() => {
    if (pinnedWorktreeId) {
      selectWorktree(pinnedWorktreeId, { source: "user" });
    }
  }, [pinnedWorktreeId, selectWorktree]);

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
  // Drives the single-supported-agent auto-skip in the controller, and the
  // "New session with…" items, which the toolbar button offers from the same list.
  const supportedInstalledAgentIds = useAssistantAgentChoices();
  const supportedInstalledAgentIdsKey = supportedInstalledAgentIds.join(",");
  // The choices stay empty until detection has real data, so an empty list
  // only means "none installed" once it does (#15233).
  const agentDetectionDone = useCliAvailabilityStore((s) => s.hasRealData);
  const agentDetectionFailed = useCliAvailabilityStore((s) => Boolean(s.error));
  const showAgentDetection = useDohertyGate(!agentDetectionDone && !agentDetectionFailed);

  // A conversation the eviction/crash path captured for this workspace but never
  // resumed. On LRU eviction (or renderer crash) main kills the assistant PTY
  // via HelpSessionService.revokeByWebContentsId — grid PTYs survive in the
  // pty-host, the assistant doesn't — and stashes a resume token in its
  // pending-hibernation store. When the idle empty state is about to show, peek
  // that store so we can offer "Resume assistant" instead of a fresh "Start
  // assistant", making a workspace switch-back read as a recoverable pause rather
  // than a crash. The same pointer brings a lane back after an app quit or crash
  // (#13205). The peek is non-consuming, like the launch flow's claim via
  // takePendingHibernation. We stamp the entry with its workspace id so
  // a mid-flight A→B switch can't show workspace A's Resume CTA over workspace B.
  const [resumablePending, setResumablePending] = useState<PausedLane | null>(null);
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
        // Offer Resume only for an agent that is still installed AND an entry
        // the controller can resume by exact id (#13205). A non-resumable agent,
        // or an entry with no id (a Codex lane never captured), would dead-end
        // in `_spawnResumed` and start fresh, so "Resume" would lie. A lane
        // whose assistant is still running on the host (#13360) needs neither:
        // the launch takes the live process over instead of resuming anything.
        const canResume =
          pendingAgentId != null &&
          (pending?.live === true ||
            (supportedInstalledAgentIds.includes(pendingAgentId) &&
              !!pending?.agentSessionId &&
              buildResumeCommand(pendingAgentId, pending.agentSessionId) !== undefined));
        setResumablePending(
          canResume
            ? {
                workspaceId: activeWorkspaceId,
                slot: activeSlot,
                agentId: pendingAgentId,
                live: pending?.live === true,
              }
            : null
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

  // Cross-workspace and cross-lane bleed guard: an A→B switch (of workspace or
  // of tab) re-runs the peek effect, but B's peek resolves asynchronously, so
  // only trust a pending entry stamped with the workspace and lane in view.
  const pendingInView =
    resumablePending &&
    resumablePending.workspaceId === activeWorkspaceId &&
    resumablePending.slot === activeSlot
      ? resumablePending
      : null;
  const resumableAgentId = pendingInView?.agentId ?? null;
  // The same pause, offered as a fresh start too (#14981). A fresh start launches
  // the captured agent anew, so it needs that agent installed, which a Resume of
  // one still running on the host does not.
  const pausedLane =
    pendingInView && supportedInstalledAgentIds.includes(pendingInView.agentId)
      ? pendingInView
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
    // A lane resumes when it's the one on screen. Global can be on screen as
    // a cold view opens, brought by the project switch that opened it (#16099).
    if (!activeWorkspaceId || terminalId || !isReadyToLaunch || globalSelected) return;
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
  }, [activeWorkspaceId, activeSlot, terminalId, isReadyToLaunch, globalSelected, setOpen]);

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
    if (!autoResumeAgentId || !isOpen || globalSelected) return;
    if (terminalId) {
      setAutoResumeAgentId(null);
      return;
    }
    controller.launch({ agentId: autoResumeAgentId, replaceExisting: true, resumeOnly: true });
    setAutoResumeAgentId(null);
  }, [autoResumeAgentId, isOpen, globalSelected, terminalId, controller]);

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

  // Apply an agent picked in Settings in this view to the live session,
  // gated by the same D1 confirm as a new session when there's a
  // conversation to lose (#8353 — switching the assistant agent was a silent
  // no-op). Only an explicit pick queues a request; the default itself is the
  // host's and also moves on an import or a pick in another window, which
  // must never replace a session here (#13345).
  useEffect(() => {
    if (!agentSwitchRequest) {
      if (showAgentSwitchConfirm) setShowAgentSwitchConfirm(false);
      return;
    }
    // No live session to replace yet. Keep the request — a pick made before
    // a terminal binds must still switch once one appears (#8353 critical fix).
    if (!terminalId) return;
    // Already running the picked agent — covers the auto-launch that the pick
    // itself drove and the user reverting the dropdown back to the live agent.
    // Closing the confirm keeps a stale "Switch to X?" from firing.
    if (agentSwitchRequest.agentId === agentId) {
      clearAgentSwitchRequest(agentSwitchRequest.id);
      if (showAgentSwitchConfirm) setShowAgentSwitchConfirm(false);
      return;
    }
    if (handledSwitchRequestIdRef.current === agentSwitchRequest.id) return;
    handledSwitchRequestIdRef.current = agentSwitchRequest.id;
    const shouldConfirm =
      (terminalPty?.agentState !== undefined &&
        CLOSE_CONFIRM_AGENT_STATES.has(terminalPty.agentState)) ||
      conversationTouched;
    if (shouldConfirm) {
      // The dialog reads the live request, so a retarget to a third agent
      // while it's open tracks the latest pick.
      setShowAgentSwitchConfirm(true);
      return;
    }
    clearAgentSwitchRequest(agentSwitchRequest.id);
    controller.selectAgent(agentSwitchRequest.agentId);
  }, [
    controller,
    agentSwitchRequest,
    clearAgentSwitchRequest,
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

  useHelpPanelRevealFocus({
    panelRef,
    inputBarRef,
    isOpen,
    isVisible,
    focusRequest,
    terminalId,
    terminalExists,
    terminalSpawnStatus,
    showHybridInputBar,
  });

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
    const focused = isOpen && isVisible && hasDomFocus;
    return subscribeTerminalServiceWhenReady((service) => {
      service.setFocused(terminalId, focused);
      return () => service.setFocused(terminalId, false);
    });
  }, [isOpen, isVisible, hasDomFocus, terminalId]);

  const { isResizing, handleResizeStart, handleResizeKeyDown, handleResetWidth } =
    useHelpPanelResize({ width, setWidth, onResizeStart, onResizeEnd });

  // Child effects run before the parent's, so every lane runtime's
  // `controller.start()` has armed its listeners by the time this fires.
  useEffect(() => {
    markHelpPanelRuntimeMounted();
    return markHelpPanelRuntimeUnmounted;
  }, []);

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

  const {
    tabIdBase,
    sessionBodyId,
    openSlots,
    canOpenParallelSession,
    canStartSessionWithAgent,
    sessionTabs,
    handleOpenParallelSession,
    handleOpenSessionWithAgent,
    handleSelectSlot,
    handleCloseSlot,
    handleRestartSlot,
    handleRestartActiveSlot,
    pendingRestartSlot,
    pendingRestartPaused,
    handleConfirmRestartSlot,
    handleCancelRestartSlot,
    resolveRestartFocusTarget,
    pendingCloseSlot,
    pendingCloseLabel,
    pendingCloseCost,
    handleConfirmCloseSlot,
    handleCancelCloseSlot,
    resolveCloseFocusTarget,
  } = useHelpSessionLanes({ panelRef, activeSlot, activeWorkspaceId, terminalId, pausedLane });
  // A restart can target a background lane, whose agent may not be the one on
  // screen: read from the same lane record the confirm gate reads. A paused lane
  // has no agent bound, so its captured one names the conversation instead.
  const pendingRestartLaneAgentId = useHelpPanelStore((s) =>
    pendingRestartSlot === null ? null : selectSlot(s, pendingRestartSlot).agentId
  );
  const restartDescription = usePastSessionsNote(
    pendingRestartSlot !== null,
    pendingRestartPaused && !pendingRestartPaused.live
      ? "This tab starts a new conversation"
      : "The agent stops and this tab starts a new conversation",
    pendingRestartPaused?.agentId ?? pendingRestartLaneAgentId
  );
  const endSessionDescription = usePastSessionsNote(
    showEndSessionConfirm,
    "The agent stops and the next start opens a new conversation",
    agentId
  );
  const closeDescription = useLatchedWhileOpen(
    pendingCloseSlot !== null,
    pendingCloseCost ? closeSessionDescription(pendingCloseCost) : ""
  );
  const closeTitle = useLatchedWhileOpen(pendingCloseSlot !== null, `Close ${pendingCloseLabel}?`);
  // The conversation being left is the running agent's, not the pick's.
  const agentSwitchDescription = usePastSessionsNote(
    showAgentSwitchConfirm,
    "The current agent stops and the new one starts in this tab",
    agentId
  );

  // Shows the global run, whichever it is; never starts one.
  // The focus request outstanding when Global was picked on the switch: the
  // keyboard stays on the switch, so the pane must not claim it on mount.
  const [scopeSwitchFocusRequest, setScopeSwitchFocusRequest] = useState(-1);
  const handleScopeChange = useCallback((scope: AssistantScope) => {
    const panel = useHelpPanelStore.getState();
    if (scope === "global") {
      setScopeSwitchFocusRequest(panel.focusRequest);
      panel.selectGlobal(null);
    } else {
      panel.setActiveSlot(panel.activeSlot);
    }
  }, []);
  const projectActivity = useMemo(() => summarizeLaneActivity(sessionTabs), [sessionTabs]);
  const globalAgentState = useGlobalAssistantActivity(isOpen && isVisible && !globalSelected);
  const globalActivity = useMemo(
    () => summarizeLaneActivity([{ label: "Global assistant", agentState: globalAgentState }]),
    [globalAgentState]
  );
  // The header slot the global pane draws its agent and menu into.
  const [globalControlsHost, setGlobalControlsHost] = useState<HTMLDivElement | null>(null);

  // Stop reuses the same "something to lose" gate as +New session — confirm
  // only when a working agent or an engaged conversation would be ended.
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
    if (!agentSwitchRequest) return;
    clearAgentSwitchRequest(agentSwitchRequest.id);
    // Guard against the pick having moved back to the running agent between
    // opening the dialog and confirming.
    if (agentSwitchRequest.agentId !== agentId) {
      controller.selectAgent(agentSwitchRequest.agentId);
    }
  }, [controller, agentSwitchRequest, clearAgentSwitchRequest, agentId]);

  // Leave the default as the user set it — reverting it on cancel would be a
  // silent fallback the dropdown wouldn't reflect. The session simply stays on
  // the running agent; only the request to switch it is dropped.
  const handleCancelAgentSwitch = useCallback(() => {
    setShowAgentSwitchConfirm(false);
    if (agentSwitchRequest) clearAgentSwitchRequest(agentSwitchRequest.id);
  }, [agentSwitchRequest, clearAgentSwitchRequest]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "assistant" }, { source: "user" });
  }, []);

  const isPastSessionsOpen = usePaletteStore((s) => s.activePaletteId === "assistant-sessions");
  // Stays mounted once opened so the palette's exit animation can run.
  const [pastSessionsMounted, setPastSessionsMounted] = useState(false);
  if (isPastSessionsOpen && !pastSessionsMounted) setPastSessionsMounted(true);

  const handleResumePastSession = useCallback(() => {
    void actionService.dispatch("help.resumePastSession", undefined, { source: "user" });
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
  // single unambiguous target exists; with several, the empty state asks.
  const launchableAgentId = resolveLaunchableAssistantAgentId(
    preferredAgentId,
    supportedInstalledAgentIds
  );

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

  // Explicit, billed start (#10699). Starts this one session and nothing more:
  // whether later opens start one is the menu's "Start when the panel opens",
  // never a side effect of this click (#14976). An optional starter prompt
  // seeds the first turn (skips the resume path by design).
  const handleStartAssistant = useCallback(
    (seedPrompt?: string) => {
      if (!launchableAgentId) return;
      controller.launch({
        agentId: launchableAgentId,
        replaceExisting: true,
        ...(seedPrompt ? { seedPrompt } : {}),
      });
    },
    [controller, launchableAgentId]
  );

  // The strip's "New session" is an explicit start too, so it launches into the
  // new tab itself rather than leaving that to the tab's auto-launch, which only
  // runs with "Start when the panel opens" on (#14976). Queued before the tab's
  // first input sync; with several agents and no default, the tab asks instead.
  // A tab that turns out to hold a captured conversation (a cold view whose
  // lanes are still being listed) is left to offer its own Resume: the default
  // agent started there would replace that conversation.
  const handleNewSession = useCallback(() => {
    const slot = handleOpenParallelSession();
    if (slot === null || !launchableAgentId) return;
    const { hibernateSessions } = useHelpPanelStore.getState();
    if (activeWorkspaceId && hibernateSessions[assistantSlotKey(activeWorkspaceId, slot)]) return;
    acquireHelpSessionController(slot).launchWhenReady({
      agentId: launchableAgentId,
      replaceExisting: true,
    });
  }, [activeWorkspaceId, handleOpenParallelSession, launchableAgentId]);

  // A starter never submits into a live session: if one has appeared since the
  // card rendered, the prompt lands in its input as a draft for the user to send.
  const handleStarterPrompt = useCallback(
    (prompt: string) => {
      const store = useHelpPanelStore.getState();
      const liveTerminalId = selectSlot(store, store.activeSlot).terminalId;
      if (!liveTerminalId) {
        handleStartAssistant(prompt);
        return;
      }
      // Same scope the composer reads its draft under: the project id, none for a scratch.
      const draftScope = currentProject?.id;
      const inputs = useTerminalInputStore.getState();
      const existing = inputs.getDraftInput(liveTerminalId, draftScope);
      inputs.setDraftInput(
        liveTerminalId,
        existing ? `${existing}\n${prompt}` : prompt,
        draftScope
      );
      inputs.bumpExternalDraftRevision();
    },
    [currentProject?.id, handleStartAssistant]
  );

  // First-run choice when several installed agents could run the assistant:
  // the pick is stored as the default, then launched like "Start assistant".
  const handleChooseAssistant = useCallback(
    (chosenAgentId: string) => {
      // Launched directly below, so no switch request rides along.
      setPreferredAgent(chosenAgentId, { switchSession: false });
      controller.launch({ agentId: chosenAgentId, replaceExisting: true });
    },
    [controller, setPreferredAgent]
  );

  // Recovery resume after the eviction/crash path killed the assistant PTY on a
  // project switch-away. Like "Start assistant", this does NOT record
  // auto-launch consent (#10699): resuming a stranded session is a one-time,
  // user-initiated recovery, not an opt-in to billed auto-launch on every
  // future open. The launch flow seeds the captured entry from main and
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
  const revokeGrant = useCallback((key: string) => controller.revokeGrant(key), [controller]);
  const dismissGrantEnded = useCallback(() => controller.dismissGrantEnded(), [controller]);
  const cancelLaunch = useCallback(() => controller.cancelLaunch(), [controller]);
  const checkVersionAgain = useCallback(() => controller.checkVersionAgain(), [controller]);
  const dismissLaunchError = useCallback(() => controller.dismissLaunchError(), [controller]);
  const dismissSessionRevoked = useCallback(() => controller.dismissSessionRevoked(), [controller]);
  const dismissOutcomeAlert = useCallback(() => controller.dismissOutcomeAlert(), [controller]);
  const retryLaunch = useCallback(() => {
    const agentId = session.launchError?.agentId;
    if (agentId) controller.retryLaunch(agentId);
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
      <HelpPanelResizeHandle
        width={width}
        isResizing={isResizing}
        isVisible={isVisible}
        controlsId="daintree-assistant-panel"
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        onReset={handleResetWidth}
      />

      <HelpPanelHeader
        agentState={globalSelected ? null : terminalPty?.agentState}
        scope={globalSelected ? "global" : "project"}
        onScopeChange={handleScopeChange}
        globalControlsRef={setGlobalControlsHost}
        projectActivity={projectActivity}
        globalActivity={globalActivity}
        canRestartConversation={
          !globalSelected && (Boolean(terminalId && agentId) || pausedLane !== null)
        }
        canEndSession={!globalSelected && Boolean(terminalId && agentId)}
        onRestartConversation={handleRestartActiveSlot}
        onEndSession={handleEndSession}
        onResumePastSession={handleResumePastSession}
        onOpenDocs={handleOpenAssistantDocs}
        autoLaunchEnabled={autoLaunchEnabled}
        onAutoLaunchEnabledChange={setAutoLaunchEnabled}
        onClose={handleClose}
        isFocused={isHighlighted}
        newSessionAgentIds={supportedInstalledAgentIds}
        canStartNewSession={canStartSessionWithAgent}
        onNewSessionWithAgent={handleOpenSessionWithAgent}
      />

      {pastSessionsMounted && (
        <Suspense fallback={null}>
          <LazyHelpPastSessionsPalette workspace={activeWorkspace} tabs={sessionTabs} />
        </Suspense>
      )}

      {!globalSelected && (
        <HelpSessionTabs
          tabs={sessionTabs}
          isRegionFocused={isHighlighted}
          activeSlot={activeSlot}
          onSelect={handleSelectSlot}
          onClose={handleCloseSlot}
          onRestart={handleRestartSlot}
          // The strip is the only home for this action now. It used to live in the
          // header's overflow menu as well, which put the one findable route to a
          // second session two clicks behind an ellipsis.
          canOpenSession={canOpenParallelSession}
          onOpenSession={handleNewSession}
          newSessionAgentIds={supportedInstalledAgentIds}
          canOpenSessionWithAgent={canStartSessionWithAgent}
          onOpenSessionWithAgent={handleOpenSessionWithAgent}
          idBase={tabIdBase}
          panelId={sessionBodyId}
        />
      )}

      {/* One runtime per open lane. Background lanes need theirs so a session
          the user has tabbed away from still surfaces approvals and still
          hibernates when idle; the ACTIVE lane needs one too, so that switching
          tabs never disarms a live lane (see the lifecycle note above). */}
      {openSlots.map((slot) => (
        <HelpSessionLaneRuntime
          key={slot}
          slot={slot}
          isActive={!globalSelected && slot === activeSlot}
          isOpen={isOpen}
          isReadyToLaunch={isReadyToLaunch}
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
        // The strip's panel only while the strip is there; the global run has no tab.
        role={globalSelected ? "region" : "tabpanel"}
        aria-label={globalSelected ? "Global assistant" : undefined}
        aria-labelledby={globalSelected ? undefined : helpSessionTabId(tabIdBase, activeSlot)}
        className="flex-1 flex flex-col min-h-0 relative"
      >
        {/* Banners render above every content state — the launch-error banner
            must stay visible in the empty state a failed launch falls back to.
            The other banners are null unless a session is live, so this mount
            position is behaviorally identical for them. */}
        {!globalSelected && (
          <HelpPanelBanners
            showResumeBanner={session.showResumeBanner}
            tierMismatch={session.tierMismatch}
            launchError={session.launchError}
            sessionRevoked={session.sessionRevoked}
            isApprovingTier={session.isApprovingTier}
            activeGrants={session.activeGrants}
            grantEnded={session.grantEnded}
            revokingGrantKeys={session.revokingGrantKeys}
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
            onStartNewSession={handleRestartActiveSlot}
            onDismissSessionRevoked={dismissSessionRevoked}
          />
        )}
        {globalSelected ? (
          <Suspense fallback={null}>
            <LazyGlobalAssistantPane
              isVisible={isVisible}
              controlsHost={globalControlsHost}
              focusHandledThrough={scopeSwitchFocusRequest}
              onOpenDocs={handleOpenAssistantDocs}
            />
          </Suspense>
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
              {voiceMicNotice && <VoiceMicNoticeBanner notice={voiceMicNotice} />}
              {/* Claims the right-click so the app views' native edit menu
                  stays out of the terminal: xterm parks its helper textarea
                  under the pointer, and Cut or Select all there would act on
                  that textarea, not the terminal buffer. Grid terminals get
                  the same from their panel menu's trigger. */}
              <div
                className="flex-1 relative min-h-0"
                onContextMenu={(event) => event.preventDefault()}
              >
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
                    // The aside's own focus state, the one its edge shows: the
                    // grid's selection never names the Assistant's terminal.
                    selected={isHighlighted}
                    onSend={({ text, imagePaths }) => {
                      if (terminalPty?.isInputLocked === true) return;
                      withTerminalService(
                        (service) => service.notifyUserInput(terminalId),
                        terminalId
                      );
                      reportCanopySent(terminalId);
                      // submit can now reject for dead PTYs (#8706); swallow
                      // to log so the unhandled rejection doesn't leak — the
                      // help panel is a one-shot send with no recovery UI.
                      const submission =
                        imagePaths !== undefined && imagePaths.length > 0
                          ? terminalClient.submitWithImages(terminalId, text, imagePaths)
                          : terminalClient.submit(terminalId, text);
                      submission.catch((err) => {
                        logWarn("[HelpPanel] submit failed", { terminalId, error: err });
                      });
                    }}
                    onSendKey={(key) => {
                      if (terminalPty?.isInputLocked === true) return;
                      if (key === "escape") {
                        withTerminalService(
                          (service) => service.clearDirectingState(terminalId, "escape-key"),
                          terminalId
                        );
                      } else {
                        withTerminalService(
                          (service) => service.notifyUserInput(terminalId),
                          terminalId
                        );
                      }
                      if (key === "enter") reportCanopySent(terminalId);
                      terminalClient.sendKey(terminalId, key);
                    }}
                  />
                </Suspense>
              )}
              {figures.length > 0 && (
                <FigureRail
                  figures={figures}
                  activeFigureNumber={activeFigureNumber}
                  figureRequest={figureRequest}
                  onActivateFigure={(figureNumber) =>
                    useHelpPanelStore.getState().setActiveFigureNumber(activeSlot, figureNumber)
                  }
                  onFigureRequestHandled={() =>
                    useHelpPanelStore.getState().clearFigureRequest(activeSlot)
                  }
                />
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
              <InlineStatusBanner
                severity="warning"
                animated={false}
                data-testid="help-dropped-agent-banner"
                title={`${getAgentConfig(droppedPreferredAgentId)?.name ?? droppedPreferredAgentId} is no longer available`}
                description="The agent was removed or is no longer supported as an assistant backend"
                action={{
                  id: "open-settings",
                  label: "Open assistant settings",
                  variant: "primary",
                  onClick: handleOpenSettings,
                }}
                onClose={clearDroppedPreferredAgent}
                closeAriaLabel="Dismiss agent unavailable notice"
              />
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
                      Does not record auto-launch consent (#10699). This is the
                      single load-bearing accent here. */}
                  <Button
                    type="button"
                    onClick={handleResumeAssistant}
                    data-testid="help-resume-assistant"
                  >
                    <ResumeAssistantIcon />
                    Resume assistant
                  </Button>
                  {/* Coming back to a stale conversation is when a clean one is most
                      likely wanted (#14981): the same confirmed restart the overflow
                      menu offers, kept neutral so Resume stays the primary. */}
                  {pausedLane && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRestartActiveSlot}
                      data-testid="help-restart-paused-conversation"
                    >
                      <RotateCw aria-hidden="true" />
                      Restart conversation
                    </Button>
                  )}
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
                  {starterPrompts.length > 0 && (
                    <div className="flex flex-col gap-1.5 w-full">
                      <p className="text-2xs text-text-secondary">Or start with a question</p>
                      {starterPrompts.map((prompt) => (
                        <ChoiceCard
                          key={prompt}
                          padding="sm"
                          onClick={() => handleStarterPrompt(prompt)}
                          className="items-center gap-2 w-full text-xs text-text-primary"
                        >
                          <MessageCircle
                            className="w-3.5 h-3.5 shrink-0 text-text-secondary"
                            aria-hidden="true"
                          />
                          <span>{prompt}</span>
                        </ChoiceCard>
                      ))}
                    </div>
                  )}
                </div>
              ) : supportedInstalledAgentIds.length > 1 ? (
                <div className="w-full max-w-[34ch]">
                  <HelpAssistantAgentChooser
                    agentIds={supportedInstalledAgentIds}
                    onChoose={handleChooseAssistant}
                  />
                </div>
              ) : agentDetectionDone ? (
                <p className="text-xs text-text-secondary max-w-[32ch]">
                  {`Install ${assistantAgentNames()} to use Daintree Assistant.`}
                </p>
              ) : agentDetectionFailed ? (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-xs text-text-secondary max-w-[32ch]">
                    Couldn&apos;t check which agents are installed.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      // The store keeps the error that drives this line; a
                      // second failure only needs logging.
                      void useCliAvailabilityStore
                        .getState()
                        .refresh(true)
                        .catch((error: unknown) =>
                          logWarn("[HelpPanel] Agent detection retry failed", { error })
                        )
                    }
                  >
                    Retry
                  </Button>
                </div>
              ) : showAgentDetection ? (
                <p className="text-xs text-text-secondary max-w-[32ch]">
                  Checking installed agents…
                </p>
              ) : null}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleResumePastSession}
                  data-testid="help-resume-past-session"
                  className="flex items-center gap-1 text-2xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                >
                  <History className="w-3.5 h-3.5" />
                  Resume a past session…
                </button>
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

      {!globalSelected && showTerminal && agentConfig && agentId && !isMissingCli && (
        <HelpPanelFooter
          sessionId={sessionId}
          activity={session.mcpActivity}
          outcomeAlert={session.outcomeAlert}
          onDismissOutcome={dismissOutcomeAlert}
          terminalId={terminalId ?? null}
          pinnedContext={pinnedContext}
          isPinnedWorktreeDiverged={isPinnedWorktreeDiverged}
          onReturnToPinnedWorktree={returnToPinnedWorktree}
          agentConfig={agentConfig}
          launchedModelLabel={launchedModelLabel}
        />
      )}
      <ConfirmDialog
        isOpen={pendingRestartSlot !== null}
        // Matches the items that open it — the overflow menu's and each tab's. The
        // old wording ("Start a new session?") described the outcome as a gain when
        // the thing being confirmed is a loss, and it collided with the strip's own
        // new-session control.
        title="Restart this conversation?"
        description={restartDescription}
        confirmLabel="Restart conversation"
        onConfirm={handleConfirmRestartSlot}
        onClose={handleCancelRestartSlot}
        variant="destructive"
        // Used only when the opener cannot take focus back: the overflow trigger
        // still can, a tab menu's item cannot.
        restoreFocusTo={resolveRestartFocusTarget}
      />
      <ConfirmDialog
        isOpen={showEndSessionConfirm}
        title="Stop assistant?"
        description={endSessionDescription}
        confirmLabel="Stop assistant"
        onConfirm={handleConfirmEndSession}
        onClose={handleCancelEndSession}
        variant="destructive"
      />
      <ConfirmDialog
        isOpen={pendingCloseSlot !== null}
        title={closeTitle}
        description={closeDescription}
        confirmLabel="Close session"
        onConfirm={handleConfirmCloseSlot}
        onClose={handleCancelCloseSlot}
        variant="destructive"
        // Where focus goes once the tab this was opened from no longer exists: the
        // closed lane's neighbour, or the newly selected lane when the selected one
        // was closed — the same rule the strip's own Delete handoff follows. On
        // cancel the trigger still exists and the dialog restores to it directly.
        restoreFocusTo={resolveCloseFocusTarget}
      />
      <ConfirmDialog
        isOpen={showAgentSwitchConfirm}
        title={`Switch to ${
          getAgentConfig(agentSwitchRequest?.agentId ?? "")?.name ??
          agentSwitchRequest?.agentId ??
          "agent"
        }?`}
        description={agentSwitchDescription}
        confirmLabel="Switch agent"
        onConfirm={handleConfirmAgentSwitch}
        onClose={handleCancelAgentSwitch}
        variant="destructive"
      />
    </aside>
  );
}
