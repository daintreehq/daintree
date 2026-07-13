import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Settings, OctagonAlert, RotateCcw, Hourglass, Folders } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import type {
  TerminalRestartError,
  SpawnError,
  TerminalReconnectError,
  TerminalScrollbackRestoreError,
  PersistableFlowStatus,
} from "@/types";
import { cn } from "@/lib/utils";
import { BANNER_ENTER_DURATION, BANNER_EXIT_DURATION } from "@/lib/animationUtils";
import { XtermAdapter } from "./XtermAdapter";
import { ArtifactOverlay } from "./ArtifactOverlay";

import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalScrollIndicator } from "./TerminalScrollIndicator";
import { useGridScrollRoot } from "./GridScrollRootContext";
import { isStaleHiddenReading } from "./visibilityReadingGuard";
import { useUnmountVisibilityCleanup } from "./useUnmountVisibilityCleanup";
import { COMFORTABLE_PANEL_HEIGHT_PX } from "@/lib/terminalLayout";
import { FleetDraftingPill } from "@/components/Fleet/FleetDraftingPill";
import { TerminalRestartStatusBanner } from "./TerminalRestartStatusBanner";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { useForceResumeCycleWatchdog } from "@/hooks/terminal/useForceResumeCycleWatchdog";
import { useContextInjection } from "@/hooks/useContextInjection";
import { getRestartBannerVariant } from "./restartStatus";
import { TerminalErrorBanner } from "./TerminalErrorBanner";
import { SpawnErrorBanner } from "./SpawnErrorBanner";
import { ReconnectErrorBanner } from "./ReconnectErrorBanner";
import { ScrollbackRestoreErrorBanner } from "./ScrollbackRestoreErrorBanner";
import { useShouldSuppressLocalError } from "@/components/Recovery/useShouldSuppressLocalError";
import { UpdateCwdDialog } from "./UpdateCwdDialog";
import { ErrorBanner } from "../Errors/ErrorBanner";
import { AgentCompletionBanner } from "./AgentCompletionBanner";
import { ContentPanel } from "@/components/Panel";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useIsDragging } from "@/components/DragDrop";
import { MissingCliGate } from "./MissingCliGate";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { AgentCliDetail } from "@shared/types/ipc";
import {
  useErrorStore,
  usePanelStore,
  getTerminalRefreshTier,
  useTerminalInputStore,
} from "@/store";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalLogic } from "@/hooks/useTerminalLogic";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { errorsClient } from "@/clients";
import type { AgentState } from "@/types";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { actionService } from "@/services/ActionService";
import { InputTracker } from "@/services/clearCommandDetection";
import { getAgentConfig, getMergedPresets } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { HybridInputBarHandle } from "./HybridInputBar";
const LazyHybridInputBar = lazy(() =>
  import("./HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);
import {
  getTerminalFocusTarget,
  isLikelyAtSynthesizedPointer,
  shouldShowHybridInputBar,
  shouldSuppressUnfocusedClick,
} from "./terminalFocus";
import { decideChromeAction } from "./multiSelectGestures";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { isPtyPanel } from "@shared/types/panel";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export type {};

export interface BannerSlotProps {
  visible: boolean;
  children: React.ReactNode;
}

/**
 * Wraps a banner so swaps between siblings of different heights interpolate
 * smoothly instead of jumping. Relies on `interpolate-size: allow-keywords`
 * (set on :root in src/index.css) for the `0 ↔ auto` height transition, and
 * caches the last visible children through the exit window so the collapse
 * has content to measure from.
 */
export function BannerSlot({ visible, children }: BannerSlotProps) {
  const [isVisible, setIsVisible] = useState(visible);
  const [renderChildren, setRenderChildren] = useState(visible);
  const [cachedChildren, setCachedChildren] = useState<React.ReactNode>(visible ? children : null);
  const exitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryFrameRef = useRef<number | null>(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setCachedChildren(children);
    }
  }, [visible, children]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (visible) {
      if (exitTimeoutRef.current !== null) {
        clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      setRenderChildren(true);
      setIsVisible(false);
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
      }
      entryFrameRef.current = requestAnimationFrame(() => {
        entryFrameRef.current = null;
        setIsVisible(true);
      });
      return;
    }

    if (entryFrameRef.current !== null) {
      cancelAnimationFrame(entryFrameRef.current);
      entryFrameRef.current = null;
    }
    setIsVisible(false);
    if (exitTimeoutRef.current !== null) {
      clearTimeout(exitTimeoutRef.current);
    }
    exitTimeoutRef.current = setTimeout(() => {
      exitTimeoutRef.current = null;
      setRenderChildren(false);
    }, BANNER_EXIT_DURATION);
  }, [visible]);

  useEffect(
    () => () => {
      if (exitTimeoutRef.current !== null) {
        clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
        entryFrameRef.current = null;
      }
    },
    []
  );

  if (!renderChildren) {
    return null;
  }

  return (
    <div
      className={cn(
        "banner-slot shrink-0 overflow-hidden transition-[height]",
        isVisible
          ? "h-auto ease-[var(--ease-snappy)]"
          : "h-0 ease-[var(--ease-exit)] pointer-events-none"
      )}
      style={{
        transitionDuration: `${isVisible ? BANNER_ENTER_DURATION : BANNER_EXIT_DURATION}ms`,
      }}
      aria-hidden={isVisible ? undefined : true}
    >
      {visible ? children : cachedChildren}
    </div>
  );
}

export function TerminalStartupPlaceholder({
  agentId,
  onCancel,
}: {
  agentId?: string;
  onCancel?: () => void;
}) {
  const agentName = agentId ? getAgentConfig(agentId)?.name : undefined;
  const label = agentName ? `Starting ${agentName}…` : "Starting terminal…";
  // Doherty gate: typical PTY spawns resolve well under the 400ms threshold,
  // so the common case is no spinner at all — only slow or queued spawns
  // surface one. Mirrors DevPreviewLoadingState.
  const showSpinner = useDohertyGate(true);

  return (
    <div className="relative flex flex-1 min-h-0 w-full flex-col items-center justify-center bg-daintree-bg px-4">
      <div
        className="flex max-w-[28ch] flex-col items-center gap-3 text-center"
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        <span className="sr-only">{label}</span>

        {/* Spinner + visible caption gated by the Doherty threshold. The
            caption is aria-hidden — the role=status wrapper above owns the AT
            announcement, and an aria-live here would be silenced by its
            aria-busy="true" anyway. The label also flows through the hint. */}
        {showSpinner && (
          <>
            <Spinner size="xl" className="text-daintree-text/45" />
            <p aria-hidden="true" className="text-sm text-daintree-text/60 break-words">
              {label}
            </p>
          </>
        )}
      </div>

      <SkeletonHint
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
        message={label}
        onCancel={onCancel}
      />
    </div>
  );
}

