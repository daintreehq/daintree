import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "../../types";
import type { Issue } from "@shared/types/forge";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";

import { useDroppable } from "@dnd-kit/core";
import { useBuiltInSidebarViewHidden } from "@/components/Sidebar/sidebarViewContext";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import type { WorktreeDragData } from "../DragDrop/DndProvider";
import { useDndPlaceholder, useIsWorktreeSortDragging } from "../DragDrop/dndPlaceholderContext";
import { getWorktreeSortDragId } from "../DragDrop/SortableWorktreeCard";
import { isPanelDragMovableToWorktree } from "../DragDrop/dropResolution";
import { GripVertical } from "lucide-react";
import { CheckboxGlyph } from "@/components/ui/checkbox";
import { useErrorStore, usePanelStore, type RetryAction } from "../../store";
import { isDevPreviewPanel, type PtyPanelData } from "@shared/types/panel";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import { suppressShiftClickTextSelection } from "@/utils/shiftClickSelection";
import {
  useProjectSettingsStore,
  areProjectNotificationsMuted,
} from "../../store/projectSettingsStore";
import { useWorktreeFilterStore } from "../../store/worktreeFilterStore";
import {
  worktreeLabelDisplayName,
  WORKTREE_LABEL_COLORS,
  type WorktreeLabelToken,
} from "@shared/theme/worktreeColors";
import { worktreeLabelColorStyle } from "./worktreeLabelColorStyle";
import { errorsClient, worktreeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { notify } from "@/lib/notify";
import { humanizeAppError } from "@shared/utils/errorMessage";
import { getGitRecoveryAction } from "@shared/utils/gitOperationErrors";
import { isClientGitError } from "@/utils/clientGitError";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { exitProjectHome } from "@/store/storeAccessors";
import { issueAttachPayload } from "@/utils/linkProviderIssue";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { QuietGitDetails } from "./WorktreeCard/QuietGitDetails";
import { cn } from "../../lib/utils";
import { getWorktreeSidebarRowId } from "@/components/Sidebar/useWorktreeSidebarKeyboard";
import {
  copyableBranchName,
  isExternalWorktree,
  isLiveDevServerStatus,
} from "@/lib/worktreeFilters";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { agentToolbarPin } from "@shared/types/ipc/agentToolbarPins";
import { useAgentToolbarPinsStore } from "@/store/agentToolbarPinsStore";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { FocusedSubLine } from "./WorktreeCard/FocusedSubLine";
import { hasTextSelectionWithin, isCardContentEvent } from "./WorktreeCard/cardClickTarget";
import { selectButtonDescribedBy, worktreeRowDescriptionId } from "./WorktreeCard/rowDescriptions";
import { isTooltipFocusOpenSuppressed } from "@/lib/tooltipDismissRegistry";
import { isTooltipSuppressedForElement } from "@/lib/tooltipFocusSuppression";
import {
  WorktreeDetailsSection,
  WorktreeDeleteErrorBanner,
  WorktreeIssueErrorBanner,
} from "./WorktreeCard/WorktreeDetailsSection";
import { WorktreeDialogs } from "./WorktreeCard/WorktreeDialogs";
import { notifyAttachmentFailure } from "./WorktreeCard/notifyAttachmentFailure";
import { WorktreeHeader } from "./WorktreeCard/WorktreeHeader";
import { WorktreeTerminalSection } from "./WorktreeCard/WorktreeTerminalSection";
import { deriveSetupAlarm } from "./WorktreeCard/setupAlarm";
import { syncLineHasNews } from "./WorktreeCard/syncLineNews";
import { WslGitBanner } from "./WorktreeCard/WslGitBanner";
import { useInputReceiptKey } from "./WorktreeCard/hooks/useInputReceiptKey";
import { useWorktreeActions } from "./WorktreeCard/hooks/useWorktreeActions";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { copyWithToast } from "@/lib/copyWithToast";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { WorktreeDensitySubmenu } from "./WorktreeDensitySubmenu";
import {
  CONTEXT_COMPONENTS,
  WorktreeMenuItems,
  type WorktreeMenuActions,
} from "./WorktreeMenuItems";
import type { MenuActionSourceValue } from "@/components/ui/menu-source";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { isAgentTerminalFleetEligible, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useWorktreeStatus } from "./WorktreeCard/hooks/useWorktreeStatus";
import { useWorktreeDevServerSession } from "@/hooks/app/useWorktreeDevServerSession";
import { computeChipState } from "./utils/computeChipState";
import { isAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { isWorktreeMergedForCleanup } from "@/lib/worktreeAgentBuckets";
import { useWorktreeAgentBuckets } from "@/hooks/useWorktreeAgentBucketInputs";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  bulkParkAgents,
  countParkTargets,
  selectParkTargets,
  type BulkParkVerb,
} from "@/lib/parkWorktreeAgents";
import { devServerMenuState } from "./utils/devServerMenuState";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { CHIP_LABELS, WorktreeStatusTick } from "./WorktreeCard/WorktreeStatusTick";
import { canOpenResourceBoxOnHost } from "@/components/Hosts/resourceHostHandoff";

const HOVER_REVALIDATE_DELAY = 150;
const REVALIDATE_FRESHNESS_GATE = 10_000;
const MAX_CONCURRENT_REVALIDATES = 3;
const NO_WORKTREE_IDS: Set<string> = new Set();
const inFlightRevalidates = new Set<string>();

function isRevalidationAllowed(worktreeId: string): boolean {
  return (
    inFlightRevalidates.size < MAX_CONCURRENT_REVALIDATES || inFlightRevalidates.has(worktreeId)
  );
}

export interface WorktreeCardProps {
  worktree: WorktreeState;
  isActive: boolean;
  isFocused: boolean;
  isSingleWorktree?: boolean;
  /** The sidebar grid's keyboard cursor is on this card (grid keyboard-focused). */
  isKeyboardCursor?: boolean;
  onSelect: () => void;
  onOpenEditor: () => void;
  onSaveLayout?: () => void;
  onLaunchAgent?: (agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
  variant?: "sidebar" | "grid";
  onAfterTerminalSelect?: () => void;
  dragHandleListeners?: SyntheticListenerMap;
  dragHandleActivatorRef?: (node: HTMLElement | null) => void;
  isDraggingSort?: boolean;
  isDragHandleDisabled?: boolean;
  /** Why the grip is disabled, shown as its tooltip. */
  dragDisabledReason?: string | null;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /**
   * Multi-select state (grid variant only). When provided, modifier-clicks
   * (Ctrl/Cmd/Shift) route through `onToggleSelect` instead of `onSelect`
   * and a checkbox affordance becomes visible on hover or when selected.
   */
  isSelected?: boolean;
  onToggleSelect?: (event: React.MouseEvent) => void;
}

export function WorktreeCard({
  worktree,
  isActive,
  isFocused,
  isSingleWorktree: _isSingleWorktree,
  isKeyboardCursor = false,
  onSelect,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
  variant = "sidebar",
  onAfterTerminalSelect,
  dragHandleListeners,
  dragHandleActivatorRef,
  isDraggingSort,
  isDragHandleDisabled = false,
  dragDisabledReason,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  isSelected = false,
  onToggleSelect,
}: WorktreeCardProps) {
  "use memo";
  const isMultiSelectEnabled = variant === "grid" && onToggleSelect !== undefined;

  const handleCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!isCardContentEvent(e) || isDraggingSort) return;
    // `detail` is 0 for the select button's Enter/Space, which ends no drag.
    if (e.detail > 0 && hasTextSelectionWithin(e.currentTarget)) return;
    if (isMultiSelectEnabled && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(e);
      return;
    }
    onSelect();
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect?.(e);
  };
  const isExpanded = useWorktreeSelectionStore((state) => state.expandedWorktrees.has(worktree.id));
  const toggleWorktreeExpanded = useWorktreeSelectionStore((state) => state.toggleWorktreeExpanded);

  const isTerminalsExpanded = useWorktreeSelectionStore((state) =>
    state.expandedTerminals.has(worktree.id)
  );
  const toggleTerminalsExpanded = useWorktreeSelectionStore(
    (state) => state.toggleTerminalsExpanded
  );
  const trackTerminalFocus = useWorktreeSelectionStore((state) => state.trackTerminalFocus);

  const getRecipesForWorktree = useRecipeStore((state) => state.getRecipesForWorktree);
  const agentPins = useAgentToolbarPinsStore((state) => state.pins);
  const recipes = getRecipesForWorktree(worktree.id);

  const resourceEnvironments = useProjectSettingsStore(
    (state) => state.settings?.resourceEnvironments
  );

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.settings?.notificationOverrides
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const environmentIcon =
    worktree.worktreeMode && worktree.worktreeMode !== "local"
      ? resourceEnvironments?.[worktree.worktreeMode]?.icon
      : undefined;

  const isPinnedStored = useWorktreeFilterStore((state) =>
    state.pinnedWorktrees.includes(worktree.id)
  );
  const pinWorktree = useWorktreeFilterStore((state) => state.pinWorktree);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);
  const isExternal = isExternalWorktree(worktree);
  // Pinning can't lift an external worktree out of the bottom partition, so a
  // leftover pin entry must not render as pinned either (#11434).
  const isPinned = isPinnedStored && !isExternal;

  const isCollapsed = useWorktreeFilterStore((state) =>
    state.collapsedWorktrees.includes(worktree.id)
  );
  const toggleWorktreeCollapsed = useWorktreeFilterStore((state) => state.toggleWorktreeCollapsed);
  const labelColor = useWorktreeFilterStore(
    (state) => state.worktreeLabelColors[worktree.id] ?? null
  );
  const customTitle = useWorktreeFilterStore((state) => state.worktreeCustomTitles[worktree.id]);
  // The sidebar card has two densities; the grid card has its own layout.
  const cardDensity = useWorktreeFilterStore((state) => state.cardDensity);
  const isCompactCard = variant === "sidebar" && cardDensity === "compact";
  const labelAriaSuffix = labelColor
    ? `, Label colour: ${worktreeLabelDisplayName(labelColor)}`
    : "";

  const canCollapse = variant !== "grid";
  const effectiveIsCollapsed = canCollapse && isCollapsed;
  const hasRowDragHandle = Boolean(dragHandleListeners) || isDragHandleDisabled;

  const handleToggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleWorktreeCollapsed(worktree.id);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!canCollapse) return;
    // Two quick clicks on a control (More actions, a disclosure, the drag
    // handle) are two presses of that control, not a request to fold the card
    // (#10319). The text-selection guard stays off here: a double-click
    // selects a word on its own.
    if (!isCardContentEvent(e)) return;
    e.stopPropagation();
    toggleWorktreeCollapsed(worktree.id);
  };

  const handleTogglePin = () => {
    if (isPinned) {
      unpinWorktree(worktree.id);
    } else {
      pinWorktree(worktree.id);
    }
  };

  const {
    counts: terminalCounts,
    terminals: worktreeTerminals,
    dominantAgentState,
  } = useWorktreeTerminals(worktree.id);

  const devServerSession = useWorktreeDevServerSession(worktree.id);

  // `stopped` is ambiguous — a session the main process has already deleted
  // broadcasts it too, and the renderer cache retains that snapshot. The
  // panel's continued existence is the discriminator; see devServerMenuState.
  const devServerPanelId = devServerSession?.panelId;
  const devServerPanelExists = usePanelStore((state) =>
    devServerPanelId ? state.panelsById[devServerPanelId] !== undefined : false
  );
  const devServerState = devServerMenuState(devServerSession, devServerPanelExists);

  const pluginMenuContext = useMemo<WhenClauseContext>(
    () => ({ worktreeId: worktree.id }),
    [worktree.id]
  );
  const pluginItems = usePluginContextMenuItems("worktree", pluginMenuContext);
  // Only an explicit quiet: a folder without a repository resolves to hidden,
  // and its cards already have no git detail to move.
  const presentation = useResolvedPresentation();
  const quietGit = presentation.gitDetail === "demoted";
  const hideDevPreview = presentation.devServer === "hidden";

  // Border accent flash — fires once when the dominant *execution* state for
  // this card meaningfully changes. `directing` is excluded because it's
  // driven by the user's local typing cycle (start typing → directing,
  // submit/clear → null), which would flash the card on every keystroke
  // rather than on real agent activity. The flashKey counter remounts the
  // overlay on each transition so back-to-back changes restart the
  // animation rather than dropping silently.
  const prevAgentStateRef = useRef(dominantAgentState);
  const [flashKey, setFlashKey] = useState(0);
  const [isSelectFocusVisible, setIsSelectFocusVisible] = useState(false);
  // A focus handed back by a closing overlay is not a visit, so the same
  // suppression the tooltip wrapper applies to its own focus opens applies here.
  const handleSelectFocus = useCallback((e: React.FocusEvent<HTMLButtonElement>) => {
    setIsSelectFocusVisible(
      e.currentTarget.matches(":focus-visible") &&
        !isTooltipFocusOpenSuppressed() &&
        !isTooltipSuppressedForElement(e.currentTarget)
    );
  }, []);
  const handleSelectBlur = useCallback(() => setIsSelectFocusVisible(false), []);

  useEffect(() => {
    const prev = prevAgentStateRef.current;
    if (prev !== dominantAgentState) {
      prevAgentStateRef.current = dominantAgentState;
      if (
        dominantAgentState !== null &&
        dominantAgentState !== "directing" &&
        prev !== "directing"
      ) {
        setFlashKey((k) => k + 1);
      }
    }
  }, [dominantAgentState]);

  // Input-time receipt — fires the moment a row terminal is pinged (well
  // before the polled `dominantAgentState` border-flash). Acknowledges the
  // input itself, not its outcome, so any agent-state staleness is irrelevant.
  // `pingSeq` is the authoritative trigger so back-to-back taps of the same
  // terminal both produce a receipt (Zustand `Object.is` would suppress the
  // re-render if we keyed off `pingedId` alone).
  const pingedId = usePanelStore((state) => state.pingedId);
  const pingSeq = usePanelStore((state) => state.pingSeq);
  const worktreeTerminalIds = useMemo(
    () => worktreeTerminals.map((t) => t.id),
    [worktreeTerminals]
  );
  const receiptKey = useInputReceiptKey(pingedId, pingSeq, worktreeTerminalIds);
  // Parking reads the fleet snapshot, not the panels: only a run the snapshot
  // carries can be parked, and a plain shell never appears there.
  const parking = useFleetSnapshotStore(
    useShallow((state) => countParkTargets(state.snapshot, worktreeTerminalIds))
  );
  const handleBulkPark = (verb: BulkParkVerb) => {
    const targets = selectParkTargets(
      useFleetSnapshotStore.getState().snapshot,
      worktreeTerminalIds,
      verb
    );
    safeFireAndForget(bulkParkAgents(verb, targets, { worktreeId: worktree.id }), {
      context: `WorktreeCard bulk ${verb}`,
    });
  };

  const setFocused = usePanelStore((state) => state.setFocused);
  const pingTerminal = usePanelStore((state) => state.pingTerminal);
  const openDockTerminal = usePanelStore((state) => state.openDockTerminal);
  const completedCount = terminalCounts.byState.completed + terminalCounts.byState.exited;
  const totalTerminalCount = terminalCounts.total;
  const gridCount = worktreeTerminals.filter(
    (t) => t.location === "grid" || t.location === undefined
  ).length;
  const dockCount = worktreeTerminals.filter((t) => t.location === "dock").length;
  // Counts for the Sessions submenu's Select * items. "All" follows Fleet
  // broadcast membership (any live PTY); state-specific items are meaningful
  // only for terminals with agent state.
  const eligibleTerminals = worktreeTerminals.filter(isFleetArmEligible);
  const eligibleTerminalCount = eligibleTerminals.length;
  const waitingAgentCount = eligibleTerminals.filter(
    (t) => isAgentTerminalFleetEligible(t) && t.agentState === "waiting"
  ).length;
  const workingAgentCount = eligibleTerminals.filter(
    (t) => isAgentTerminalFleetEligible(t) && t.agentState === "working"
  ).length;

  const worktreeErrors = useErrorStore(
    useShallow((state) =>
      state.errors.filter((e) => e.context?.worktreeId === worktree.id && !e.dismissed)
    )
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);

  const isBeingDeleted = useWorktreeStore((state) => state.deletingIds.has(worktree.id));
  const deleteError = useWorktreeStore((state) => state.deleteErrors.get(worktree.id) ?? null);
  const issueError = useWorktreeStore((state) => state.issueErrors.get(worktree.id) ?? null);

  const handleRetryDelete = () => {
    getCurrentViewStore().getState().retryDelete(worktree.id);
  };

  const handleDismissDeleteError = () => {
    getCurrentViewStore().getState().clearDeleteError(worktree.id);
  };

  const handleRetryIssue = () => {
    if (!issueError) return;
    getCurrentViewStore().getState().retryOutboxEntry(issueError.mutationId);
  };

  const handleDismissIssueError = () => {
    if (!issueError) return;
    getCurrentViewStore().getState().dismissOutboxEntry(issueError.mutationId);
  };

  const handleErrorRetry = async (
    errorId: string,
    action: RetryAction,
    args?: Record<string, unknown>
  ) => {
    try {
      await errorsClient.retry(errorId, action, args);
      removeError(errorId);
    } catch (error) {
      logError("Error retry failed", error);
    }
  };

  const isMainWorktree = Boolean(worktree.isMainWorktree);
  const {
    branchLabel,
    isMainOnStandardBranch,
    hasChanges,
    effectiveNote,
    effectiveSummary,
    computedSubtitle,
    reviewState,
    spineState,
    isLifecycleRunning,
    lifecycleLabel,
    resourceStatusLabel,
    resourceStatusColor,
    hasResourceConfig,
    gitStateIndicator,
  } = useWorktreeStatus({ worktree });

  const hasPauseCommand = !!worktree.hasPauseCommand;
  const hasResumeCommand = !!worktree.hasResumeCommand;
  const hasTeardownCommand = !!worktree.hasTeardownCommand;
  const teardownCommands =
    worktree.worktreeMode && worktree.worktreeMode !== "local"
      ? (resourceEnvironments?.[worktree.worktreeMode]?.teardown ?? [])
      : [];
  const hasStatusCommand = !!worktree.hasStatusCommand;
  const hasProvisionCommand = !!worktree.hasProvisionCommand;

  const {
    runningRecipeId,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleRunRecipe,
    handleDockAll,
    handleMaximizeAll,
    handleSelectAllAgents,
    handleSelectWaitingAgents,
    handleSelectWorkingAgents,
    handleCloseAll,
    handleTerminateAll,
    handleClearHistory,
    handleResourceTeardown,
    handleResourceOpenOnHost,
    confirmAttachmentMove,
  } = useWorktreeActions({
    worktree,
    teardownCommands,
  });

  const handleOpenIssueExternal = () => {
    void actionService.dispatch(
      "worktree.openIssue",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleSetLabelColor = (token: WorktreeLabelToken | null) => {
    const color =
      token === null ? null : WORKTREE_LABEL_COLORS.find((c) => c.token === token)!.name;
    void actionService.dispatch(
      "worktree.setLabelColor",
      { worktreeId: worktree.id, color },
      { source: "user" }
    );
  };

  const handleOpenPRExternal = () => {
    void actionService.dispatch("worktree.openPR", { worktreeId: worktree.id }, { source: "user" });
  };

  const handleResetRenderers = () => {
    void actionService.dispatch(
      "worktree.sessions.resetRenderers",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleStopDevServer = useCallback((worktreeId: string) => {
    safeFireAndForget(window.electron.devPreview.stopDevServerByWorktree({ worktreeId }), {
      context: "Stop dev server for worktree",
    });
  }, []);

  const handleRestartDevServer = useCallback((worktreeId: string) => {
    safeFireAndForget(window.electron.devPreview.restartByWorktree({ worktreeId }), {
      context: "Restart dev server for worktree",
    });
  }, []);

  // Same IPC as restart, different promise to the user. A stopped session still
  // has its panel and manifest, so reviving it is a start — the menu says so
  // rather than offering a "Restart" that starts and a "Stop" that no-ops.
  const handleStartDevServer = useCallback((worktreeId: string) => {
    safeFireAndForget(window.electron.devPreview.restartByWorktree({ worktreeId }), {
      context: "Start dev server for worktree",
    });
  }, []);

  const handleResourceResume = () => {
    void actionService.dispatch(
      "worktree.resource.resume",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleResourcePause = () => {
    void actionService.dispatch(
      "worktree.resource.pause",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleResourceConnect = () => {
    void actionService.dispatch(
      "worktree.resource.connect",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const resourceEnvironmentKeys = Object.keys(resourceEnvironments ?? {});

  const handleSwitchEnvironment = (envKey: string) => {
    void worktreeClient.switchEnvironment(worktree.id, envKey);
  };

  const handleResourceProvision = () => {
    void actionService.dispatch(
      "worktree.resource.provision",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const runAttachmentAction = (
    name: string,
    action: "attach" | "detach" | "status",
    expectedHolderWorktreeId?: string | null
  ) => {
    worktreeClient
      .attachmentAction(worktree.id, name, action, expectedHolderWorktreeId)
      .catch((err: unknown) => notifyAttachmentFailure(err, name, action, worktree.id));
  };

  const handleAttachmentAction = (name: string, action: "attach" | "detach" | "status") => {
    if (action !== "attach") {
      runAttachmentAction(name, action);
      return;
    }
    // The holder this card shows travels with the request, so the host refuses
    // it if the attachment moved in the meantime rather than detaching someone
    // the user never confirmed moving it away from.
    const holderId = worktree.attachments?.find((a) => a.name === name)?.holderWorktreeId ?? null;
    if (holderId && holderId !== worktree.id) {
      const holder = getCurrentViewStore().getState().worktrees.get(holderId);
      const fromLabel = holder?.branch ?? holder?.name ?? holderId;
      confirmAttachmentMove(name, fromLabel, () => runAttachmentAction(name, action, holderId));
      return;
    }
    runAttachmentAction(name, action, holderId);
  };

  const handleResourceStatus = () =>
    actionService.dispatch(
      "worktree.resource.status",
      { worktreeId: worktree.id },
      { source: "user" }
    );

  // One endpoint preview per worktree: a second click brings back the panel
  // already showing it rather than stacking another (#13688).
  const handlePreviewEndpoint = () => {
    const store = usePanelStore.getState();
    const existing = Object.values(store.panelsById).find(
      (panel) =>
        isDevPreviewPanel(panel) &&
        panel.worktreeId === worktree.id &&
        panel.previewsResourceEndpoint === true &&
        !store.isInTrash(panel.id)
    );
    if (existing) {
      // Activation, not bare focus: it leaves a maximize that would hide the panel.
      store.activateTerminal(existing.id);
      pingTerminal(existing.id);
      return;
    }
    safeFireAndForget(
      store.addPanel({
        kind: "dev-preview",
        title: "Endpoint preview",
        cwd: worktree.path,
        worktreeId: worktree.id,
        previewsResourceEndpoint: true,
      }),
      { context: "Opening resource endpoint preview" }
    );
  };

  const handleCopyContextFull = () => {
    void copyContextWithFeedback(worktree.id, "context-menu", undefined, "worktree-card");
  };

  const handleCopyContextModified = () => {
    void copyContextWithFeedback(worktree.id, "context-menu", { modified: true }, "worktree-card");
  };

  const handleCopyPath = () => {
    copyWithToast("Path", worktree.path);
  };

  const handleCopyBranchName = () => {
    const branch = copyableBranchName(worktree);
    if (!branch) return;
    copyWithToast("Branch name", branch);
  };

  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [showTitleDialog, setShowTitleDialog] = useState(false);
  // The dialog returns focus to the ⋯ trigger it was opened from on its own;
  // these are where it lands when the opener was the right-click menu, which
  // has no trigger: the sidebar card's select button, or the grid cell.
  const cardRootRef = useRef<HTMLElement | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement | null>(null);
  const resolveTitleDialogRestore = () =>
    selectButtonRef.current ??
    cardRootRef.current?.closest<HTMLElement>('[role="gridcell"]') ??
    cardRootRef.current;

  // `planFilePath` is a bare candidate filename (`TODO.md` and friends), so
  // `worktree.path` is the root it resolves against, and naming the card's own
  // worktree is what stops an inactive card's plan from being bound to whichever
  // worktree happens to be selected (#11942).
  const planFilePath = worktree.planFilePath;
  const openPlanFileForThisWorktree =
    worktree.hasPlanFile && planFilePath
      ? () => {
          void actionService.dispatch("file.view", {
            path: planFilePath,
            rootPath: worktree.path,
            worktreeId: worktree.id,
            viewMode: "rendered",
          });
        }
      : undefined;

  // Every Review Hub entry point (banner button, menu, header, terminal
  // section) dispatches the action, which presents the review panel as a
  // dialog through the global host. The action owns the commit-message seed,
  // so no card-local state or window event bridges it any more.
  const openReviewHubForThisWorktree = () => {
    void actionService.dispatch("worktree.openReviewHub", { worktreeId: worktree.id });
  };

  const hasOpenableChanges = (worktree.worktreeChanges?.changes.length ?? 0) > 0;

  // Names the card outright, like the Review Hub entry point. No focus nudge is
  // needed: the action gates only its palette row on context, so an explicit
  // worktreeId is always honoured whatever else holds focus.
  const openChangesForThisWorktree = () => {
    void actionService.dispatch("worktree.openChanges", { worktreeId: worktree.id });
  };

  // Unlike the Review Hub and Changes entry points above, this one opens a real
  // grid panel rather than a dialog — and the grid renders only the active
  // worktree's bucket, so a panel created for an inactive card would be
  // backgrounded on arrival: counted, persisted, and invisible (#11666). Select
  // first, exactly as `handleTerminalSelect` below does before focusing a
  // terminal on an inactive card.
  // `"user"`, not the menu source: the handler is defined in the card body,
  // outside any menu Root, so `useMenuActionSource()` would fall back to
  // exactly this and warn on the way. Naming a foreground source at all is what
  // matters — it is what lets the panel take focus instead of deferring to the
  // store's ambient spawn guards.
  const openFileBrowserForThisWorktree = () => {
    if (!isActive) onSelect();
    void actionService.dispatch(
      "worktree.openFileBrowserPanel",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  // Route attach/detach through the resilient mutation outbox (#9163) instead
  // of a fire-and-forget IPC. The store applies the local association only once
  // the Electron-store write lands, replays a mutation that was in flight when
  // the host crashed, and surfaces failures via `WorktreeIssueErrorBanner`.
  const handleAttachIssue = (issue: Issue) => {
    getCurrentViewStore().getState().startAttachIssue(issueAttachPayload(worktree.id, issue));
  };

  const handleDetachIssue = () => {
    getCurrentViewStore().getState().startDetachIssue(worktree.id);
  };

  const handleTerminalSelect = (terminal: PtyPanelData) => {
    // Switch to this worktree if it isn't already active
    if (!isActive) {
      if (terminal.worktreeId) {
        trackTerminalFocus(terminal.worktreeId, terminal.id);
      }
      onSelect();
    }

    // Focus the terminal (Dock or Grid). A grid pane is hidden while the
    // project's Home shows; the dock stays on screen beside it.
    if (terminal.location === "dock") {
      openDockTerminal(terminal.id);
    } else {
      exitProjectHome();
      setFocused(terminal.id);
    }

    // Trigger the ping animation
    pingTerminal(terminal.id);

    // Invoke callback (e.g. close modal) after focusing terminal
    onAfterTerminalSelect?.();
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleWorktreeExpanded(worktree.id);
  };

  const handleToggleTerminals = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleTerminalsExpanded(worktree.id);
  };

  const agentIds = (() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    return [...baseIds, ...extraIds];
  })();

  const launchAgents = (() => {
    return agentIds
      .filter((agentId) => isAgentPinned(agentToolbarPin(agentPins, agentId)))
      .map((agentId) => {
        const config = getAgentConfig(agentId);
        const available = isAgentLaunchable(agentAvailability?.[agentId]);

        return {
          id: agentId,
          name: config?.name ?? agentId,
          icon: config?.icon,
          isEnabled: available,
        };
      });
  })();

  const isWorktreeSortDragging = useIsWorktreeSortDragging();

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";
  const isWaitingCard = terminalCounts.byState.waiting > 0;

  // The same buckets the sidebar filter counts this worktree under, so the mark
  // and the filter cannot disagree.
  // Membership through `isTerminalVisible`, like the sidebar, the overview and
  // cycling: a backgrounded agent is not counted there, so it must not mark
  // the card either. Every terminal here already belongs to this (existing)
  // worktree, so the orphan check has nothing to do.
  const isInTrash = usePanelStore((state) => state.isInTrash);
  const agentBuckets = useWorktreeAgentBuckets(
    worktreeTerminals
      .filter((t) => isAgentTerminal(t) && isTerminalVisible(t, isInTrash, NO_WORKTREE_IDS))
      .map((t) => t.id),
    isWorktreeMergedForCleanup(worktree),
    worktree.id
  );
  const chipState = computeChipState(agentBuckets);

  // The active card used to opt out of being a drop target entirely — every
  // panel drag originated from the active worktree, so it could only ever be a
  // no-op self-drop. Accordion drags broke that assumption: dragging a
  // terminal out of an inactive (or deleted) worktree's sidebar row onto the
  // ACTIVE card is the most common rescue flow, so the droppable stays
  // registered and only disables when the dragged panel already lives here.
  const { activeTerminal: draggedPanel } = useDndPlaceholder();
  const isCrossWorktreePanelDrag =
    draggedPanel !== null && (draggedPanel.worktreeId ?? null) !== worktree.id;
  // Under a plugin's sidebar view the card keeps its box, so it would still
  // catch a terminal dropped onto the view in front of it.
  const isHiddenInSidebar = useBuiltInSidebarViewHidden();

  const { setNodeRef, isOver, over, active } = useDroppable({
    id: `worktree-drop-${worktree.id}`,
    data: {
      type: "worktree",
      worktreeId: worktree.id,
    },
    disabled:
      (isActive && !isCrossWorktreePanelDrag) || isWorktreeSortDragging || isHiddenInSidebar,
  });

  const droppableRef = (node: HTMLElement | null) => {
    setNodeRef(node);
    cardRootRef.current = node;
  };

  const isMovablePanelDrag = isPanelDragMovableToWorktree(
    active?.data.current as Partial<WorktreeDragData> | undefined,
    worktree.id
  );
  // The sidebar row stacks two same-size droppables (this drop target inside
  // the SortableWorktreeCard sortable), and pointerWithin resolves their tie
  // by registration order — `over` can be either id, so match both. Mirrors
  // the dual-id handling in DndProvider's handleDragEnd.
  const isPanelDropTarget =
    (!isActive || isCrossWorktreePanelDrag) &&
    isMovablePanelDrag &&
    (isOver || over?.id === getWorktreeSortDragId(worktree.id));

  const isMuted =
    (isIdleCard || isStaleCard) && !isWaitingCard && !isActive && !isFocused && !isPanelDropTarget;

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverWorktreeIdRef = useRef(worktree.id);
  useEffect(() => {
    hoverWorktreeIdRef.current = worktree.id;
  }, [worktree.id]);

  // Freshness lives in the store's statusCheckedAt side map, not on the
  // snapshot — the snapshot field only reflects the last content change (see
  // createWorktreeStore). Per-id primitive selector: this card re-renders only
  // when ITS worktree's stamp advances.
  const lastGitStatusCheckedAt = useWorktreeStore((s) => s.statusCheckedAt.get(worktree.id));

  const handleRevalidate = useCallback(() => {
    const id = hoverWorktreeIdRef.current;
    if (
      isActive ||
      !isRevalidationAllowed(id) ||
      (lastGitStatusCheckedAt && Date.now() - lastGitStatusCheckedAt < REVALIDATE_FRESHNESS_GATE)
    ) {
      return;
    }
    inFlightRevalidates.add(id);
    void worktreeClient
      .refresh(id)
      .finally(() => {
        inFlightRevalidates.delete(id);
      })
      .catch(() => {});
  }, [isActive, lastGitStatusCheckedAt]);

  const handlePointerEnter = useCallback(() => {
    if (isActive || !lastGitStatusCheckedAt) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      handleRevalidate();
    }, HOVER_REVALIDATE_DELAY);
  }, [isActive, lastGitStatusCheckedAt, handleRevalidate]);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  // Selecting first is load-bearing: whatever the launcher creates lands in the
  // active worktree's bucket, so without it a pick from an inactive card's menu
  // would spawn against the previously active worktree.
  //
  // The source is resolved by `WorktreeMenuItems` (which IS inside the menu
  // Root) and handed back here, so the dropdown dispatches as `menu` and the
  // right-click surface as `context-menu` instead of both claiming the latter.
  const handleOpenPanelPalette = (source: MenuActionSourceValue) => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    void actionService.dispatch("panel.palette", undefined, { source });
  };

  // Subscribed rather than read once: the lease is captured by a push that may
  // have been started from this very menu, so the row has to appear without the
  // card needing to re-render for some other reason.
  const forcePushRecovery = useGitForcePushStore((s) => s.recovery[worktree.path]);
  // The lease is keyed by path, but a worktree can change branch under it.
  // Offering one captured against a branch that is no longer checked out would
  // force push the wrong history.
  const canForcePush =
    forcePushRecovery !== undefined && forcePushRecovery.branchName === worktree.branch;

  /**
   * Unlike the card's other dispatches, these report failure. A push rejected
   * for a diverged remote is the ENTIRE precondition for the Force push row,
   * and a card that swallowed the rejection would hide the row behind a
   * failure the user was never told about. The rejection also carries its own
   * recovery, so the toast offers it rather than making them find the row.
   */
  const dispatchGitAction =
    (actionId: "git.pullRebase" | "git.push" | "git.forcePushWithLease") =>
    async (source: MenuActionSourceValue) => {
      const result = await actionService.dispatch(actionId, { cwd: worktree.path }, { source });
      if (result.ok) return;

      // A lease exists only when this very push was rejected for a diverged
      // remote, which is exactly the failure force pushing resolves.
      const captured = useGitForcePushStore.getState().getRecovery(worktree.path);
      if (actionId === "git.push" && captured) {
        notify({
          type: "error",
          context: { worktreeId: worktree.id, eventKind: "git" },
          title: "Push failed",
          message: `${captured.branchName} has commits on the remote you don't have locally. Force pushing discards them; pulling keeps them.`,
          action: {
            label: "Force push…",
            onClick: () => void dispatchGitAction("git.forcePushWithLease")(source),
          },
        });
        return;
      }

      // ActionService preserves the original throw on `details`, and the git
      // actions decode it before rethrowing — so the discriminated reason is
      // right there. Dropping it would collapse auth, network, hook and policy
      // failures into one "Git operation failed" toast that names no cause and
      // offers no route.
      const cause = result.error.details;
      const gitReason = isClientGitError(cause) ? cause.gitReason : undefined;
      const humanized = humanizeAppError({
        type: "git",
        source: "WorktreeCard",
        message: result.error.message,
        gitReason,
        recoveryHint: undefined,
      });
      const recovery = gitReason ? getGitRecoveryAction(gitReason) : undefined;
      if (recovery) {
        // The table's entries take different location spellings, and a wrong
        // one fails silently rather than loudly: `worktree.openReviewHub`
        // declares `z.object({ worktreeId })`, which STRIPS a stray `cwd` and
        // then falls back to the focused/active worktree — opening the wrong
        // card's Review Hub. The git actions want the path.
        const recoveryArgs =
          recovery.args ??
          (recovery.actionId === "worktree.openReviewHub"
            ? { worktreeId: worktree.id }
            : { cwd: worktree.path });
        notify({
          type: "error",
          context: { worktreeId: worktree.id, eventKind: "git" },
          title: humanized.title,
          message: humanized.body,
          action: {
            label: recovery.label,
            onClick: () => void actionService.dispatch(recovery.actionId, recoveryArgs, { source }),
          },
        });
        return;
      }

      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok. `RECOVERY_ACTIONS` in gitOperationErrors.ts is the repo's map of which git failures have a route; the ones that reach here are the ones it deliberately leaves unrouted, and inventing an action for them would send the user somewhere unrelated to what failed.
      notify({
        type: "error",
        context: { worktreeId: worktree.id, eventKind: "git" },
        title: humanized.title,
        message: humanized.body,
      });
    };

  // One action set drives both menu surfaces — the card's right-click menu and
  // the ⋯ toolbar dropdown — so they can't drift apart (they did: Browse Files
  // was wired into the dropdown only).
  const menuActions: WorktreeMenuActions = {
    launchAgents,
    recipes: recipes.map((r) => ({ id: r.id, name: r.name })),
    runningRecipeId,
    counts: {
      grid: gridCount,
      dock: dockCount,
      active: totalTerminalCount,
      completed: completedCount,
      all: eligibleTerminalCount,
      waiting: waitingAgentCount,
      working: workingAgentCount,
    },
    onCopyContextFull: handleCopyContextFull,
    onCopyContextModified: handleCopyContextModified,
    onCopyPath: handleCopyPath,
    onCopyBranchName: handleCopyBranchName,
    onOpenEditor,
    onRevealInFinder: handlePathClick,
    onOpenIssueExternal: worktree.issueNumber ? handleOpenIssueExternal : undefined,
    onOpenPRExternal: worktree.linked?.pr?.url ? handleOpenPRExternal : undefined,
    onAttachIssue: () => setShowIssuePicker(true),
    onUnlinkIssue: worktree.issueNumber ? handleDetachIssue : undefined,
    onViewPlan: openPlanFileForThisWorktree,
    // Gated on the change list, not `hasChanges` (a `changedFileCount` read):
    // an external git provider may report a count with no per-file entries, and
    // the action has nothing to open then. Same guard the Changed Files header
    // button uses.
    onOpenChanges: hasOpenableChanges ? openChangesForThisWorktree : undefined,
    onOpenReviewHub: openReviewHubForThisWorktree,
    onGitPullRebase: dispatchGitAction("git.pullRebase"),
    onGitPush: dispatchGitAction("git.push"),
    onGitForcePush: dispatchGitAction("git.forcePushWithLease"),
    canForcePush,
    onOpenFileBrowser: openFileBrowserForThisWorktree,
    onCompareDiff: () => useWorktreeSelectionStore.getState().openCrossWorktreeDiff(worktree.id),
    onRunRecipe: (recipeId) => void handleRunRecipe(recipeId),
    onSaveLayout,
    onTogglePin: isExternal ? undefined : handleTogglePin,
    onToggleCollapse: canCollapse ? () => toggleWorktreeCollapsed(worktree.id) : undefined,
    isCollapsed: effectiveIsCollapsed,
    labelColor,
    onSetLabelColor: handleSetLabelColor,
    onEditTitle: () => setShowTitleDialog(true),
    onLaunchAgent,
    onMoveUp,
    onMoveDown,
    canMoveUp,
    canMoveDown,
    onOpenPanelPalette: handleOpenPanelPalette,
    onDockAll: handleDockAll,
    onMaximizeAll: handleMaximizeAll,
    onCloseAll: handleCloseAll,
    onTerminateAll: handleTerminateAll,
    onClearHistory: handleClearHistory,
    onResetRenderers: handleResetRenderers,
    onSelectAllAgents: handleSelectAllAgents,
    onSelectWaitingAgents: handleSelectWaitingAgents,
    onSelectWorkingAgents: handleSelectWorkingAgents,
    parking,
    onParkAgents: () => handleBulkPark("park"),
    onUnparkAgents: () => handleBulkPark("unpark"),
    onDeleteWorktree: !isMainWorktree ? () => setShowDeleteDialog(true) : undefined,
    hasResourceConfig,
    worktreeMode: worktree.worktreeMode,
    resourceEnvironmentKeys,
    onSwitchEnvironment: handleSwitchEnvironment,
    resourceStatus: worktree.resourceStatus?.lastStatus,
    onResourceProvision: hasProvisionCommand ? handleResourceProvision : undefined,
    onResourceResume: hasResumeCommand ? handleResourceResume : undefined,
    onResourcePause: hasPauseCommand ? handleResourcePause : undefined,
    onResourceConnect: worktree.resourceConnectCommand ? handleResourceConnect : undefined,
    onResourceStatus: hasStatusCommand ? handleResourceStatus : undefined,
    onResourceTeardown: hasTeardownCommand ? handleResourceTeardown : undefined,
    attachments: worktree.attachments,
    onAttachmentAction: handleAttachmentAction,
    devServerState,
    onStartDevServer: handleStartDevServer,
    onStopDevServer: handleStopDevServer,
    onRestartDevServer: handleRestartDevServer,
    pluginItems,
    quietGit,
    hideDevPreview,
  };

  const lifecycleAlarm = deriveSetupAlarm(worktree, lifecycleLabel, Boolean(isLifecycleRunning));
  // What the open card's body is already saying, so the title row's marks
  // don't repeat it. Details' resting row names a conflict unless deleting or
  // a lifecycle label outranks it there; the setup recovery and approval blocks
  // sit outside the disclosure, so an open card always shows them.
  const restingRowShowsLifecycle =
    Boolean(lifecycleLabel) &&
    (Boolean(isLifecycleRunning) || worktree.lifecycleStatus?.state !== "success");
  const gitStateShownInBody =
    !effectiveIsCollapsed &&
    !isExpanded &&
    gitStateIndicator?.kind === "conflicted" &&
    reviewState === "conflicted" &&
    !isBeingDeleted &&
    !restingRowShowsLifecycle;
  const lifecycleAlarmShownInBody = !effectiveIsCollapsed;
  // On the compact card Details and Sessions share one footer row while
  // Details is closed: two disclosures that each used a full row to say one
  // line. Opening Sessions keeps its trigger in that row and lays the list out
  // beneath, so the control does not move out from under the click.
  // The pinned main card takes the compact footer in either density: it never
  // scrolls away, so every row it spends is a row the list below loses. Not on
  // a card showing setup recovery: that block sits under the summary row and
  // needs the card's full width, not the width left beside the trigger.
  const hasInlineFooter =
    (isCompactCard || (variant === "sidebar" && isMainWorktree)) && lifecycleAlarm === null;
  const isSessionsFooterInline = hasInlineFooter && !isExpanded && terminalCounts.total > 0;
  // A card with no sessions keeps the trigger's slot empty on that row, so the
  // age column sits on the same x on every card with the shared footer.
  const reservesSessionsSlot = hasInlineFooter && !isExpanded && terminalCounts.total === 0;

  const ariaStatusParts: string[] = [spineState];
  if (gitStateIndicator) {
    ariaStatusParts.push(gitStateIndicator.label);
  }
  if (hasChanges) {
    ariaStatusParts.push("has uncommitted changes");
  }
  const ariaStatusLabel = ariaStatusParts.join(", ");
  const computedAriaTitle = worktree.issueTitle ?? worktree.branchDerivedTitle;
  // A custom title leads, and what it displaced follows in the parenthetical,
  // so a screen reader hears both names the card shows.
  // The headline's own computed label rather than the issue fields, so a
  // PR-originated card names its PR too.
  const displacedAriaNames = customTitle
    ? [getWorktreeHeadline(worktree).label, branchLabel].filter(
        (name, i, names) => name && names.indexOf(name) === i
      )
    : [];
  const ariaName = customTitle
    ? `${customTitle} (${displacedAriaNames.join(", ")})`
    : `${computedAriaTitle ?? branchLabel}${computedAriaTitle ? ` (${branchLabel})` : ""}`;
  const cardContent = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={droppableRef}
          className={cn(
            "sidebar-worktree-card group/card relative isolate transition-colors duration-150",
            // The sidebar card's resting plane, its 2px gutter and its
            // selection overlay all live in sidebar.css — they have to, since
            // that unlayered file's declarations override layered utilities on
            // the same element.

            // The GRID card paints no plane of its own. `OverviewGridCell` is
            // the rendered box — it owns the radius, the border, the fill, the
            // hover lift and the ambient shadow — and this element used to
            // paint a second set of all five inside it. Two concentric 1px
            // `border-divider` strokes at the same radius, 1px apart, which is
            // visible as a doubled edge in every capture and is the outer half
            // of the card-in-card the standards for this component name as its
            // characteristic failure.
            variant === "grid" && "h-full rounded-lg",
            // The header hides its infrastructure labels (port, attachment
            // name) below a width, measured against the card, not the window.
            variant === "sidebar" && "@container/card",
            isActive && variant !== "sidebar" && "bg-surface-panel-elevated",
            variant === "sidebar" && !isActive && "bg-transparent",
            isFocused && !isActive && variant === "grid" && "bg-overlay-soft",
            // The current worktree's edge mark. NEUTRAL in the grid, and that
            // is a rule rather than a preference: the overview grid is one
            // arrow-key domain, accent is its single load-bearing signal, and
            // that budget is already spent on the `aria-activedescendant`
            // cursor (`accentGuard.contract.test.ts`, the WorktreeOverviewModal
            // entry). An accent stripe here put two green marks in one region
            // with nothing saying which was the cursor.
            //
            // `border-interactive` is the top of the neutral edge ladder and
            // clears 3:1 against the card fill on every built-in theme, so it
            // still satisfies SC 1.4.11 as a non-text indicator.
            //
            // Right edge: the side facing the panel grid the worktree
            // controls, clear of the window edge where it vanished on light
            // themes. Sidebar selection carries its own full-height right
            // border in sidebar.css, so this stripe stays grid-only —
            // stacking both on one edge read as a broken double marker
            // (#9711 round-3 owner decision).
            worktree.isCurrent &&
              variant !== "sidebar" &&
              "before:absolute before:right-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-l-[var(--radius-xs)] before:bg-border-interactive before:content-['']",
            isBeingDeleted && !deleteError && "opacity-50 pointer-events-none"
          )}
          // sidebar.css scopes the card's plane, gutter and hover states to
          // this — the class alone is on both variants, and that file is
          // unlayered, so an unscoped rule silently repaints the grid card.
          data-variant={variant}
          data-density={variant === "sidebar" ? cardDensity : undefined}
          data-active={isActive && variant === "sidebar" ? "true" : undefined}
          data-has-grip={variant === "sidebar" && hasRowDragHandle ? "true" : undefined}
          data-hoverable={!isActive && variant === "sidebar" ? "true" : undefined}
          data-hovered={isFocused && !isActive && variant === "sidebar" ? "true" : undefined}
          data-drop-target={isPanelDropTarget ? "true" : undefined}
          data-worktree-branch={branchLabel}
          data-worktree-is-main={isMainWorktree ? "true" : undefined}
          data-label={variant === "sidebar" && labelColor ? labelColor : undefined}
          data-resource-status={resourceStatusLabel ?? undefined}
          data-deleting={isBeingDeleted && !deleteError ? "true" : undefined}
          aria-busy={isBeingDeleted && !deleteError ? "true" : undefined}
          role={variant === "grid" ? "group" : undefined}
          aria-current={variant === "grid" && isActive ? "true" : undefined}
          // The sidebar card is a plain container (no role), where a label is
          // prohibited and never read; its select button carries these words.
          aria-label={
            variant === "sidebar"
              ? undefined
              : `Worktree: ${ariaName}${worktree.isCurrent ? " (current)" : ""}, Status: ${ariaStatusLabel}${labelAriaSuffix}`
          }
          onMouseDown={isMultiSelectEnabled ? suppressShiftClickTextSelection : undefined}
          onClick={handleCardClick}
          onDoubleClick={handleDoubleClick}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          {/* Worktree-level state — attention / ready-for-cleanup / finished — as
              a mark in the card's top-left corner, not a dot in the title row.

              Two things a dot could not do. A 4px vertical is a different
              aspect ratio from everything else on the card, so it never has to
              be told apart from the pins, session pips and git
              marks that already crowd the title row's trailing cluster — a dot
              among dots is a serial hunt, a bar among dots is not; and the
              corner is outside the content grid entirely, which is what keeps
              it a statement about the card rather than one more item inside it.

              Positioned against the CARD, deliberately. It hung off the header
              for a round, taking the title row's height so it could never
              drift from it — and a mark that starts and ends exactly where the
              title does reads as part of the title, which is the one thing this
              mark must not be. It is the card's flag; it belongs on the card's
              corner.

              `computeChipState` returns one state or none, never a
              combination, so one mark is the whole vocabulary. It projects
              the worktree's quick-state buckets, the same ones the sidebar
              filter counts it under.

              Each state gets its own segment count as well as its own hue, and
              that is a requirement rather than a flourish: three marks that
              differ only in fill carry their meaning by colour alone
              (WCAG 1.4.1), and while `waiting` is corroborated elsewhere on the
              card by the session glyphs, nothing else on the card distinguishes
              `cleanup` from `complete`.

              First child of the card, and that is for the screen reader rather
              than the paint: this is the card's state, and a `role="img"` that
              trails the terminal list is heard after everything it qualifies.
              The root's own `aria-label` does not cover it — that "Status:" is
              the spine's dirty/current/stale, a different axis from
              attention/cleanup/finished — so this label is the only place the
              lifecycle state is spoken.

              Which is also why it outranks the content column's own `z-10`
              (the grip's hover plate would wash it) and the `z-20` full-card
              overlays below — the border flash, the input receipt, sidebar.css's
              `::after` drop ring. Those three are continuous lines on the card's
              edge and the mark is now ON that edge, so anything that painted
              over it would bridge its segment gaps rather than just tint it.

              A collapsed row gets the same mark as a 6x6 square rather than a
              16px bar: one line has no corner for a bar that tall to sit on,
              only an edge to run down. The count survives the shrink, because
              it is the only thing that separates two of these states.

              The geometry, and the reason every number in it is what it is,
              lives in `WorktreeStatusTick`. */}
          {/* The colour label: a 3px bar down the leading edge, inside the
              16px gutter every card already has, so applying or clearing it
              moves nothing. Identity, not state — hover, selection, collapse
              and drag leave it alone, and it never takes the accent.

              The status tick shares this edge, and a continuous line under a
              segmented mark bridges its gaps — the segment count is the only
              thing telling cleanup from finished. So the bar is cut out around
              the tick (sidebar.css masks it per `data-cutout`), leaving real
              transparency rather than a painted patch, which is what makes the
              cut-out match whatever surface the card is on at the time.

              Above the content column (the grip's hover plate is in there),
              below the full-card overlays (the drop ring wins its own edge). */}
          {variant === "sidebar" && labelColor && (
            <div
              aria-hidden="true"
              data-testid="worktree-label-bar"
              data-cutout={chipState === null ? undefined : effectiveIsCollapsed ? "square" : "bar"}
              className="worktree-label-bar"
              style={worktreeLabelColorStyle(labelColor)}
            />
          )}
          {chipState !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <WorktreeStatusTick
                  state={chipState}
                  variant={variant}
                  collapsed={effectiveIsCollapsed}
                />
              </TooltipTrigger>
              {/* Above the mark, not beside it: the mark sits on the card's
                  leading corner, so anything opening to its right or below
                  lands on the title it is describing. */}
              <TooltipContent side="top" align="start" className="text-xs">
                {CHIP_LABELS[chipState]}
              </TooltipContent>
            </Tooltip>
          )}
          {chipState !== null && variant === "sidebar" && (
            // For the select button to be described by; see rowDescriptions.
            // Sidebar only, like the button: the overview grid renders the same
            // worktree while the sidebar is mounted, and ids must be unique.
            <span id={worktreeRowDescriptionId(worktree.id, "lifecycle")} hidden>
              {CHIP_LABELS[chipState]}
            </span>
          )}

          {/* Sidebar only. It is the row's keyboard identity there, but not a
              tab stop: the grid is one tab stop and points at this button with
              `aria-activedescendant` (it carries the row's id), so a screen
              reader hears the button's name and the marks that describe it as
              the arrow keys move. A mouse click focuses it and lands in
              `handleCardClick`.

              In the grid it was none of those things. It sat at `z-0` beneath
              the `relative z-10` content column, so no pointer could ever
              reach it, and `tabIndex={-1}` kept it off the tab ring — a
              `<button>` announced to assistive tech that nothing on the
              machine could activate. Selection there is the cell's job:
              `role="gridcell"` carries `aria-selected`, the card root's
              `onClick` handles the pointer, and Enter is handled by the
              grid's own key handler. */}
          {variant === "sidebar" && (
            <button
              type="button"
              ref={selectButtonRef}
              id={getWorktreeSidebarRowId(worktree.id)}
              tabIndex={-1}
              data-card-select-overlay=""
              // row-select-target: the contrast modes' exemption for a full-row
              // select button, which would otherwise box every card.
              className={cn(
                "row-select-target absolute inset-0 z-0 outline-hidden",
                (isDraggingSort || isWorktreeSortDragging) && "pointer-events-none"
              )}
              aria-label={`Select worktree: ${ariaName}${worktree.isCurrent ? " (current)" : ""}, ${ariaStatusLabel}${labelAriaSuffix}`}
              aria-current={isActive ? "true" : undefined}
              // The row's marks are non-focusable, so this button is where a
              // keyboard user meets them: described by each mark's words, and,
              // collapsed, revealing the alarm's tooltip while ringed.
              aria-describedby={selectButtonDescribedBy(worktree.id, {
                lifecycle: chipState !== null,
                // The title row draws the alarm in both modes on the sidebar.
                alarm: true,
                attention: true,
                devServer: !!devServerSession && isLiveDevServerStatus(devServerSession.status),
                external: isExternal,
              })}
              onFocus={handleSelectFocus}
              onBlur={handleSelectBlur}
            />
          )}
          {flashKey > 0 && (
            <div
              key={flashKey}
              className={cn(
                "absolute inset-0 z-20 pointer-events-none border border-overlay animate-border-flash",
                variant === "grid" && "rounded-lg",
                // The active row carries a brighten blend so the flash reads over
                // its own elevated fill. On dark that fill is a dark surface, so
                // screen/plus-lighter lightens it (visible). On light the active
                // row is now an opaque near-white surface (Issue 1 elevate-to-
                // select), and screen-blending the dark `border-strong` flash over
                // near-white is ~invisible — so the blend is dark-only and light
                // paints the border with normal compositing.
                isActive && "dark:mix-blend-plus-lighter"
              )}
              aria-hidden="true"
            />
          )}
          {receiptKey > 0 && (
            <div
              key={receiptKey}
              className={cn(
                "absolute inset-0 z-20 pointer-events-none animate-input-receipt-flash",
                variant === "grid" && "rounded-lg"
              )}
              style={{ background: "color-mix(in srgb, currentColor 10%, transparent)" }}
              aria-hidden="true"
              data-testid="worktree-card-input-receipt"
            />
          )}
          {/* The membership toggle sits in a slot the header reserves for it
              (the grid header block's own `pr-5`), not on top of the header's
              trailing cluster. It used to be `absolute top-2 right-2` over a
              row that ends in the "More actions" button, so the badge covered
              the ellipsis's third dot and clipped the card's corner arc —
              two controls on the same pixels, which is also an SC 2.5.8
              spacing failure whichever of them the pointer was aiming for.

              24x24 is the SC 2.5.8 target floor; the old box was 20x20. */}
          {isMultiSelectEnabled && (
            <div
              className={cn(
                "absolute top-1.5 right-1.5 z-30 transition-opacity duration-150",
                isSelected
                  ? "opacity-100"
                  : "opacity-0 group-hover/card:opacity-100 focus-within:opacity-100"
              )}
            >
              {/* The button is the 24px target and carries the checkbox role; the
                  box inside is the shared checkbox glyph, so a selected card is
                  ticked exactly like every other checkbox in the app. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label="Select worktree"
                tabIndex={-1}
                onClick={handleCheckboxClick}
                className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-overlay-soft"
              >
                <CheckboxGlyph checked={isSelected} />
              </button>
            </div>
          )}
          <div className={cn("relative z-10 flex", variant === "grid" && "h-full")}>
            {hasRowDragHandle &&
              (isDragHandleDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      ref={dragHandleActivatorRef}
                      data-worktree-row-drag-handle=""
                      // Dimmed to the unavailable level, but only where the
                      // gesture would be tried: at rest during a search it ran a
                      // column of dead grips down every card.
                      className="shrink-0 w-4 flex items-center justify-center cursor-not-allowed opacity-0 group-hover/card:opacity-50 touch-none select-none transition-[color,opacity] motion-reduce:transition-none"
                      aria-hidden="true"
                    >
                      <GripVertical className="w-3 h-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {dragDisabledReason ?? "Drag to reorder is off"}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div
                  ref={dragHandleActivatorRef}
                  data-worktree-row-drag-handle=""
                  className={cn(
                    // Timing lives in sidebar.css: opacity needs the 75ms
                    // tier and the plate the 150ms one, and a Tailwind
                    // `duration-*` utility cannot give two properties two
                    // durations.
                    "shrink-0 w-4 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none",
                    isDraggingSort
                      ? "bg-overlay-emphasis text-text-primary"
                      : // Card hover brightens the glyph only. The backplate
                        // used to come with it, and since the grip is a
                        // full-height column that painted a bar down the whole
                        // card — the most prominent thing on a row whose point
                        // is the worktree, for a control most hovers never
                        // wanted. The plate now waits for the pointer to
                        // actually reach the grip.
                        // Two stages, and they are different questions. The
                        // dots answer "can this be dragged?" — the card is the
                        // right scope for that, so they fade in with it and
                        // are absent at rest. The column plate answers "am I
                        // about to drag?" and only the grip itself can answer
                        // that; painting it on card hover ran a lit bar down
                        // the whole card for a control most hovers never
                        // wanted.
                        "opacity-0 text-text-muted group-hover/card:opacity-100 hover:bg-overlay-soft hover:text-text-secondary hover:opacity-100"
                  )}
                  // Pointer-only affordance: the grip is non-focusable (the row
                  // strips dnd-kit's role/tabIndex), so an aria-label here is
                  // dead ARIA claiming a phantom control. Keyboard reorder is
                  // the row's Alt+Arrow path (aria-keyshortcuts on the row).
                  aria-hidden="true"
                  {...dragHandleListeners}
                >
                  {/* Centred in the column, not pinned to the title row.
                      Once the column paints a plate down the full height of
                      the card it is an object in its own right, and its
                      contents belong in the middle of it — dots hanging off
                      the top of a 160px bar read as misplaced rather than as
                      anchored. Products that align a grip to the title line
                      (Linear, Notion) do not paint that bar.

                      This is also the only version that needs no knowledge of
                      the header's height. Pinning to the title meant sizing a
                      box off a number the header owns, which drifts the moment
                      its trailing buttons change — it was already 2.5px out.
                      `items-center` on a stretched flex child has nothing to
                      drift from. */}
                  <GripVertical className="w-3 h-3" />
                </div>
              ))}
            {/* One content column for the whole card, header and body alike,
                and one column for every card in the list. The grip is a
                sibling of this column rather than something the header pads
                around, so the header used to indent past it while the body
                indented past nothing, and the main worktree — which has no
                grip at all — indented past neither. Three columns in one
                list. Now the grip's own 16px IS the inset when it is there,
                and ps-4 stands in for it when it is not, so text starts on
                the same x in every card and the grip column can run the card
                top to bottom. */}
            <div
              className={cn(
                "flex-1 min-w-0",
                // Grid: a column, so the status block can be pushed to the
                // card's bottom edge and every card in a row ends level.
                variant === "grid" && "flex h-full flex-col",
                // Logical, not `pl-*`/`pr-*`: when there is no grip this padding
                // IS the gutter, so under RTL it has to move to the side the
                // grip would have been on. A physical padding would leave every
                // gripless card indented from the wrong edge.
                hasRowDragHandle ? "ps-0" : "ps-4",
                "pe-4"
              )}
            >
              {/* Expanded, top padding only: the body below supplies the gap
                  to the next row. Both spending 8px put 16px between the branch
                  line and the commit row, which read as a break in the middle of
                  one cluster rather than as the space between two.

                  The sidebar's 12px (here and as the body's bottom padding) is
                  the card's outer edge, and it has to be the largest gap on the
                  card: 4px inside the identity rows, 8px before the activity
                  row, 12px to the divider. At 8px the edge was barely wider than
                  the gaps inside, so the divider alone said where a card ended.

                  Collapsed, there is no body below, so nothing supplies the
                  bottom gap and this padding is the card's whole vertical
                  budget: `pt-2` alone made the header row the card's full
                  height plus 8px of ceiling and no floor. Everything keyed to
                  the card rather than to the row then landed 4px high — the
                  drag grip, which is a stretched sibling column centring itself
                  in the card, most visibly of all, since a one-line row is
                  exactly where a 4px error between the grip and the label it
                  sits beside has nothing else to hide behind. Splitting the
                  same 8px across both ends keeps the collapsed card's height
                  (4 + 26 + 4) and puts the SINGLE-LINE collapsed card's row and
                  grip on one centre line.

                  Two lines — the sub-line is open — is a different shape, and
                  the grip goes on centring on the card while the row's own
                  centre moves down. That is the same split an expanded card
                  already has. The sub-line's own bottom padding moved here with
                  it, so that shape stays symmetric too.

                  The grid reserves the membership toggle's column here, on the
                  header block alone, not on the whole content column. The
                  toggle sits in the card's top-right corner, so a reservation
                  that ran the full height of the column narrowed every row
                  below it against a control that was never beside them — the
                  commit line and the terminal section stopped short of the
                  card's right edge for no reason a reader could see. It stays
                  reserved unconditionally rather than on hover: a slot that
                  appears when the pointer arrives shifts the header sideways
                  under the cursor. */}
              <div
                className={cn(
                  effectiveIsCollapsed
                    ? "py-1"
                    : variant !== "sidebar"
                      ? "pt-2"
                      : isCompactCard
                        ? "pt-3"
                        : "pt-3.5",
                  variant === "grid" && "pr-5"
                )}
              >
                <WorktreeHeader
                  worktree={worktree}
                  isActive={isActive}
                  variant={variant}
                  density={cardDensity}
                  isMuted={isMuted}
                  isProjectNotificationsMuted={isProjectNotificationsMuted}
                  isMainWorktree={isMainWorktree}
                  isMainOnStandardBranch={isMainOnStandardBranch}
                  isPinned={isPinned}
                  isCollapsed={effectiveIsCollapsed}
                  // The grid's cursor reveals a row's marks the way Tab focus
                  // on its select button used to, now that arrows move a
                  // virtual cursor and the button is not a tab stop.
                  isKeyboardFocused={isSelectFocusVisible || isKeyboardCursor}
                  canCollapse={canCollapse}
                  onToggleCollapse={handleToggleCollapse}
                  contentId={`worktree-body-${worktree.id}`}
                  branchLabel={branchLabel}
                  customTitle={customTitle}
                  worktreeLabel={ariaName}
                  sessionStates={terminalCounts.byState}
                  sessionTotal={terminalCounts.total}
                  sessionUnread={terminalCounts.unread}
                  sessionBlocked={terminalCounts.blocked}
                  environmentIcon={environmentIcon}
                  isLifecycleRunning={isLifecycleRunning}
                  resourceStatusLabel={resourceStatusLabel}
                  resourceStatusColor={resourceStatusColor}
                  resourceLastOutput={worktree.resourceStatus?.lastOutput}
                  resourceEndpoint={worktree.resourceStatus?.endpoint}
                  resourceLastCheckedAt={worktree.resourceStatus?.lastCheckedAt}
                  devServerSession={devServerSession}
                  onCheckResourceStatus={hasStatusCommand ? handleResourceStatus : undefined}
                  onPreviewEndpoint={handlePreviewEndpoint}
                  onOpenOnHost={
                    canOpenResourceBoxOnHost(worktree.resourceStatus?.ssh)
                      ? handleResourceOpenOnHost
                      : undefined
                  }
                  onAttachmentAction={handleAttachmentAction}
                  onCleanupWorktree={
                    chipState === "cleanup" && !isMainWorktree
                      ? () => setShowDeleteDialog(true)
                      : undefined
                  }
                  badges={{
                    onOpenIssue: worktree.issueNumber ? handleOpenIssueExternal : undefined,
                    onOpenPR: worktree.linked?.pr ? handleOpenPRExternal : undefined,
                    onOpenPlan: openPlanFileForThisWorktree,
                  }}
                  gitStateIndicator={gitStateIndicator}
                  lifecycleAlarm={lifecycleAlarm}
                  gitStateShownInBody={gitStateShownInBody}
                  lifecycleAlarmShownInBody={lifecycleAlarmShownInBody}
                  quietGit={quietGit}
                  menu={menuActions}
                />

                <FocusedSubLine
                  open={!isMainWorktree && effectiveIsCollapsed && (isActive || isFocused)}
                  changedFileCount={worktree.worktreeChanges?.changedFileCount}
                  lastActivityTimestamp={worktree.lastActivityTimestamp}
                  statusLabel={lifecycleLabel ?? resourceStatusLabel ?? null}
                />
              </div>

              {/* Compact pt-1: with the Details row's own 4px that is 8px
                  between the identity rows and the activity row, twice the 4px
                  between the identity rows themselves, so the card reads as two
                  groups rather than three equal lines. Comfortable keeps the
                  same ratio at its own scale: 12px against its 4px line gap,
                  and 14px at the card's edges so the edge stays the largest
                  gap on the card. The grid's pt-2 does the same job against
                  its taller metadata stack. */}
              {!effectiveIsCollapsed && (
                <div
                  id={`worktree-body-${worktree.id}`}
                  className={cn(
                    variant !== "sidebar"
                      ? "pb-2.5 pt-2"
                      : isCompactCard
                        ? "pb-3 pt-1"
                        : "pb-3.5 pt-2",
                    // The pinned main card never scrolls with the list, so an
                    // opened Details or Sessions could take the whole sidebar
                    // and leave the list no room. It scrolls inside itself
                    // past half the window instead.
                    variant === "sidebar" &&
                      isMainWorktree &&
                      (isExpanded || isTerminalsExpanded) &&
                      "max-h-[50vh] overflow-y-auto overscroll-contain"
                  )}
                >
                  {worktree.isWslPath && !worktree.wslGitOptIn && !worktree.wslGitDismissed && (
                    <WslGitBanner
                      worktreeId={worktree.id}
                      wslDistro={worktree.wslDistro}
                      wslGitEligible={worktree.wslGitEligible}
                    />
                  )}
                  {/* Stacked below 20rem, where one row cannot hold a summary,
                      a time and the sessions trigger without losing the words. */}
                  <div
                    className={cn(
                      (isSessionsFooterInline || reservesSessionsSlot) &&
                        "flex flex-col @xs/card:flex-row @xs/card:flex-wrap @xs/card:items-center @xs/card:gap-x-1"
                    )}
                  >
                    <div
                      className={cn(
                        (isSessionsFooterInline || reservesSessionsSlot) && "min-w-0 flex-1"
                      )}
                    >
                      <WorktreeDetailsSection
                        variant={variant}
                        worktree={worktree}
                        homeDir={homeDir}
                        isExpanded={isExpanded}
                        hasChanges={hasChanges}
                        computedSubtitle={computedSubtitle}
                        reviewState={reviewState}
                        effectiveNote={effectiveNote}
                        effectiveSummary={effectiveSummary}
                        worktreeErrors={worktreeErrors}
                        isFocused={isFocused}
                        isStale={isStaleCard}
                        worktreeLabel={ariaName}
                        onToggleExpand={handleToggleExpand}
                        onPathClick={openFileBrowserForThisWorktree}
                        onDismissError={dismissError}
                        onRetryError={handleErrorRetry}
                        onOpenReviewHub={openReviewHubForThisWorktree}
                        quietGitDetail={
                          quietGit ? (
                            <QuietGitDetails
                              worktree={worktree}
                              branchLabel={branchLabel}
                              isActive={isActive}
                              worktreeLabel={ariaName}
                              onOpenIssue={
                                worktree.issueNumber ? handleOpenIssueExternal : undefined
                              }
                              onOpenPR={worktree.linked?.pr ? handleOpenPRExternal : undefined}
                            />
                          ) : undefined
                        }
                        isLifecycleRunning={isLifecycleRunning}
                        lifecycleLabel={lifecycleLabel}
                        isBeingDeleted={isBeingDeleted}
                        deleteError={deleteError}
                        hasResourceConfig={hasResourceConfig}
                        resourceStatus={worktree.resourceStatus?.lastStatus}
                        onResourceResume={hasResumeCommand ? handleResourceResume : undefined}
                        onResourcePause={hasPauseCommand ? handleResourcePause : undefined}
                        onResourceConnect={
                          worktree.resourceConnectCommand ? handleResourceConnect : undefined
                        }
                        onResourceProvision={
                          hasProvisionCommand ? handleResourceProvision : undefined
                        }
                        onResourceTeardown={hasTeardownCommand ? handleResourceTeardown : undefined}
                        onResourceStatus={hasStatusCommand ? handleResourceStatus : undefined}
                        syncDetail={
                          variant === "sidebar" &&
                          !quietGit &&
                          !isMainWorktree &&
                          (isCompactCard || !syncLineHasNews(worktree)) ? (
                            <QuietGitDetails
                              worktree={worktree}
                              branchLabel={branchLabel}
                              isActive={isActive}
                              syncOnly
                            />
                          ) : undefined
                        }
                      />
                    </div>

                    <WorktreeTerminalSection
                      variant={variant}
                      worktreeId={worktree.id}
                      worktreeLabel={ariaName}
                      onStartSession={() => handleOpenPanelPalette("user")}
                      isExpanded={isTerminalsExpanded}
                      inline={isSessionsFooterInline}
                      stateGlyphsElsewhere={variant === "sidebar"}
                      counts={terminalCounts}
                      terminals={worktreeTerminals}
                      onToggle={handleToggleTerminals}
                      onTerminalSelect={handleTerminalSelect}
                    />
                    {reservesSessionsSlot && (
                      <div
                        aria-hidden="true"
                        className="hidden w-[3.625rem] shrink-0 @xs/card:block"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {(deleteError || issueError) && (
            // Inside the card's own gutter, so a failure reads as belonging to
            // the card above it rather than as a band between two cards. A
            // control region: its message is there to be read and copied, and
            // pressing in it is never a request to switch worktrees.
            <div data-card-control="" className={cn(variant === "sidebar" && "px-3 pb-2.5")}>
              {deleteError && (
                <WorktreeDeleteErrorBanner
                  message={deleteError}
                  onRetry={handleRetryDelete}
                  onDismiss={handleDismissDeleteError}
                />
              )}

              {issueError && (
                <WorktreeIssueErrorBanner
                  message={issueError.message}
                  mutationType={issueError.type}
                  onRetry={handleRetryIssue}
                  onDismiss={handleDismissIssueError}
                />
              )}
            </div>
          )}

          <WorktreeDialogs
            worktree={worktree}
            confirmDialog={confirmDialog}
            onCloseConfirm={closeConfirmDialog}
            showDeleteDialog={showDeleteDialog}
            onCloseDeleteDialog={() => setShowDeleteDialog(false)}
            showIssuePicker={showIssuePicker}
            onCloseIssuePicker={() => setShowIssuePicker(false)}
            onAttachIssue={handleAttachIssue}
            onDetachIssue={handleDetachIssue}
            showTitleDialog={showTitleDialog}
            onCloseTitleDialog={() => setShowTitleDialog(false)}
            customTitle={customTitle}
            restoreTitleDialogFocusTo={resolveTitleDialogRestore}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <WorktreeMenuItems
          worktree={worktree}
          components={CONTEXT_COMPONENTS}
          isPinned={isPinned}
          {...menuActions}
          viewSubmenu={
            variant === "sidebar" ? (
              <WorktreeDensitySubmenu key="view" iconClassName="mr-2 h-3.5 w-3.5 shrink-0" />
            ) : undefined
          }
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  return cardContent;
}