export interface ActivityState {
  headline: string;
  status: "working" | "waiting" | "success" | "failure";
  type: "interactive" | "background" | "idle";
}

export interface TerminalPaneProps {
  id: string;
  title: string;
  /** Launch hint — the agent this terminal was launched to run, if any. */
  agentId?: string;
  /** Runtime-detected agent identity (cleared on agent exit). Drives panel chrome (icons, badges). */
  detectedAgentId?: BuiltInAgentId;
  runtimeIdentity?: TerminalRuntimeIdentity;
  chrome?: TerminalChromeDescriptor;
  /** Sticky flag: has an agent ever been live-detected. Drives the chrome demotion rule. */
  everDetectedAgent?: boolean;
  agentPresetId?: string;
  presetColor?: string;
  worktreeId?: string;
  cwd: string;
  isFocused: boolean;
  isMaximized?: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  lastCommand?: string;
  flowStatus?: PersistableFlowStatus;
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  showRestoreControl?: boolean;
  location?: "grid" | "dock";
  restartKey?: number;
  restartError?: TerminalRestartError;
  reconnectError?: TerminalReconnectError;
  spawnError?: SpawnError;
  scrollbackRestoreError?: TerminalScrollbackRestoreError;
  isMultiPanelGrid?: boolean;
  detectedProcessId?: string;
  // Group-level ambient state: highest-urgency state across all tabs, for container border styling
  ambientAgentState?: AgentState;
  // Fleet scope render-time override: force-locks input without mutating the
  // stored TerminalInstance.isInputLocked flag.
  isInputLocked?: boolean;
  // Tab support
  tabs?: import("@/components/Panel/TabButton").TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

function TerminalPaneComponent({
  id,
  title,
  agentId,
  detectedAgentId,
  runtimeIdentity,
  chrome: chromeProp,
  everDetectedAgent,
  agentPresetId,
  presetColor,
  worktreeId,
  cwd,
  isFocused,
  isMaximized,
  agentState,
  activity,
  lastCommand,
  flowStatus,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
  location = "grid",
  restartKey = 0,
  restartError,
  reconnectError,
  spawnError,
  scrollbackRestoreError,
  isMultiPanelGrid = true,
  detectedProcessId,
  ambientAgentState,
  isInputLocked: isInputLockedOverride,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: TerminalPaneProps) {
  "use memo";
  const containerRef = useRef<HTMLDivElement>(null);
  const prevFocusedRef = useRef(isFocused);
  const [justFocusedUntil, setJustFocusedUntil] = useState(0);
  const inputBarRef = useRef<HybridInputBarHandle>(null);
  const [dismissedRestartPrompt, setDismissedRestartPrompt] = useState(false);
  // Separate from dismissedRestartPrompt so dismissing the lost-session
  // acknowledgement (issue #10823) never suppresses a later exit-error banner.
  const [dismissedSessionLost, setDismissedSessionLost] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateCwdOpen, setIsUpdateCwdOpen] = useState(false);
  const [isAutoRestarting, setIsAutoRestarting] = useState(false);
  const [completionBannerDismissed, setCompletionBannerDismissed] = useState(false);
  const autoRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestartAttemptRef = useRef(0);
  const processStartTimeRef = useRef<number>(0);
  const [inputTracker] = useState(() => new InputTracker());

  useEffect(() => {
    if (isFocused && !prevFocusedRef.current) {
      setJustFocusedUntil(performance.now() + 250);
    }
    prevFocusedRef.current = isFocused;
  }, [isFocused]);

  // Cancel pending auto-restart timer on unmount
  useEffect(() => {
    return () => {
      if (autoRestartTimerRef.current !== null) {
        clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setDismissedRestartPrompt(false);
    setDismissedSessionLost(false);
    inputTracker.reset();
    // Track process start time on each restart for backoff stability window
    processStartTimeRef.current = Date.now();
  }, [restartKey, inputTracker]);

  const updateVisibility = usePanelStore((state) => state.updateVisibility);
  const getTerminal = usePanelStore((state) => state.getTerminal);
  const restartTerminal = usePanelStore((state) => state.restartTerminal);
  const trashPanel = usePanelStore((state) => state.trashPanel);
  const setFocused = usePanelStore((state) => state.setFocused);
  const updateLastCommand = usePanelStore((state) => state.updateLastCommand);
  const addPanel = usePanelStore((state) => state.addPanel);
  const removePanel = usePanelStore((state) => state.removePanel);
  const backendStatus = usePanelStore((state) => state.backendStatus);
  const clearReconnectError = usePanelStore((state) => state.clearReconnectError);
  const clearScrollbackRestoreError = usePanelStore((state) => state.clearScrollbackRestoreError);

  const cliDetails = useCliAvailabilityStore((state) => state.details);
  const getPanelCliDetail = (): AgentCliDetail | undefined => {
    if (!agentId) return undefined;
    return cliDetails[agentId];
  };

  const handleRunAnyway = () => {
    const _panel = usePanelStore.getState().panelsById[id];
    if (!_panel || !agentId || !isPtyPanel(_panel)) return;
    const panel = _panel;

    const presetEnv = panel.extensionState?.presetEnv as Record<string, string> | undefined;

    removePanel(id);
    void addPanel({
      kind: "terminal",
      launchAgentId: agentId,
      command: panel.command,
      title: panel.title,
      cwd: panel.cwd ?? "",
      worktreeId: panel.worktreeId,
      location: panel.location as "grid" | "dock" | undefined,
      agentLaunchFlags: panel.agentLaunchFlags,
      agentModelId: panel.agentModelId,
      agentPresetId: panel.agentPresetId,
      env: presetEnv,
      // Carry the gate panel's persistence policy through the re-launch. Since
      // env is now persisted onto the panel (#10922), dropping these would let a
      // session-scoped secret (e.g. DAINTREE_MCP_TOKEN on a help session, which
      // launches excluded) leak into the on-disk snapshot on "Run anyway".
      excludeFromPersistence: panel.excludeFromPersistence,
      removeOnExit: panel.removeOnExit,
    });
  };

  // Fleet arming store for multi-select gestures. Selection treatment is
  // identical to focus: a pane is "selected" any time it's armed. A
  // single-armed pane lights up the same way as a focused unarmed pane,
  // so the visual rule is just "bright header = part of the active set".
  // The fleet ribbon (which only mounts at size>=2) tells the user when
  // typing actually broadcasts.
  const armedIds = useFleetArmingStore((state) => state.armedIds);
  const isArmed = armedIds.has(id);
  const isSelected = isArmed;
  // A "follower" is any armed pane that isn't currently the focused/origin
  // pane while the fleet is broadcasting (size >= 2). The follower stripe
  // is suppressed on a single-armed seed selection because nothing fans out
  // until a second pane joins.
  const isFleetFollower = isArmed && !isFocused && armedIds.size >= 2;
  const isFleetPrimary = isArmed && isFocused && armedIds.size >= 2;

  // Consolidate terminal state selectors to avoid multiple scans and ensure consistent snapshots
  const terminalState = usePanelStore(
    useShallow((state) => {
      const terminal = state.panelsById[id];
      const pty = terminal && isPtyPanel(terminal) ? terminal : undefined;
      return {
        isInputLocked: pty?.isInputLocked ?? false,
        stateChangeTrigger: pty?.stateChangeTrigger,
        isRestarting: pty?.isRestarting ?? false,
        exitBehavior: pty?.exitBehavior,
        isTrashedOrRemoved: terminal?.location === "trash" || terminal === undefined,
        spawnStatus: pty?.spawnStatus,
        eagerAttach: pty?.eagerAttach ?? false,
        sessionLostOnRestore: pty?.sessionLostOnRestore ?? false,
      };
    })
  );

  const {
    isInputLocked: storeInputLocked,
    stateChangeTrigger,
    isRestarting,
    exitBehavior,
    isTrashedOrRemoved,
    spawnStatus,
    eagerAttach,
    sessionLostOnRestore,
  } = terminalState;
  // Fleet-scope mounts pass `isInputLocked: true` to render the panel as a
  // read-only broadcast view. Prop takes precedence over the stored flag so
  // unwinding scope reverts to the user-toggled lock state automatically.
  const isInputLocked = isInputLockedOverride ?? storeInputLocked;

  const isBackendDisconnected = backendStatus === "disconnected";
  const isBackendRecovering = backendStatus === "recovering";

  const isHibernated = useIsHibernated(id);

  // Pre-audio confirmation cue. Subscribes to both fields so a target swap
  // mid-arming repaints the right pane on the next render.
  const isVoiceArming = useVoiceRecordingStore(
    (s) => s.status === "arming" && s.activeTarget?.panelId === id
  );

  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const preferredTerminalFocusTarget = usePanelStore((state) => state.preferredTerminalFocusTarget);
  const setPreferredTerminalFocusTarget = usePanelStore(
    (state) => state.setPreferredTerminalFocusTarget
  );
  // Panel kind is always "terminal" for PTY panels; live identity is runtime chrome.
  const kind = "terminal" as const;
  const queueCount = usePanelStore((state) => state.commandQueueCountById[id] ?? 0);
  // Live preset color — re-derives from settings whenever the user edits a preset's color
  const presetCustomPresets = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.customPresets : undefined
  );
  const presetCcrPresets = useCcrPresetsStore((s) =>
    agentId ? s.ccrPresetsByAgent[agentId] : undefined
  );
  const presetProjectPresets = useProjectPresetsStore((s) =>
    agentId ? s.presetsByAgent[agentId] : undefined
  );
  const livePresetColor = (() => {
    if (!agentPresetId || !agentId) return presetColor;
    const preset = getMergedPresets(
      agentId,
      presetCustomPresets,
      presetCcrPresets,
      presetProjectPresets
    ).find((f) => f.id === agentPresetId);
    return preset?.color ?? presetColor;
  })();
  const chrome =
    chromeProp && chromeProp.color === livePresetColor
      ? chromeProp
      : deriveTerminalChrome({
          kind,
          launchAgentId: agentId,
          runtimeIdentity,
          detectedAgentId,
          detectedProcessId,
          agentState,
          presetColor: livePresetColor,
        });
  const effectiveAgentId = isBuiltInAgentId(chrome.agentId) ? chrome.agentId : undefined;
  const showHybridInputBar = shouldShowHybridInputBar({
    hasAgentIdentity: effectiveAgentId !== undefined,
    hybridInputEnabled,
    isFleetArmed: isArmed,
    fleetSize: armedIds.size,
  });

  const pingedIdSelector = (state: ReturnType<typeof usePanelStore.getState>) =>
    state.pingedId === id;
  const isPinged = usePanelStore(pingedIdSelector);
  const wasJustSelected = isPinged && isFocused && performance.now() < justFocusedUntil;

  const terminalErrors = useErrorStore(
    useShallow((state) => state.errors.filter((e) => e.context?.terminalId === id && !e.dismissed))
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);
  const clearRetryProgress = useErrorStore((state) => state.clearRetryProgress);

  const handleCancelRetry = (errorId: string) => {
    errorsClient.cancelRetry(errorId);
    clearRetryProgress(errorId);
  };

  const { isExited, exitCode, handleExit, handleErrorRetry } = useTerminalLogic({
    id,
    removeError,
    restartKey,
  });

  const { showBanner: showForceResumeStall, resetQueue: resetForceResumeQueue } =
    useForceResumeCycleWatchdog(id);

  const {
    cancel: cancelInjection,
    isInjecting,
    isPendingInjection,
    injectionStatus,
    progress: injectionProgress,
  } = useContextInjection(id);
  // Single gate across waiting → injecting so the banner doesn't flicker on
  // the phase transition; fast injections (<400ms) show nothing.
  const showInjectionBanner = useDohertyGate(isInjecting || isPendingInjection);

  // Cancel auto-restart if terminal is intentionally trashed/removed
  useEffect(() => {
    if (isTrashedOrRemoved && autoRestartTimerRef.current !== null) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
      setIsAutoRestarting(false);
    }
  }, [isTrashedOrRemoved]);

  // Auto-restart logic: when exitBehavior === "restart" and terminal exits (any code except 130).
  // The scheduling body reads non-reactive values (id, restartTerminal, refs) and is wrapped
  // in useEffectEvent so the React Compiler can memoize this component.
  const scheduleAutoRestart = useEffectEvent(() => {
    if (autoRestartTimerRef.current !== null) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }

    // Reset backoff if process ran stably for > 10s
    const runDuration =
      processStartTimeRef.current > 0 ? Date.now() - processStartTimeRef.current : 0;
    if (runDuration > 10_000) {
      autoRestartAttemptRef.current = 0;
    }

    const attempt = autoRestartAttemptRef.current;
    // Exponential backoff: 250ms, 500ms, 1s, 2s, 4s, capped at 5s
    const delay = Math.min(250 * Math.pow(2, attempt), 5_000);
    autoRestartAttemptRef.current = attempt + 1;

    setIsAutoRestarting(true);

    autoRestartTimerRef.current = setTimeout(() => {
      autoRestartTimerRef.current = null;
      const currentTerminal = usePanelStore.getState().panelsById[id];
      if (!currentTerminal || currentTerminal.location === "trash") {
        setIsAutoRestarting(false);
        return;
      }
      restartTerminal(id);
      setIsAutoRestarting(false);
    }, delay);
  });

  useEffect(() => {
    if (!isExited) return;
    if (exitBehavior !== "restart") return;
    if (exitCode === 130) return;
    if (isTrashedOrRemoved) return;
    if (isRestarting) return;

    scheduleAutoRestart();

    return () => {
      if (autoRestartTimerRef.current !== null) {
        clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
        setIsAutoRestarting(false);
      }
    };
  }, [isExited, exitBehavior, exitCode, isTrashedOrRemoved, isRestarting]);

  // Track drag state in a ref to avoid useEffect cleanup timing issues.
  // If isDragging is in the dependency array, cleanup runs on drag START
  // with the OLD isDragging=false value, which would set visibility to false!
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // Root the visibility observer at the panel grid's scroll container when this
  // pane is mounted inside the scrollable grid (#8805). Panes outside the grid
  // (dock, popout, two-pane split) fall back to the viewport root via a null
  // context value, which is the correct default for those surfaces.
  const gridScrollRoot = useGridScrollRoot();

  // Visibility observation - stable observer, ref-gated callback.
  // Capture attach generation so stale IntersectionObserver callbacks from a
  // previous mount site don't hide a terminal that has already been re-attached.
  useEffect(() => {
    if (!containerRef.current) return;

    const gen = terminalInstanceService.getAttachGeneration(id);

    const observer = new IntersectionObserver(
      (entries) => {
        // Under load a single callback can batch multiple entries for the same
        // element; only the most recent reading reflects current geometry.
        const entry = entries[entries.length - 1];

        // Don't update visibility during drag - CSS transforms cause false negatives
        if (isDraggingRef.current || !entry) return;

        // Suppress stale `false` readings that would freeze a visible terminal
        // at the BACKGROUND tier (#9780). Confirm against fresh element and root
        // geometry, read before any write to avoid a redundant layout reflow.
        if (
          isStaleHiddenReading(
            entry,
            () => containerRef.current?.getBoundingClientRect(),
            () =>
              gridScrollRoot?.getBoundingClientRect() ??
              new DOMRect(0, 0, window.innerWidth, window.innerHeight)
          )
        )
          return;

        // A callback queued from a previous mount site (warm-swap reattach)
        // must not write at all. setVisible already drops it via its
        // generation guard — dropping the store write under the same
        // condition keeps store and service from diverging permanently
        // (#10416).
        if (terminalInstanceService.getAttachGeneration(id) !== gen) return;

        updateVisibility(id, entry.isIntersecting);
        terminalInstanceService.setVisible(id, entry.isIntersecting, gen);
      },
      {
        // Grid-scoped root: when mounted inside the grid, the pre-warm margin
        // upgrades panels that are one comfortable row away from the viewport
        // from BACKGROUND → VISIBLE before they paint. Sized to the comfortable
        // row height so the pre-warm fires a full row ahead now that rows no
        // longer shrink to the minimum. Outside the grid we fall back to the
        // document viewport with no margin.
        root: gridScrollRoot ?? null,
        rootMargin: gridScrollRoot ? `${COMFORTABLE_PANEL_HEIGHT_PX}px 0px` : "0px",
        threshold: 0.1,
      }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [id, restartKey, updateVisibility, gridScrollRoot]);

  // Separate unmount cleanup — only update store visibility.
  // The service-level setVisible(false) is handled by XtermAdapter's own
  // useLayoutEffect cleanup, which has the correct attachGeneration guard.
  // Calling it here too is redundant and breaks in React StrictMode (dev),
  // where the effect's cleanup captures the same generation as the active
  // mount, bypassing the stale-generation guard and hiding the terminal.
  useUnmountVisibilityCleanup(id, restartKey, updateVisibility);

  const handleReady = useCallback(() => {}, []);

  const handleInput = useCallback(
    (data: string) => {
      const results = inputTracker.process(data);

      for (const result of results) {
        if (result.isClear) {
          const managed = terminalInstanceService.get(id);
          if (managed?.terminal) {
            try {
              managed.terminal.clear();
            } catch (error) {
              console.warn(`Failed to clear terminal ${id}:`, error);
            }
          }
        }

        if (result.command) {
          updateLastCommand(id, result.command);
        }
      }
    },
    [id, inputTracker, updateLastCommand]
  );

  useEffect(() => {
    const handleFindInPanel = () => {
      if (!isFocused) return;
      setIsSearchOpen(true);
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>("[data-terminal-search-input]")?.focus();
      });
    };

    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    return () => window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
  }, [isFocused]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Cmd+C to copy xterm selection regardless of which child has focus.
    // This is needed because agent terminals focus the hybrid input bar, so
    // xterm's built-in copy handler never receives the copy event.
    if (e.metaKey && e.key === "c") {
      const managed = terminalInstanceService.get(id);
      if (managed?.terminal.hasSelection()) {
        const nativeSelection = window.getSelection()?.toString() ?? "";
        if (nativeSelection.length === 0) {
          e.preventDefault();
          void navigator.clipboard.writeText(managed.terminal.getSelection());
          return;
        }
      }
    }

    const target = e.target as HTMLElement;

    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      return;
    }

    if (target.tagName === "BUTTON" || target !== e.currentTarget) {
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setFocused(id);
    }
  };

  const getRefreshTierCallback = useCallback(() => {
    const terminal = getTerminal(id);
    return getTerminalRefreshTier(terminal, isFocused, {
      isFleetArmed: isArmed,
    });
  }, [getTerminal, id, isArmed, isFocused]);

  const handleClick = (e?: React.MouseEvent) => {
    const target = e?.target as HTMLElement | null;
    const isBufferClick = !!target?.closest(".xterm");
    const managed = terminalInstanceService.get(id);
    if (isBufferClick && managed?.terminal.hasSelection()) {
      // Prevent ContentPanel from calling onFocus() which triggers parent
      // re-renders. Don't call setFocused() either — it triggers a
      // wake+restore cycle that calls terminal.reset(), clearing selection.
      // Scoped to buffer clicks: a click on pane chrome (e.g. the title)
      // must not be swallowed just because xterm has a leftover selection.
      e?.preventDefault();
      return;
    }

    // Chrome-level multi-select gestures only fire when the click
    // originates inside pane chrome (the title bar) AND not on an
    // interactive child of the chrome (overflow menu, close, restore,
    // title input, etc). Without the interactive guard, clicking the
    // overflow trigger of a pane while a fleet is armed would clear
    // the fleet before the menu opens. The passthrough whitelist lets
    // specific chrome elements (title span carries role="button" for
    // a11y) participate in fleet gestures without losing their a11y role.
    const isChromeClick = !!target?.closest("[data-pane-chrome]");
    const isPassthrough = !!target?.closest("[data-fleet-gesture-passthrough]");
    const isInteractiveChild =
      !isPassthrough &&
      !!target?.closest("button, input, textarea, select, a, [role='button'], [role='menuitem']");

    if (e && isChromeClick && !isInteractiveChild) {
      const terminal = getTerminal(id);
      const isEligible = !!(terminal && isFleetArmEligible(terminal));
      const armingStore = useFleetArmingStore.getState();
      const action = decideChromeAction(
        { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
        {
          isEligible,
          isArmed: armingStore.armedIds.has(id),
          armedSize: armingStore.armedIds.size,
        }
      );

      if (action.type === "toggle") {
        // Empty fleet + shift/cmd-click on an unarmed pane: the focused
        // pane is the implicit "first member" so the user ends up with
        // a 2-pane fleet rather than a lonely toggled pane. Mirrors the
        // mental model of "I have one selected, now add another".
        if (armingStore.armedIds.size === 0 && !armingStore.armedIds.has(id)) {
          const focusedId = usePanelStore.getState().focusedId;
          if (focusedId && focusedId !== id) {
            const focusedTerminal = usePanelStore.getState().panelsById[focusedId];
            if (focusedTerminal && isFleetArmEligible(focusedTerminal)) {
              armingStore.armId(focusedId);
            }
          }
        }
        armingStore.toggleId(id);
        e.preventDefault();
        return;
      }
      if (action.type === "clear") {
        armingStore.clear();
        // fall through — setFocused below makes the clicked pane the
        // new exclusive selection.
      }
    }

    setFocused(id);
  };

  // Timestamp of the last pointermove over the xterm wrapper, used to tell a
  // physical click (preceded by movement) from an AT-synthesized routing event
  // (a bare pointerdown). Uses the event `timeStamp` clock for monotonicity.
  const lastXtermPointerMoveAtRef = useRef<number | null>(null);

  const handleXtermPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    lastXtermPointerMoveAtRef.current = e.timeStamp;
  };

  const handleXtermPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    const xtermElement = target?.closest(".xterm");
    if (!xtermElement) return;

    // A bare pointerdown with no recent pointermove is likely screen reader
    // cursor routing (VoiceOver/NVDA), not a physical click. AT routing events
    // are indistinguishable from real clicks by their properties, so we infer
    // it from the absence of preceding movement.
    const isAtSynthesized = isLikelyAtSynthesizedPointer(
      lastXtermPointerMoveAtRef.current,
      e.timeStamp
    );

    // A physical click on xterm is an explicit "I want the terminal" gesture —
    // record it so subsequent Cmd-Opt-Arrow navigation stays on xterm across
    // panes. Skip for AT routing so a screen reader reaching terminal output
    // doesn't silently clobber the user's hybrid-input focus preference.
    if (!isAtSynthesized) {
      setPreferredTerminalFocusTarget("xterm");
    }

    const shouldSuppress = shouldSuppressUnfocusedClick({
      location,
      isFocused,
      isCursorPointer: xtermElement.classList.contains("xterm-cursor-pointer"),
      isShiftKey: e.shiftKey,
    });

    if (!shouldSuppress) {
      // Already-focused panes: let the click through so xterm selection,
      // cursor positioning, and mouse reporting work natively. The xterm
      // focus listener (TerminalInstanceService) records the focus event.
      return;
    }

    if (isAtSynthesized) {
      // Activate the pane but let the event reach xterm — preventDefault /
      // stopPropagation / setPointerCapture would swallow the routing event and
      // break cursor positioning for screen reader users.
      setFocused(id);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Capture the pointer so follow-on pointermove/pointerup events route to
    // this wrapper instead of xterm's canvas. Without this, suppressing only
    // pointerdown still lets drag motion leak into PTY mouse-reporting modes
    // (DECSET 1002/1003) as escape sequences.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Element was detached (e.g. LRU view eviction). Safe to ignore.
    }

    setFocused(id);
    requestAnimationFrame(() => terminalInstanceService.focus(id));
  };

  const handleXtermPointerNoop = () => {};

  const handleRestart = () => {
    restartTerminal(id);
    inputTracker.reset();
  };

  const handleUpdateCwd = () => {
    setIsUpdateCwdOpen(true);
  };

  const handleTrash = () => {
    trashPanel(id);
  };

  const handleDismissReconnectError = () => {
    clearReconnectError(id);
  };

  const handleDismissScrollbackRestoreError = () => {
    clearScrollbackRestoreError(id);
  };

  useEffect(() => {
    terminalInstanceService.setFocused(id, isFocused);

    if (!isFocused) return;

    const focusTarget = getTerminalFocusTarget({
      preferredTarget: preferredTerminalFocusTarget,
      hasHybridInputSurface: showHybridInputBar,
      isInputDisabled: isBackendDisconnected || isBackendRecovering || isInputLocked,
      hybridInputEnabled,
    });

    if (focusTarget === "hybridInput") {
      // xterm v6 clears selection on blur, so read selection state
      // synchronously here — before any focus handoff. Don't steal focus from
      // xterm when the user has an active text selection. Checking up front
      // (rather than inside a deferred double-RAF) also avoids focus briefly
      // landing on the ContentPanel container, which made screen readers
      // announce the container instead of the input bar. A RAF then defers the
      // handoff until the pane has painted; focus never lands on the container.
      const managed = terminalInstanceService.get(id);
      if (managed?.terminal.hasSelection()) return;

      const rafId = requestAnimationFrame(() => {
        inputBarRef.current?.focusWithCursorAtEnd();
      });
      return () => {
        cancelAnimationFrame(rafId);
        inputBarRef.current?.cancelPendingFocus();
      };
    }

    const rafId = requestAnimationFrame(() => terminalInstanceService.focus(id));
    return () => cancelAnimationFrame(rafId);
  }, [
    id,
    isFocused,
    showHybridInputBar,
    hybridInputEnabled,
    preferredTerminalFocusTarget,
    isBackendDisconnected,
    isBackendRecovering,
    isInputLocked,
  ]);

  useEffect(() => {
    // The registry is invoked on tab switches inside a focused tab group —
    // the destination tab needs focus routed to whichever sub-target the
    // user is currently using. Honor the preference rather than always
    // forcing the input; that's what the old model did, and tab switching
    // would otherwise yank focus out of xterm against the user's intent.
    return registerPanelFocusHandler(id, () => {
      const focusTarget = getTerminalFocusTarget({
        preferredTarget: usePanelStore.getState().preferredTerminalFocusTarget,
        hasHybridInputSurface: showHybridInputBar,
        isInputDisabled: isBackendDisconnected || isBackendRecovering || isInputLocked,
        hybridInputEnabled,
      });
      if (focusTarget === "hybridInput" && inputBarRef.current) {
        inputBarRef.current.focusWithCursorAtEnd();
        return true;
      }
      // No live xterm means nothing can take focus — report the miss so callers
      // (macro-grid Enter) keep their own focus rather than handing off to a
      // pane that cannot receive it.
      if (!terminalInstanceService.get(id)) return false;
      terminalInstanceService.focus(id);
      return true;
    });
  }, [
    id,
    showHybridInputBar,
    isBackendDisconnected,
    isBackendRecovering,
    isInputLocked,
    hybridInputEnabled,
  ]);

  // Sync agent state to terminal service for scroll management
  useEffect(() => {
    terminalInstanceService.setAgentState(id, agentState ?? "idle");
  }, [id, agentState]);

  // Per-pane dismiss state resets when the agent leaves the completed phase —
  // a rerun should re-arm the banner from scratch.
  useEffect(() => {
    if (agentState !== "completed") {
      setCompletionBannerDismissed(false);
    }
  }, [agentState]);

  // The current worktree's changed-file count drives the review strip and
  // the zero-change pill. We prefer the explicit `worktreeId` prop (matches
  // `worktree.id` in WorktreeCard) over `cwd` so a user-initiated `cd` away
  // from the worktree root doesn't break the lookup.
  const reviewWorktreeId = worktreeId ?? cwd;
  const changedFileCount = useWorktreeStore((s) =>
    reviewWorktreeId
      ? (s.worktrees.get(reviewWorktreeId)?.worktreeChanges?.changedFileCount ?? 0)
      : 0
  );

  const completedWithChanges = agentState === "completed" && changedFileCount > 0;
  const completedWithNoChanges = agentState === "completed" && changedFileCount === 0;

  // All "open Review Hub" entry points (banner button, menu, header) flow
  // through this event so any open path auto-dismisses sibling banners for
  // the same worktree. WorktreeCard listens for the same event to open the
  // hub itself.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ worktreeId?: string }>).detail;
      if (detail?.worktreeId === reviewWorktreeId) {
        setCompletionBannerDismissed(true);
      }
    };
    window.addEventListener("daintree:open-review-hub", handler);
    return () => window.removeEventListener("daintree:open-review-hub", handler);
  }, [reviewWorktreeId]);

  const handleOpenReviewHub = () => {
    if (reviewWorktreeId) {
      window.dispatchEvent(
        new CustomEvent("daintree:open-review-hub", { detail: { worktreeId: reviewWorktreeId } })
      );
    }
  };

  // "Send to assistant" relays this agent's completion output into the active
  // assistant session. It's only offered when the assistant terminal exists
  // and is idle/waiting — writing into a working or directing agent would
  // corrupt its input mid-stream.
  const helpTerminalId = useHelpPanelStore((s) => s.terminalId);
  const helpAgentState = usePanelStore((s) => {
    if (!helpTerminalId) return undefined;
    const p = s.panelsById[helpTerminalId];
    return p && isPtyPanel(p) ? p.agentState : undefined;
  });
  const helpInputLocked = usePanelStore((s) => {
    if (!helpTerminalId) return false;
    const p = s.panelsById[helpTerminalId];
    return p && isPtyPanel(p) ? p.isInputLocked === true : false;
  });
  const assistantAvailable =
    !!helpTerminalId &&
    helpTerminalId !== id &&
    !helpInputLocked &&
    (helpAgentState === "idle" || helpAgentState === "waiting");

  // The "Send to agent" palette has nothing to offer when this is the only
  // eligible PTY pane — hide it rather than render a button that no-ops.
  // Short-circuit on agentState: the result only gates the completion
  // banner's button, so idle/working panes skip the O(N) scan per store write.
  const hasAgentTargets = usePanelStore(
    (s) =>
      agentState === "completed" &&
      s.panelIds.some((tid) => {
        const t = s.panelsById[tid];
        return (
          !!t &&
          t.id !== id &&
          t.location !== "trash" &&
          t.location !== "background" &&
          t.location !== "overlay" &&
          (t.kind ? panelKindHasPty(t.kind) : true) &&
          (!isPtyPanel(t) || t.hasPty !== false)
        );
      })
  );

  const handleSendToAssistant = useCallback(() => {
    const help = useHelpPanelStore.getState();
    const helpTid = help.terminalId;
    if (!helpTid || helpTid === id) return;
    const state = terminalInstanceService.getAgentState(helpTid);
    if (state !== "idle" && state !== "waiting") return;
    const _helpPanel = usePanelStore.getState().panelsById[helpTid];
    if (_helpPanel && isPtyPanel(_helpPanel) && _helpPanel.isInputLocked === true) return;
    const text = terminalInstanceService.captureBufferText(id, 20000);
    if (!text) return;

    const managed = terminalInstanceService.get(helpTid);
    if (managed && !managed.terminal.modes.bracketedPasteMode) {
      terminalClient.write(helpTid, text.replace(/\r?\n/g, "\r"));
    } else {
      terminalClient.write(helpTid, formatWithBracketedPaste(text));
    }
    terminalInstanceService.notifyUserInput(helpTid);
    help.setOpen(true);
    help.requestFocus();
  }, [id]);

  const handleSendToAgent = useCallback(() => {
    const text = terminalInstanceService.captureBufferText(id, 20000);
    if (!text) return;
    openSendToAgentPaletteWithText(text, id);
  }, [id]);

  const isWorking = agentState === "working";
  const allowPing = !isMaximized && (location !== "grid" || isMultiPanelGrid);

  const agentHeaderActions = (() => {
    if (!effectiveAgentId) return undefined;
    const agentConfig = getAgentConfig(effectiveAgentId);
    const agentName = agentConfig?.name ?? effectiveAgentId;
    return (
      <DropdownMenuItem
        onSelect={() =>
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "agents", subtab: effectiveAgentId },
            { source: "user" }
          )
        }
      >
        <Settings className="w-3 h-3 mr-2" />
        {agentName} Settings
      </DropdownMenuItem>
    );
  })();

  const restartBannerVariant = getRestartBannerVariant({
    isExited,
    exitCode,
    dismissedRestartPrompt,
    restartError,
    isRestarting,
    isAutoRestarting,
    exitBehavior,
    reconnectError,
    spawnError,
    backendStatus,
    sessionLostOnRestore,
    dismissedSessionLost,
  });
  // Backend-dependent banners (restart / spawn / reconnect) describe failures
  // whose only recovery path runs through the host, so they're hidden while
  // any global recovery cause is active. The parse-error category covers
  // scrollback-restore failures, which are independent of host connectivity
  // (terminal still works) and stay visible during a backend flap.
  const suppressBackendDependent = useShouldSuppressLocalError("backend-dependent");
  const suppressParseError = useShouldSuppressLocalError("parse-error");
  const showRestartError = !suppressBackendDependent && Boolean(restartError);
  const showSpawnError = !suppressBackendDependent && Boolean(spawnError) && !restartError;
  const showReconnectError =
    !suppressBackendDependent && Boolean(reconnectError) && !restartError && !spawnError;
  // Scrollback restore is independent of PTY launch state (spawn/reconnect),
  // so it can co-exist with those banners. Only restartError, which already
  // implies a destroyed-and-respawning PTY, suppresses it.
  const showScrollbackRestoreError =
    !suppressParseError && Boolean(scrollbackRestoreError) && !restartError;
  const showRestartStatus = restartBannerVariant.type !== "none";

  return (
    <ContentPanel
      ref={containerRef}
      id={id}
      title={title}
      kind={kind}
      agentId={agentId}
      detectedAgentId={detectedAgentId}
      runtimeIdentity={runtimeIdentity}
      chrome={chrome}
      everDetectedAgent={everDetectedAgent}
      presetColor={livePresetColor}
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      showRestoreControl={showRestoreControl}
      headerActions={agentHeaderActions}
      onRestart={handleRestart}
      isExited={isExited}
      exitCode={exitCode}
      isWorking={isWorking}
      agentState={agentState}
      completedWithNoChanges={completedWithNoChanges}
      activity={activity}
      lastCommand={lastCommand}
      detectedProcessId={detectedProcessId}
      queueCount={queueCount}
      flowStatus={flowStatus}
      isPinged={isPinged}
      wasJustSelected={wasJustSelected}
      ambientAgentState={ambientAgentState}
      isSelected={isSelected}
      isFleetFollower={isFleetFollower}
      isHibernated={isHibernated}
      isVoiceArming={isVoiceArming}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
      className={cn(
        "terminal-pane",
        isExited && "opacity-75 grayscale",
        isPinged &&
          allowPing &&
          (wasJustSelected ? "animate-terminal-ping-select" : "animate-terminal-ping")
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="group"
      data-armed={isArmed || undefined}
      aria-label={(() => {
        const armedSuffix = isArmed ? " (armed)" : "";
        if (!effectiveAgentId) {
          return `Terminal: ${title}${armedSuffix}`;
        }
        const agentConfig = getAgentConfig(effectiveAgentId);
        if (agentConfig) {
          return `${agentConfig.name} agent: ${title}${armedSuffix}`;
        }
        return `${effectiveAgentId} session: ${title}${armedSuffix}`;
      })()}
    >
      {terminalErrors.length > 0 && (
        <div className="px-2 py-1 border-b border-daintree-border bg-[color-mix(in_oklab,var(--color-status-error)_5%,transparent)] space-y-1 shrink-0">
          {terminalErrors.slice(0, 2).map((error) => (
            <ErrorBanner
              key={error.id}
              error={error}
              onDismiss={dismissError}
              onRetry={handleErrorRetry}
              onCancelRetry={handleCancelRetry}
              compact
            />
          ))}
          {terminalErrors.length > 2 && (
            <div className="text-xs text-daintree-text/40 px-2">
              +{terminalErrors.length - 2} more errors
            </div>
          )}
        </div>
      )}

      <BannerSlot visible={showRestartError}>
        {restartError && (
          <TerminalErrorBanner
            terminalId={id}
            error={restartError}
            onUpdateCwd={handleUpdateCwd}
            onRetry={handleRestart}
            onTrash={handleTrash}
            isRestarting={isRestarting}
          />
        )}
      </BannerSlot>

      <BannerSlot visible={showSpawnError}>
        {spawnError && (
          <SpawnErrorBanner
            terminalId={id}
            error={spawnError}
            cwd={cwd}
            onUpdateCwd={handleUpdateCwd}
            onRetry={handleRestart}
            onTrash={handleTrash}
            isRestarting={isRestarting}
          />
        )}
      </BannerSlot>

      <BannerSlot visible={showReconnectError}>
        {reconnectError && (
          <ReconnectErrorBanner
            terminalId={id}
            error={reconnectError}
            onDismiss={handleDismissReconnectError}
            onRestart={handleRestart}
            isRestarting={isRestarting}
          />
        )}
      </BannerSlot>

      <BannerSlot visible={showScrollbackRestoreError}>
        {scrollbackRestoreError && (
          <ScrollbackRestoreErrorBanner
            terminalId={id}
            error={scrollbackRestoreError}
            onDismiss={handleDismissScrollbackRestoreError}
            onRestart={handleRestart}
            isRestarting={isRestarting}
          />
        )}
      </BannerSlot>

      <BannerSlot visible={showRestartStatus}>
        <TerminalRestartStatusBanner
          variant={restartBannerVariant}
          onRestart={handleRestart}
          onDismiss={() =>
            restartBannerVariant.type === "session-resume-unavailable"
              ? setDismissedSessionLost(true)
              : setDismissedRestartPrompt(true)
          }
        />
      </BannerSlot>

      <BannerSlot visible={!suppressBackendDependent && showForceResumeStall}>
        <InlineStatusBanner
          icon={OctagonAlert}
          severity="error"
          title="Terminal output stalled"
          description="Output keeps backing up faster than it can render. Reset the queue to recover."
          action={{
            id: "reset-force-resume-queue",
            label: "Reset queue",
            icon: RotateCcw,
            onClick: resetForceResumeQueue,
          }}
        />
      </BannerSlot>

      <BannerSlot visible={showInjectionBanner}>
        <InlineStatusBanner
          icon={injectionStatus === "waiting" ? Hourglass : Folders}
          severity={injectionStatus === "waiting" ? "neutral" : "info"}
          title={injectionStatus === "waiting" ? "Waiting for agent" : "Injecting context"}
          description={
            injectionStatus === "waiting" ? "Context will inject when the agent is idle" : undefined
          }
          contextLine={injectionStatus === "injecting" ? injectionProgress?.message : undefined}
          role="status"
          ariaLive="polite"
          action={{
            id: "cancel-context-injection",
            label: "Cancel",
            onClick: cancelInjection,
          }}
          descriptionExtras={
            injectionStatus === "injecting" ? (
              <div className="mt-1.5 h-0.5 w-full rounded bg-daintree-border/60">
                <div
                  className="h-full rounded bg-status-info/60 transition-[width] duration-150 ease-out"
                  style={{
                    width: `${Math.min(Math.max((injectionProgress?.progress ?? 0) * 100, 0), 100)}%`,
                  }}
                />
              </div>
            ) : undefined
          }
        />
      </BannerSlot>

      <div className="flex-1 min-h-0 bg-daintree-bg flex flex-col">
        {spawnStatus === "missing-cli" && agentId ? (
          <MissingCliGate
            agentId={agentId}
            detail={getPanelCliDetail() ?? { state: "missing", resolvedPath: null, via: null }}
            onRunAnyway={handleRunAnyway}
          />
        ) : spawnStatus === "spawning" && !eagerAttach ? (
          <TerminalStartupPlaceholder agentId={agentId} onCancel={() => onClose()} />
        ) : spawnStatus === "failed" ? (
          <div className="flex-1 min-h-0 bg-daintree-bg flex items-center justify-center">
            <p className="text-sm text-daintree-text/50">Terminal failed to start</p>
          </div>
        ) : (
          <>
            <div className="flex-1 relative min-h-0">
              <div
                className={cn(
                  "absolute inset-0",
                  (isBackendDisconnected || isBackendRecovering) && "pointer-events-none opacity-50"
                )}
                onPointerDownCapture={handleXtermPointerDownCapture}
                onPointerMove={handleXtermPointerMove}
                onPointerUp={handleXtermPointerNoop}
              >
                <Suspense fallback={null}>
                  <XtermAdapter
                    key={`${id}-${restartKey}`}
                    terminalId={id}
                    launchAgentId={agentId}
                    detectedAgentId={detectedAgentId}
                    isInputLocked={isInputLocked}
                    onReady={handleReady}
                    onExit={handleExit}
                    onInput={handleInput}
                    className="absolute inset-0"
                    getRefreshTier={getRefreshTierCallback}
                    cwd={cwd}
                    hasBottomBar={showHybridInputBar}
                  />
                </Suspense>
                <ArtifactOverlay terminalId={id} worktreeId={worktreeId} cwd={cwd} />
                {isSearchOpen && (
                  <TerminalSearchBar
                    terminalId={id}
                    onClose={() => {
                      setIsSearchOpen(false);
                      // Restore focus to whichever sub-target the user is
                      // currently using — read at RAF time (not from the
                      // render closure) so a same-frame preference flip
                      // between onClose and the focus call is honored.
                      requestAnimationFrame(() => {
                        const focusTarget = getTerminalFocusTarget({
                          preferredTarget: usePanelStore.getState().preferredTerminalFocusTarget,
                          hasHybridInputSurface: showHybridInputBar,
                          isInputDisabled:
                            isBackendDisconnected || isBackendRecovering || isInputLocked,
                          hybridInputEnabled,
                        });
                        if (focusTarget === "hybridInput") {
                          inputBarRef.current?.focusWithCursorAtEnd();
                        } else {
                          terminalInstanceService.focus(id);
                        }
                      });
                    }}
                  />
                )}
              </div>

              <TerminalScrollIndicator terminalId={id} />

              {isFleetPrimary && (
                <div className="absolute inset-0 z-30 pointer-events-none flex items-end justify-start pb-1.5 pl-[14px]">
                  <div className="pointer-events-auto">
                    <FleetDraftingPill />
                  </div>
                </div>
              )}

              {(isBackendDisconnected || isBackendRecovering) && (
                <div
                  className="absolute inset-0 z-50 flex items-center justify-center bg-scrim-strong backdrop-blur-sm"
                  aria-hidden={isBackendDisconnected ? "true" : undefined}
                  role={isBackendRecovering ? "status" : undefined}
                  aria-live={isBackendRecovering ? "polite" : undefined}
                >
                  {isBackendRecovering && (
                    <div className="flex flex-col items-center gap-3">
                      <Spinner size="2xl" className="text-status-warning" />
                      <span className="text-text-inverse font-medium">Reconnecting...</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {completedWithChanges && !completionBannerDismissed && (
              <AgentCompletionBanner
                fileCount={changedFileCount}
                onReview={handleOpenReviewHub}
                onDismiss={() => setCompletionBannerDismissed(true)}
                onSendToAssistant={assistantAvailable ? handleSendToAssistant : undefined}
                onSendToAgent={hasAgentTargets ? handleSendToAgent : undefined}
              />
            )}

            {showHybridInputBar && (
              <Suspense fallback={null}>
                <LazyHybridInputBar
                  ref={inputBarRef}
                  terminalId={id}
                  disabled={
                    isBackendDisconnected || isBackendRecovering || isInputLocked || isRestarting
                  }
                  cwd={cwd}
                  agentId={effectiveAgentId}
                  agentHasLifecycleEvent={stateChangeTrigger !== undefined}
                  agentState={agentState}
                  restartKey={restartKey}
                  onActivate={handleClick}
                  onSend={({ trackerData, text }) => {
                    if (!isInputLocked && !isRestarting) {
                      terminalInstanceService.notifyUserInput(id);
                      // submit now rejects when the PTY is gone (#8706); the
                      // single-pane path has no recovery UI for that, so
                      // swallow to log instead of leaking an unhandled
                      // rejection. Banners/agent-state surface the dead pane.
                      terminalClient.submit(id, text).catch((err) => {
                        logWarn("[TerminalPane] submit failed", { id, error: err });
                      });
                      handleInput(trackerData);
                    }
                  }}
                  onSendKey={(key) => {
                    if (!isInputLocked && !isRestarting) {
                      terminalInstanceService.notifyUserInput(id);
                      terminalClient.sendKey(id, key);
                    }
                  }}
                />
              </Suspense>
            )}
          </>
        )}
      </div>

      <UpdateCwdDialog
        isOpen={isUpdateCwdOpen}
        terminalId={id}
        currentCwd={cwd}
        onClose={() => setIsUpdateCwdOpen(false)}
      />
    </ContentPanel>
  );
}

export const TerminalPane = TerminalPaneComponent;
