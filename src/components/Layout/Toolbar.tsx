import {
  Suspense,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  PanelLeftOpen,
  PanelLeftClose,
  MonitorPlay,
  Pencil,
  Pin,
  PinOff,
  Copy,
  Settings,
  CircleStop,
  X,
  Check,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { BrandSurface, FolderTree, Folders } from "@/components/icons";
import { buildPluginToolbarMeta } from "./pluginToolbarMeta";
import { getToolbarDividerAfterIds, toolbarDividerRun } from "./toolbarButtonGrouping";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { ToolbarButtonsContextMenu } from "./ToolbarButtonsContextMenu";
import { cn } from "@/lib/utils";
import { isMac, isLinux, isWindows } from "@/lib/platform";
import { WINDOWS_CAPTION_WIDTH_PX } from "@shared/config/windowChrome";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AgentButton } from "./AgentButton";
import {
  PluginToolbarButton,
  PluginTrayButton,
  groupPluginToolbarButtons,
} from "./PluginTrayButton";
import { LAUNCHER_PANEL_ITEMS } from "./launcherPanelItems";
import { deriveAgentAttentionStates } from "@/lib/agentAttentionStates";
import { useHandBackRunIds } from "@/hooks/useRunHandBackState";
import { DockLaunchButton } from "./DockLaunchButton";
import { useRecipeStore } from "@/store/recipeStore";
import { useLauncherData } from "./useLauncherData";
import {
  activateDockLaunchItem,
  panelPrecondition,
  useDockLaunchModel,
  type ActivateDockLaunchItemContext,
  type DockLaunchAgentOptions,
} from "./dockLaunchItems";
import {
  buildLauncherToolbarMeta,
  collidingRecipeNames,
  useLauncherToolbarCatalog,
} from "./launcherToolbarCatalog";
import { LauncherToolbarButton } from "./LauncherToolbarButton";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { ProjectPluginMenuItems } from "@/components/Plugin/ProjectPluginMenuItems";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  useToolbarOverflow,
  withDemotedOverflow,
  withLitSignalPriorities,
} from "@/hooks/useToolbarOverflow";
import { useProjectToolbarOverlay, useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useWindowFullscreen } from "@/hooks/useWindowFullscreen";
import {
  useAriaKeyshortcuts,
  useDohertyGate,
  useEffectiveCombo,
  useShortcutHintHover,
} from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { activeWorkspaceIdentity } from "@/lib/workspaceIdentity";
import { usePreferencesStore, useToolbarPreferencesStore, useVoiceRecordingStore } from "@/store";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useAgentToolbarPinsStore } from "@/store/agentToolbarPinsStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useCanopyStore } from "@/store/canopyStore";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { useVisiblePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useShallow } from "zustand/react/shallow";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { notify } from "@/lib/notify";
import type { CliAvailability } from "@shared/types";
import { agentToolbarPin } from "@shared/types/ipc/agentToolbarPins";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { LazyProjectIdentityEditor, LazyProjectSwitcherPalette } from "@/lazyPanels";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { ToolbarProjectPillTooltipBody } from "./ToolbarProjectPill";
import { HostChip } from "@/components/Hosts/HostChip";
import { AttachedMachinesIndicator } from "@/components/Hosts/AttachedMachinesIndicator";
import { getViewHostId } from "@/hooks/useHostConnection";
import { ForgeStatsToolbarButton, type ForgeStatsHandle } from "./ForgeStatsToolbarButton";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { NotificationCenterToolbarButton } from "./NotificationCenterToolbarButton";
import { CanopyToolbarButton, useCanopyUrgentCount } from "./CanopyToolbarButton";
import { AppMenuButton } from "./AppMenuButton";
import { ToolbarLauncherButton } from "./ToolbarLauncherButton";
import { ToolbarCommandPaletteButton } from "./ToolbarCommandPaletteButton";
import { ResumeSessionsToolbarButton } from "./ResumeSessionsToolbarButton";
import { ToolbarSettingsButton } from "./ToolbarSettingsButton";
import { ToolbarProblemsButton } from "./ToolbarProblemsButton";
import { HostMemoryPauseIndicator } from "./HostMemoryPauseIndicator";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { ToolbarPortalButton } from "./ToolbarPortalButton";
import { ToolbarAssistantButton } from "./ToolbarAssistantButton";
import { type OverflowBadgeSeverity } from "./useOverflowBadgeSeverity";
import { CopyTreeMenuContent } from "@/components/CopyTree/CopyTreeRecentsPanel";
import { useCopyTreeCompletionNotice } from "@/hooks/useCopyTreeCompletionNotice";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";
import type { CopyTreeHistoryRecord } from "@shared/types";

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { toolbarIconButtonClass } from "./toolbarItemClasses";
import {
  OVERFLOW_KEYBINDING_BY_ID,
  OverflowMenu,
  type OverflowMenuProps,
} from "./ToolbarOverflowMenu";

import { PROJECT_SCOPED_TOOLBAR_IDS, useToolbarItemPlacement } from "./useToolbarItemPlacement";
import { useToolbarOverflowStatus } from "./useToolbarOverflowStatus";
import { useToolbarOverflowEviction } from "./useToolbarOverflowEviction";
import { useToolbarCustomization } from "./useToolbarCustomization";
import { useToolbarProjectPill } from "./useToolbarProjectPill";
import { ForgeStatsPlaceholder } from "./ForgeStatsPlaceholder";

export { OVERFLOW_MENU_META } from "./ToolbarOverflowMenu";

// The same box as the `size="icon"` button it stands in for, so the overflow
// budget and the row height it reserves are the button's, not 4px more.
function DevServerPlaceholder() {
  return (
    <div
      className={cn(toolbarIconButtonClass, "h-8 w-8 opacity-0 pointer-events-none")}
      aria-hidden="true"
    />
  );
}

interface ToolbarProps {
  onLaunchAgent: (type: string) => void;
  onSettings: () => void;
  onPreloadSettings?: () => void;
  errorCount?: number;
  onToggleProblems?: () => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  /**
   * Whether this view owns a workspace of any kind. The sidebar toggle degrades
   * to disabled without one — there is no slot for it to reveal (#11499).
   */
  hasWorkspace: boolean;
  agentAvailability?: CliAvailability;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
}

export function Toolbar({
  onLaunchAgent,
  onSettings,
  onPreloadSettings,
  errorCount = 0,
  onToggleProblems,
  isFocusMode = false,
  onToggleFocusMode,
  hasWorkspace,
  agentAvailability,
  projectSwitcherPalette,
}: ToolbarProps) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  // This project's presentation profile (#13771). Demoted folds the pill into
  // the `…` menu; hidden drops its slot. A folder without a repository
  // resolves to hidden at any level: it has nothing to count.
  const presentation = useResolvedPresentation();
  const forgeStatsLevel = presentation.forgeStats;
  // This view's own workspace, not the broadcast `currentProject`, which a
  // scratch never gets: once the view resolves to a workspace without a
  // repository the slot goes, rather than holding its placeholder for good
  // (#15931). Until the view resolves either way, the placeholder stays.
  const workspaceRoot = useWorkspaceRoot();
  const forgeStatsHidden =
    workspaceRoot?.isGitBacked === false ||
    (currentProject !== null && forgeStatsLevel === "hidden");
  // "Use this project's toolbar" (#13783): demoted buttons fold into `…`,
  // explicitly shown ones and promoted plugin buttons claim a slot. All of it
  // is applied at the render boundary; the app-wide layout is never written.
  const toolbarOverlay = useProjectToolbarOverlay();
  const projectToolbarMode = currentProject !== null && toolbarOverlay.active;
  const profileLevels = useProjectPresentationStore((s) => s.levels);
  const branchChipDemoted = currentProject !== null && presentation.branchChip === "demoted";
  // The dev preview is the project's to show or hide on every surface (#14069),
  // whatever "Use this project's toolbar" says. Hidden drops the button and its
  // overflow row; an explicit shown or demoted puts the button on this
  // project's toolbar even where the app-wide layout has no slot for it. A
  // detected default never adds one: it can only take a leftover away.
  const devPreviewHidden = currentProject !== null && presentation.devServer === "hidden";
  const explicitDevPreviewLevel = toolbarOverlay.available ? profileLevels.devServer : undefined;
  const devPreviewPlaced =
    explicitDevPreviewLevel === "shown" || explicitDevPreviewLevel === "demoted";
  const workspaceIdentity = activeWorkspaceIdentity(currentProject, currentScratch);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const { entry: forgeProviderEntry } = useResolvedForgeProvider(currentProject?.id ?? null);
  const forgeProviderName = forgeProviderEntry?.contribution.name ?? null;
  const projectSwitcher = projectSwitcherPalette;
  // Read from the store rather than `projectSwitcher.activeProject`, whose
  // counts are held while the switcher is closed — which is when this pill's
  // menu opens.
  const activeProjectHasProcesses = useProjectStatsStore((state) =>
    currentProject ? (state.stats[currentProject.id]?.processCount ?? 0) > 0 : false
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );
  // Copy context's target: the active worktree, or else the workspace root of
  // a scratch or a project whose worktree list loaded empty — a non-git folder
  // (#13210). A git project still loading has neither yet.
  const worktreeListEmpty = useWorktreeStore(
    (state) => state.isInitialized && state.worktrees.size === 0
  );
  const canCopyTree =
    Boolean(activeWorktree) || (hasWorkspace && (!currentProject || worktreeListEmpty));
  const branchName = activeWorktree?.branch;
  const watcherDegraded = useWorktreeStore((state) => state.watcherDegraded);
  const topologyWatcherDark = useWorktreeStore((state) => state.topologyWatcherDark);
  // The Problems button's own wording for the two, so its row in `…` and the
  // trigger's name say what the button would.
  const watcherStatus = watcherDegraded
    ? "File watching degraded"
    : topologyWatcherDark
      ? "Worktree list may be stale"
      : null;
  // Read here as well as in the indicator, so its arrival or departure re-renders
  // the toolbar and the roving tab-stop sync below sees the item list change.
  const hostMemoryPauseVisible = useHostMemoryPauseStore((state) => state.visible);

  // Per-item state for the overflow menu, so evicted buttons keep the signal
  // they carry on the visible toolbar (issue #9821). Reads mirror the
  // selectors used by the source buttons (NotificationCenterToolbarButton,
  // AgentButton) rather than extending useOverflowBadgeSeverity to return a
  // composite map (would risk the selector-identity churn of lesson #3730).
  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const canopyUrgentCount = useCanopyUrgentCount();
  // Per-agent pip state across panels in the active worktree, used to draw
  // the agent-state dot on overflow menu items. Shares the launcher's
  // derivation so the overflow dot matches the visible agent button; computed
  // inside useShallow so agent ticks that don't change a pip state don't
  // re-render the whole toolbar (issue #7451 pattern).
  const handBackRunIds = useHandBackRunIds();
  const agentAttentionStates = usePanelStore(
    useShallow((s) =>
      deriveAgentAttentionStates(s.panelsById, s.panelIds, activeWorktreeId, handBackRunIds)
    )
  );

  useEffect(() => {
    // When the boot payload already seeded the store (#10390), skip the
    // redundant initial getAll/getCurrent pair and only run the background
    // missing-directory validation that boot data can't replace. The
    // getCurrentProject() escape hatch covers project-scoped views that boot
    // before main binds them to a project (retry loop in projectStore).
    const {
      isBootstrapped,
      currentProject: seededProject,
      checkMissingProjects,
    } = useProjectStore.getState();
    if (isBootstrapped) {
      if (!seededProject) {
        void getCurrentProject();
      }
      void checkMissingProjects();
    } else {
      loadProjects();
      getCurrentProject();
    }

    const cleanup = projectClient.onSwitch(() => {
      getCurrentProject();
      loadProjects();
    });

    return cleanup;
  }, [loadProjects, getCurrentProject]);

  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);
  const canopyHidden = useCanopyStore((s) => s.mode === "hidden");
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);
  const positionAgentButton = useToolbarPreferencesStore((state) => state.positionAgentButton);
  // This machine's pins (#14702), live, so a pin from the launcher or another
  // view shows here at once.
  const agentPins = useAgentToolbarPinsStore((s) => s.pins);

  const isFullscreen = useWindowFullscreen();
  // Store-derived rather than local click state so every clipboard copy spins
  // the button — an MCP or assistant dispatch runs the same bracketed actions
  // a click does, and this button is the one place that work is visible.
  const isCopyingTree = useCopyTreeRunStore((s) => s.activeRunCount > 0);
  const showCopyingSpinner = useDohertyGate(isCopyingTree);
  // The tooltip's ordinary hover state — the Radix root is controlled with the
  // union of this and the completion notice below, so a completion can force
  // it open while hover keeps working through onOpenChange.
  const [copyTreeTooltipHovered, setCopyTreeTooltipHovered] = useState(false);
  // Local to the toolbar — the panel has no palette entry or action of its own,
  // so nothing outside this component needs to open it (#11733).
  const [copyTreeOpen, setCopyTreeOpen] = useState(false);
  const copyTreeButtonRef = useRef<HTMLButtonElement>(null);
  // Completion feedback for copy-tree runs — the clipboard copies and the
  // temp-file bundle agents generate: the action layer announces every finished
  // run (announceCopyTreeCopy) and this hook's presenter pins it to the button
  // as a short-lived tooltip, falling back to notify() whenever the button
  // can't anchor one. Suppressed while the recents panel is open — both portal
  // to the same anchor, and an MCP completion landing mid-browse would stack
  // the tooltip on the panel.
  const {
    notice: copyTreeNotice,
    announcement: copyTreeAnnouncement,
    clearNotice: clearCopyTreeNotice,
  } = useCopyTreeCompletionNotice(copyTreeButtonRef, { suppress: copyTreeOpen });
  // A new run supersedes the last one's confirmation — from every route, not
  // just this button's menu, which already clears it on open. Left standing, a
  // run that then fails would hand the check back to the earlier success. On
  // the store's own start rather than the rendered flag, so a run that begins
  // and settles before a render still retires it, and the clear can't land
  // after that run's own announcement.
  useEffect(
    () =>
      useCopyTreeRunStore.subscribe((state, prev) => {
        if (state.activeRunCount > prev.activeRunCount) clearCopyTreeNotice();
      }),
    [clearCopyTreeNotice]
  );

  // A session another view is running counts too: the button is where this
  // view reveals, pauses or stops it.
  const hasActiveVoiceRecording = useVoiceRecordingStore(
    (state) =>
      state.sessionElsewhere !== null ||
      state.lockedTarget !== null ||
      state.pendingTarget !== null ||
      (state.activeTarget !== null &&
        (state.status === "arming" ||
          state.status === "connecting" ||
          state.status === "recording" ||
          state.status === "reconnecting" ||
          state.status === "paused" ||
          state.status === "finishing"))
  );

  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const activeToolbarIndexRef = useRef<number>(0);
  // Tracks the last toolbar item that received focus. Read in the
  // layout-effect tab-stop sync to detect when that item has been evicted
  // (moved into overflow or unmounted) — in that case the browser drops
  // focus to document.body, and we redirect it to the overflow trigger or
  // nearest visible item to preserve keyboard navigation (WCAG 2.4.3).
  const prevFocusedToolbarItemRef = useRef<HTMLElement | null>(null);
  const forgeStatsRef = useRef<ForgeStatsHandle>(null);
  const [forgeDataUnavailable, setForgeDataUnavailable] = useState(false);

  const { handleCopyTree, handleCopyTreeWithOptions } = useWorktreeActions();
  const sidebarShortcut = useEffectiveCombo("nav.toggleSidebar");
  const copyTreeCombo = useEffectiveCombo("worktree.copyTree");
  const devServerCombo = useEffectiveCombo("devServer.start");
  const fileBrowserCombo = useEffectiveCombo("worktree.openFileBrowserPanel");
  const sidebarAriaShortcut = useAriaKeyshortcuts("nav.toggleSidebar");
  const copyTreeAriaShortcut = useAriaKeyshortcuts("worktree.copyTree");
  const fileBrowserAriaShortcut = useAriaKeyshortcuts("worktree.openFileBrowserPanel");

  const sidebarHintHover = useShortcutHintHover("nav.toggleSidebar");
  const devServerHintHover = useShortcutHintHover("devServer.start");
  // No hover hint for copy-tree: the action sets `suppressShortcutHint`, and
  // per that field's contract an opted-out button skips this hook too — the
  // hover path teaches the same hint the dispatch path was opted out of, and an
  // already-shown one isn't dismissed by the click, so it would sit beside the
  // completion toast in the same corner. The tooltip still shows the shortcut.
  const fileBrowserHintHover = useShortcutHintHover("worktree.openFileBrowserPanel");

  // The one launcher button whose action can legitimately refuse: it resolves
  // its own target (focused worktree, else the project or scratch root), and a
  // workspace with nothing to browse makes it throw. `dispatch` turns that into
  // `ok: false` rather than a rejection, so without this the press would do
  // nothing at all. Mirrors `LauncherQuickActions`, which offers the same action.
  // A named function expression so the retry action can name itself.
  const openFileBrowser = useCallback(function openFileBrowser() {
    void actionService
      .dispatch("worktree.openFileBrowserPanel", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) return;
        // A full grid is the one refusal `addPanel` has already reported, with
        // an accurate message and the actual recovery. Saying "no folder
        // resolved" on top of it would name the wrong cause (#11666).
        if (isPanelLimitError(result.error.message)) return;
        notify({
          type: "error",
          title: "Couldn't open the file browser",
          message: "No folder resolved for this workspace. Select a worktree and try again.",
          // `uiFeedback` is a passive kind that resolves to `priority: "low"`
          // (inbox only), which would leave this refusal — and its Retry — with
          // no visible signal at all.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: openFileBrowser },
        });
      });
  }, []);

  // The shared launcher's own inventory and workspace context (#11691). The
  // toolbar had none of this before — its launcher owned every store read
  // itself — so it comes from the same hook the dock uses.
  const launcherData = useLauncherData();

  // Agents launched from the toolbar keep going through `agent.launch` with no
  // location override, so they land where they always have. The dock's copy of
  // the launcher passes its own callback and keeps landing in the dock — the
  // shared component decides how a row looks, never where it opens.
  const launchAgentFromToolbar = useCallback(
    (agentId: string, presetId?: string | null, options?: DockLaunchAgentOptions) => {
      void actionService.dispatch(
        "agent.launch",
        // `null` is the explicit-default sentinel and must survive into the
        // payload; `undefined` must leave the key off so the saved preset still
        // resolves. A `!= null` test here would collapse the two. A plugin
        // launch entry adds its first turn and nothing else.
        {
          agentId,
          ...(presetId !== undefined ? { presetId } : {}),
          ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
        },
        { source: "user" }
      );
    },
    []
  );

  const {
    handleOpenProjectSettings,
    handleStopProject,
    handleCloseProject,
    handleSleepProject,
    handleRestartProject,
    handleLocateProject,
    handleMoveOrRenameProject,
    handleRemoveConfirmClose,
    handleSelectNewWindow,
    isDropdownOpen,
    shouldMountProjectSwitcherDropdown,
    pillTooltipOpen,
    handlePillTooltipOpenChange,
    suppressPillTooltipForFocusRestore,
    handlePillDropdownClose,
    activeSearchableProject,
    pillBranchLabel,
    branchOverflowRow,
    handleCopyProjectPath,
    handlePillTogglePin,
    isIdentityEditorOpen,
    shouldMountIdentityEditor,
    handleEditProjectIdentity,
    handlePillContextMenuOpenChange,
    handlePillContextMenuCloseAutoFocus,
    handleIdentityEditorOpenChange,
    projectSwitcherTrigger,
  } = useToolbarProjectPill({
    projectSwitcher,
    currentProject,
    workspaceIdentity,
    activeWorktree,
    branchName,
    branchChipDemoted,
  });

  // Feedback is owned by the action layer, not inline state here: the
  // `worktree.copyTree` action brackets the shared run store (which drives the
  // spinner above) and announces its completion through the button's transient
  // tooltip, so every route — this handler, the overflow item, Cmd+Shift+C,
  // the palette, MCP — reports identically (#11735). This handler only guards
  // and dispatches.
  // With no worktree — a non-git project or a scratch — the copy targets the
  // workspace root instead (#13210); only "nothing to copy yet" declines.
  const handleCopyTreeClick = useCallback(() => {
    if (isCopyingTree || !canCopyTree) return;
    return handleCopyTree(activeWorktree ?? null, "toolbar");
  }, [isCopyingTree, canCopyTree, activeWorktree, handleCopyTree]);

  // The visible button opens the menu; it no longer copies. Every immediate
  // route is deliberately left alone: `Cmd+Shift+C` dispatches
  // `worktree.copyTree` without passing through here at all, and the overflow
  // item calls `handleCopyTreeClick` directly — a nested menu inside the
  // overflow menu isn't worth it (#11733).
  //
  // The guard sits on the open transition rather than on the trigger's
  // `disabled`: the button is deliberately `aria-disabled` so its tooltip
  // explaining why still shows on hover, and a truly disabled trigger
  // would fire no pointer events for it. Close is always honoured; the menu
  // primitive owns close-time focus, so nothing here restores it.
  const handleCopyTreeOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        if (isCopyingTree || !canCopyTree) return;
        // A lingering completion tooltip and the opening menu would anchor to
        // the same button; the click is also an acknowledgement of the notice.
        clearCopyTreeNotice();
      }
      setCopyTreeOpen(open);
    },
    [isCopyingTree, canCopyTree, clearCopyTreeNotice]
  );

  // Where focus goes when the menu closes because its button was evicted to
  // the overflow menu — set by the eviction effect, consumed once here.
  const copyTreeEvictionFocusRef = useRef<HTMLElement | null>(null);
  const handleCopyTreeCloseAutoFocus = useCallback((event: Event) => {
    const target = copyTreeEvictionFocusRef.current;
    if (!target) return;
    copyTreeEvictionFocusRef.current = null;
    // Radix would restore to the trigger, which is invisible by now. Deferred
    // a frame so it lands after the shared handler has armed tooltip
    // suppression — the wrapper runs this callback before that handler, and a
    // focus placed earlier would drag the overflow trigger's tooltip open.
    event.preventDefault();
    requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, []);
  const recordCopyTreeEvictionFocus = useCallback((target: HTMLElement | null) => {
    copyTreeEvictionFocusRef.current = target;
  }, []);

  // The menu's pinned entry: the old one-click behavior, now one row deeper.
  // Radix closes the menu on select; the handlers only dispatch.
  const handleCopyTreeFullContext = useCallback(() => {
    void handleCopyTreeClick();
  }, [handleCopyTreeClick]);

  // Project settings, on the Context tab — where the excludes, always-include
  // lists and size budgets that shape every copy actually live. Same
  // CustomEvent the `project.settings.open` action uses.
  const handleOpenContextSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "project:context" } })
    );
  }, []);

  // A recent entry. Replayed against the ACTIVE worktree — or the workspace
  // root when there is none — never the worktree stored on the record — the history dedupe key covers options alone, so a
  // record's worktree is whichever one ran it last rather than a stable target,
  // and it may name a worktree that has since been removed.
  const handleCopyTreeRunRecent = useCallback(
    (record: CopyTreeHistoryRecord) => {
      if (isCopyingTree || !canCopyTree) return;
      void handleCopyTreeWithOptions(activeWorktree ?? null, record.options, "toolbar");
    },
    [isCopyingTree, canCopyTree, activeWorktree, handleCopyTreeWithOptions]
  );

  // The anchor stops being interactive with nothing to copy or while a copy is
  // in flight (aria-disabled for the first, busy for the second), and the menu's entries
  // decline in both states — leaving it open would strand a dead menu over the
  // toolbar. The in-flight half matters because copies start without the
  // trigger: MCP and assistant dispatches, Cmd+Shift+C, and the palette can
  // all begin one while the menu is open.
  useEffect(() => {
    if ((!canCopyTree || isCopyingTree) && copyTreeOpen) setCopyTreeOpen(false);
  }, [canCopyTree, isCopyingTree, copyTreeOpen]);

  const getToolbarItems = useCallback(
    () =>
      toolbarRef.current
        ? Array.from(
            toolbarRef.current.querySelectorAll<HTMLElement>("[data-toolbar-item]:not([disabled])")
          ).filter(
            // Overflow-hidden buttons use `invisible absolute` Tailwind
            // classes plus aria-hidden="true" on their wrapper. visibility:
            // hidden alone does not null offsetParent, so the aria-hidden
            // ancestor check is the canonical "this item is overflow-hidden,
            // skip it" signal — without it, evicted items stay in the list,
            // get tabIndex assigned, and the overflow focus redirect can
            // never fire.
            (el) => el.offsetParent !== null && el.closest('[aria-hidden="true"]') === null
          )
        : [],
    []
  );

  const syncToolbarTabStops = useCallback((items: HTMLElement[], activeIdx: number) => {
    for (const el of items) el.tabIndex = -1;
    if (items[activeIdx]) items[activeIdx].tabIndex = 0;
  }, []);

  useLayoutEffect(() => {
    const items = getToolbarItems();
    if (items.length === 0) return;
    // An item that comes and goes ahead of the focused one — the host memory
    // pause indicator (#12375) — shifts every index after it, so follow the
    // element that holds focus rather than the index it used to have.
    const focusedIndex = items.findIndex((el) => el === document.activeElement);
    const clamped =
      focusedIndex !== -1
        ? focusedIndex
        : Math.min(activeToolbarIndexRef.current, items.length - 1);
    activeToolbarIndexRef.current = clamped;
    syncToolbarTabStops(items, clamped);

    const prevFocused = prevFocusedToolbarItemRef.current;
    if (prevFocused && !items.includes(prevFocused)) {
      // Clear the ref unconditionally on eviction. If the user has since
      // moved focus into a Radix portal (activeElement !== body), the
      // redirect below is skipped — but the ref must still be cleared so
      // a later unrelated re-render doesn't trigger a phantom redirect.
      prevFocusedToolbarItemRef.current = null;
      // Two shapes of "focus is about to be nowhere". The evicted button has
      // just gone `visibility: hidden`, but the browser only drops focus from
      // it at its next rendering update — after this layout effect — so at
      // this point it is still `activeElement` and the redirect has to fire
      // now, or focus lands on <body> with nothing left to catch it. The
      // body case covers an eviction whose fixup already ran (an unmount).
      if (document.activeElement === document.body || document.activeElement === prevFocused) {
        // Redirect to the overflow trigger on the SAME side as the
        // evicted item; falling back to the other side's trigger would
        // pull focus across the toolbar to the wrong group.
        const side = leftGroupRef.current?.contains(prevFocused) ? "left" : "right";
        const sideTrigger = toolbarRef.current?.querySelector<HTMLElement>(
          `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"]`
        );
        const redirect = sideTrigger && items.includes(sideTrigger) ? sideTrigger : items[clamped];
        redirect?.focus();
      }
    }
  });

  // A child can add or drop a control without the toolbar rendering — the
  // Forge capsule's rate-limit and PR-detection segments, a plugin button — and
  // a native button arrives with its own default Tab stop. Re-sync the roving
  // stops whenever the strip's controls change underneath it, so it stays one
  // Tab stop. The focus redirect stays with the layout effect above.
  useEffect(() => {
    const root = toolbarRef.current;
    if (!root) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const items = getToolbarItems();
        if (items.length === 0) return;
        const focusedIndex = items.findIndex((el) => el === document.activeElement);
        const index =
          focusedIndex !== -1
            ? focusedIndex
            : Math.min(activeToolbarIndexRef.current, items.length - 1);
        activeToolbarIndexRef.current = index;
        syncToolbarTabStops(items, index);
        // A focused control a child removed on its own drops focus to <body>
        // with no toolbar render to catch it; hand it to the nearest
        // survivor so arrow navigation still works.
        const prev = prevFocusedToolbarItemRef.current;
        if (prev && !items.includes(prev)) {
          prevFocusedToolbarItemRef.current = null;
          if (document.activeElement === document.body) items[index]?.focus();
        }
      });
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-hidden"],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [getToolbarItems, syncToolbarTabStops]);

  const handleToolbarFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const items = getToolbarItems();
      const idx = items.indexOf(target);
      if (idx !== -1) {
        activeToolbarIndexRef.current = idx;
        prevFocusedToolbarItemRef.current = target;
        syncToolbarTabStops(items, idx);
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  // Focus that leaves the strip for somewhere else lets go of the last item.
  // Without this, a button focused once and since left — the user clicked
  // into a terminal, or onto empty canvas — still counted as "the focused
  // item" when a narrowing window later evicted it, and the redirect below
  // dragged focus, its ring and its tooltip onto the `…` trigger unasked.
  // A blur to nowhere is checked a frame later: an eviction blurs to nowhere
  // too, and the layout effect has handled that one by then.
  const handleToolbarBlurCapture = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && toolbarRef.current?.contains(next)) return;
    const left = e.target as HTMLElement;
    if (next) {
      if (prevFocusedToolbarItemRef.current === left) prevFocusedToolbarItemRef.current = null;
      return;
    }
    requestAnimationFrame(() => {
      if (
        prevFocusedToolbarItemRef.current === left &&
        document.activeElement !== left &&
        left.isConnected &&
        left.closest('[aria-hidden="true"]') === null
      ) {
        prevFocusedToolbarItemRef.current = null;
      }
    });
  }, []);

  const handleToolbarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // React synthetic events bubble through the React tree, so keydowns
      // inside portaled children (Radix DropdownMenu/ContextMenu content
      // rendered in document.body) still reach this handler. The DOM
      // containment check excludes those — portal content is not a DOM
      // descendant of the toolbar — so Arrow keys inside an open menu can
      // navigate the menu instead of being stolen by toolbar roving focus.
      if (!toolbarRef.current?.contains(e.target as Node)) return;

      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const items = getToolbarItems();
      if (items.length === 0) return;

      const currentIdx = activeToolbarIndexRef.current;
      let newIdx: number | null = null;

      switch (e.key) {
        case "ArrowRight":
          newIdx = (currentIdx + 1) % items.length;
          break;
        case "ArrowLeft":
          newIdx = (currentIdx - 1 + items.length) % items.length;
          break;
        case "Home":
          newIdx = 0;
          break;
        case "End":
          newIdx = items.length - 1;
          break;
      }

      if (newIdx !== null) {
        e.preventDefault();
        activeToolbarIndexRef.current = newIdx;
        syncToolbarTabStops(items, newIdx);
        items[newIdx]!.focus();
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  // `shrink-0`: a 1px flex item is the first thing a squeezed row gives up,
  // and a group boundary that silently goes to zero width is worse than one
  // that costs the row a pixel.
  const toolbarDividerClass = "toolbar-divider w-px h-5 mx-1 shrink-0";
  // The two fixed dividers sit in the outer groups, whose `gap-1.5` already
  // supplies the 6px the measured rows' own `gap-0.5` + `mx-1` add up to;
  // an `mx-1` on top gave the launcher 10px on one side and 6px on the other.
  const toolbarFixedDividerClass = "toolbar-divider w-px h-5 shrink-0";

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = useVisiblePluginToolbarButtons();

  // Scopes a project-owned recipe's pin id — see `recipeToolbarSourceId`.
  const currentRecipeProjectId = useRecipeStore((s) => s.currentProjectId);

  // The same model the launcher builds, from the same inputs, so the toolbar
  // can never offer a button for a row the launcher isn't showing — or drop one
  // it is. `surface: "grid"` matches the launcher this toolbar renders.
  const launcherModel = useDockLaunchModel({
    agents: launcherData.agents,
    pinnedCount: launcherData.pinnedCount,
    activeWorktreeId: launcherData.activeWorktreeId,
    surface: "grid",
    agentInventoryState: launcherData.agentInventoryState,
    hasWorkspace: launcherData.hasWorkspace,
    hasProject: launcherData.hasProject,
  });
  const launcherCatalog = useLauncherToolbarCatalog(
    launcherModel.searchItems,
    currentRecipeProjectId
  );
  const recipeNameCollisions = useMemo(
    () => collidingRecipeNames(launcherCatalog),
    [launcherCatalog]
  );
  const launcherActivationContext = useMemo<ActivateDockLaunchItemContext>(
    () => ({
      cwd: launcherData.cwd,
      activeWorktreeId: launcherData.activeWorktreeId,
      recipeContext: launcherData.recipeContext,
      onLaunchAgent: launchAgentFromToolbar,
      // A toolbar click is as foreground as a launcher click; anything else and
      // the panel actions silently skip their focus handling.
      source: "user",
    }),
    [
      launcherData.cwd,
      launcherData.activeWorktreeId,
      launcherData.recipeContext,
      launchAgentFromToolbar,
    ]
  );
  const pluginMetaById = usePluginRuntimeStore((s) => s.pluginMetaById);

  const buttonRegistry = useMemo<
    Record<string, { render: () => React.ReactNode; isAvailable: boolean }>
  >(
    () => ({
      // Degraded rather than removed when there is no workspace: the welcome
      // screen has no sidebar slot to reveal, so an enabled toggle would flip
      // its own icon and aria-pressed over nothing (#11499). `aria-disabled`
      // rather than `disabled` so the tooltip carrying the reason still opens
      // — a browser drops pointer events on a disabled button. Label is
      // unchanged; only the tooltip explains.
      "sidebar-toggle": {
        render: () => (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                {...(hasWorkspace ? sidebarHintHover : {})}
                variant="ghost"
                size="icon"
                data-toolbar-item=""
                data-sidebar-toggle=""
                onClick={hasWorkspace ? onToggleFocusMode : undefined}
                aria-disabled={!hasWorkspace || undefined}
                className={cn(
                  toolbarIconButtonClass,
                  "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                )}
                aria-label="Toggle sidebar"
                aria-pressed={!isFocusMode}
                aria-keyshortcuts={sidebarAriaShortcut}
              >
                {isFocusMode ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hasWorkspace
                ? createTooltipContent(
                    isFocusMode ? "Show sidebar" : "Hide sidebar",
                    sidebarShortcut
                  )
                : "Open a project or scratch to use the sidebar"}
            </TooltipContent>
          </Tooltip>
        ),
        isAvailable: true,
      },
      launcher: {
        // Always available, unlike the plugin tray: its inventory is fixed, so
        // there is no empty state. Individual rows gate themselves instead.
        render: () => (
          <DockLaunchButton
            key="launcher"
            placement="toolbar"
            agents={launcherData.agents}
            pinnedCount={launcherData.pinnedCount}
            agentInventoryState={launcherData.agentInventoryState}
            hasWorkspace={launcherData.hasWorkspace}
            hasProject={launcherData.hasProject}
            activeWorktreeId={launcherData.activeWorktreeId}
            cwd={launcherData.cwd}
            recipeContext={launcherData.recipeContext}
            onLaunchAgent={launchAgentFromToolbar}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      ...Object.fromEntries(
        BUILT_IN_AGENT_IDS.map((id) => [
          id,
          {
            render: () => (
              <AgentButton
                key={id}
                type={id}
                availability={agentAvailability?.[id]}
                data-toolbar-item=""
              />
            ),
            isAvailable: isAgentToolbarVisible(
              agentToolbarPin(agentPins, id),
              agentAvailability?.[id]
            ),
          },
        ])
      ),
      terminal: {
        render: () => (
          <ToolbarLauncherButton
            key="terminal"
            type="terminal"
            onLaunchAgent={onLaunchAgent}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      browser: {
        render: () => (
          <ToolbarLauncherButton
            key="browser"
            type="browser"
            onLaunchAgent={onLaunchAgent}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      "file-browser": {
        // Deliberately not in PROJECT_SCOPED_TOOLBAR_IDS: the action browses the
        // project or scratch root when no worktree is selected (#11482), so
        // gating it on `currentProject` would disable it in exactly the
        // worktree-less workspaces where it still works. `hasWorkspace` is the
        // gate that does apply — with no workspace of any kind the action
        // resolves no folder at all and can only answer with an error toast, so
        // it degrades the same way the sidebar toggle above does (#11499).
        render: () => (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <span className="inline-flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      {...(hasWorkspace ? fileBrowserHintHover : {})}
                      variant="ghost"
                      size="icon"
                      data-toolbar-item=""
                      onClick={hasWorkspace ? openFileBrowser : undefined}
                      aria-disabled={!hasWorkspace || undefined}
                      className={cn(
                        toolbarIconButtonClass,
                        "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                      )}
                      aria-label="Browse files"
                      aria-keyshortcuts={fileBrowserAriaShortcut}
                    >
                      <FolderTree />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {hasWorkspace
                      ? createTooltipContent("Browse files", fileBrowserCombo)
                      : "Open a project or scratch to browse files"}
                  </TooltipContent>
                </Tooltip>
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              <ToolbarContextMenuItems buttonId="file-browser" side="left" />
            </ContextMenuContent>
          </ContextMenu>
        ),
        isAvailable: true,
      },
      "dev-server": {
        render: () =>
          currentProject ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="inline-flex">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        {...devServerHintHover}
                        variant="ghost"
                        size="icon"
                        data-toolbar-item=""
                        onClick={() =>
                          actionService.dispatch("devServer.start", undefined, { source: "user" })
                        }
                        className={toolbarIconButtonClass}
                        aria-label="Open dev preview"
                      >
                        <MonitorPlay />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {createTooltipContent("Open dev preview", devServerCombo)}
                    </TooltipContent>
                  </Tooltip>
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
                <ToolbarContextMenuItems buttonId="dev-server" side="left" />
              </ContextMenuContent>
            </ContextMenu>
          ) : (
            <DevServerPlaceholder />
          ),
        isAvailable: true,
      },
      "voice-recording": {
        // Slot is always available so the right-aligned items keep a stable
        // footprint when a session starts/stops (#8176). The button itself returns
        // an invisible placeholder when inactive (mirrors DevServerPlaceholder).
        render: () => <VoiceRecordingToolbarButton key="voice-recording" data-toolbar-item="" />,
        isAvailable: true,
      },
      "forge-stats": {
        // The button owns its own shape now: full three-segment pill with a
        // resolved forge provider, commits-only without one (commit count is
        // local git data). Placeholder (not removal) while no project has
        // resolved: the slot's no-drag rectangle must exist on first paint
        // regardless (PROJECT_SCOPED_TOOLBAR_IDS).
        // A profile that hides the pill drops its slot from the row instead
        // (see `isButtonShownOnToolbar`), so the button — and its stats
        // polling — never mounts. A workspace with no repository, a scratch
        // included, always drops it, so polling never starts for it (#11405).
        render: () =>
          currentProject && forgeStatsLevel !== "hidden" ? (
            <ForgeStatsToolbarButton
              key="forge-stats"
              ref={forgeStatsRef}
              currentProject={currentProject}
              onDataUnavailableChange={setForgeDataUnavailable}
              data-toolbar-item=""
            />
          ) : (
            <ForgeStatsPlaceholder />
          ),
        isAvailable: true,
      },
      canopy: {
        render: () => <CanopyToolbarButton key="canopy" data-toolbar-item="" />,
        // Hidden, the slot goes and the pin stays: showing Canopy again puts
        // the button back where it was.
        isAvailable: !canopyHidden,
      },
      "notification-center": {
        render: () => (
          <NotificationCenterToolbarButton key="notification-center" data-toolbar-item="" />
        ),
        isAvailable: notificationsEnabled,
      },
      "copy-tree": {
        render: () => (
          <div className="relative">
            {/* ContextMenu outermost and DropdownMenu inside it, both triggers
                composed straight onto the Button. The two wrappers publish the
                same OverlayFocusRestoreContext and a trigger registers with
                the NEAREST provider — so with ContextMenu nested inside
                DropdownMenu (the PluginTrayButton shape) the dropdown's trigger
                lands on the context menu's restore state, and a pointer pick
                in the menu drops focus on <body>. This order gives the
                dropdown — the button's whole job — the correct provider. */}
            <ContextMenu>
              <DropdownMenu open={copyTreeOpen} onOpenChange={handleCopyTreeOpenChange}>
                {/* Controlled union: hover opens through onOpenChange as
                    normal, while a completion notice forces the tooltip open
                    for its short display window — the whole feedback for a
                    finished copy, in place of a toast. Close requests clear
                    the notice too, so Escape, a click, and the shared
                    dialog-transition dismissal can end the window early
                    instead of being overridden by the forced half of the
                    union. The shared auto-dismiss is off while a notice is up:
                    its timer arms on the open transition, so a completion that
                    lands mid-hover would inherit whatever's left of the hover
                    window instead of getting the notice's own. Hover-only opens
                    keep the shared window. */}
                <Tooltip
                  autoDismiss={copyTreeNotice === null}
                  open={copyTreeTooltipHovered || copyTreeNotice !== null}
                  onOpenChange={(open) => {
                    setCopyTreeTooltipHovered(open);
                    if (!open) clearCopyTreeNotice();
                  }}
                >
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <ContextMenuTrigger asChild>
                        <Button
                          ref={copyTreeButtonRef}
                          variant="ghost"
                          size="icon"
                          data-toolbar-item=""
                          // Busy is the spinner, not a dim: a copy in flight keeps
                          // the button at full strength and the handlers veto a
                          // second run. Only "nothing to copy" is unavailable.
                          aria-disabled={!canCopyTree || undefined}
                          aria-busy={isCopyingTree || undefined}
                          className={cn(
                            toolbarIconButtonClass,
                            "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                          )}
                          aria-label={isCopyingTree ? "Copying…" : "Copy context"}
                          aria-keyshortcuts={copyTreeAriaShortcut}
                        >
                          {showCopyingSpinner ? (
                            <Spinner />
                          ) : copyTreeNotice && !isCopyingTree ? (
                            // Same Copy→Check swap as CopyButton, held for the
                            // notice's window so the glyph and the tooltip
                            // clear together.
                            <Check className="animate-checkbox-check" />
                          ) : (
                            <Folders />
                          )}
                        </Button>
                      </ContextMenuTrigger>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {copyTreeNotice ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{copyTreeNotice.title}</span>
                        <span className="text-text-secondary">{copyTreeNotice.message}</span>
                      </span>
                    ) : isCopyingTree ? (
                      "Copying…"
                    ) : !hasWorkspace ? (
                      "Open a project or scratch first"
                    ) : !canCopyTree ? (
                      "Open a worktree first"
                    ) : (
                      createTooltipContent("Copy context", copyTreeCombo)
                    )}
                  </TooltipContent>
                </Tooltip>
                <CopyTreeMenuContent
                  shortcut={copyTreeCombo}
                  onCopyFullContext={handleCopyTreeFullContext}
                  onRunRecent={handleCopyTreeRunRecent}
                  onOpenContextSettings={currentProject ? handleOpenContextSettings : undefined}
                  onCloseAutoFocus={handleCopyTreeCloseAutoFocus}
                />
              </DropdownMenu>
              <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
                <ToolbarContextMenuItems buttonId="copy-tree" side="right" />
              </ContextMenuContent>
            </ContextMenu>
            {/* The toast this tooltip replaced was announced by assistive
                tech; a forced-open tooltip isn't, so the notice is mirrored
                into a live region. The hook toggles a zero-width space onto
                identical back-to-back completions so the second overwrite
                still announces. */}
            <span role="status" className="sr-only">
              {copyTreeAnnouncement}
            </span>
          </div>
        ),
        isAvailable: true,
      },
      "command-palette": {
        render: () => <ToolbarCommandPaletteButton key="command-palette" data-toolbar-item="" />,
        isAvailable: true,
      },
      "resume-sessions": {
        render: () => <ResumeSessionsToolbarButton key="resume-sessions" data-toolbar-item="" />,
        isAvailable: true,
      },
      settings: {
        render: () => (
          <ToolbarSettingsButton
            key="settings"
            onSettings={onSettings}
            onPreloadSettings={onPreloadSettings}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      problems: {
        render: () => (
          <ToolbarProblemsButton
            key="problems"
            errorCount={errorCount}
            watcherDegraded={watcherDegraded}
            topologyWatcherDark={topologyWatcherDark}
            onToggleProblems={onToggleProblems}
            data-toolbar-item=""
          />
        ),
        // Auto-surface the Problems button when file watching is unreliable so
        // the persistent Tier-1 indicator is visible even for users who
        // haven't enabled developer tools (the default).
        isAvailable: showDeveloperTools || watcherDegraded || topologyWatcherDark,
      },
      "assistant-toggle": {
        render: () => <ToolbarAssistantButton key="assistant-toggle" data-toolbar-item="" />,
        isAvailable: true,
      },
      "portal-toggle": {
        render: () => <ToolbarPortalButton key="portal-toggle" data-toolbar-item="" />,
        isAvailable: true,
      },
      "plugin-tray": {
        render: () => (
          <PluginTrayButton key="plugin-tray" configs={pluginConfigs} data-toolbar-item="" />
        ),
        // An empty tray is not a slot worth reserving — with no plugin
        // contributions the button doesn't render at all (#11304).
        isAvailable: pluginConfigs.size > 0,
      },
      // Individual contributions still need a top-level renderer, but only
      // reach the toolbar once explicitly promoted — `isToolbarButtonVisible`
      // gates that below, not `isAvailable`.
      ...Object.fromEntries(
        pluginButtonIds.map((pluginId) => {
          const config = pluginConfigs.get(pluginId);
          return [
            pluginId,
            {
              render: () => (
                <PluginToolbarButton
                  key={pluginId}
                  pluginId={pluginId}
                  config={config!}
                  data-toolbar-item=""
                />
              ),
              isAvailable: true,
            },
          ];
        })
      ),
      // Pinned launcher rows (#12217). Registry membership is the whole
      // stale-entry defense: the catalog holds only rows the launcher is
      // showing right now, so a pin left behind by a deleted recipe, an
      // uninstalled plugin, or a project the user has switched away from finds
      // no entry here and `availableLeftIds`/`availableRightIds` drop it. That
      // is deliberately not a sweep — the catalog is project- and
      // worktree-scoped, and erasing a project-A pin because the user is
      // standing in project B would lose intent that is still good.
      ...Object.fromEntries(
        [...launcherCatalog.values()].map((entry) => [
          entry.buttonId,
          {
            render: () => (
              <LauncherToolbarButton
                key={entry.buttonId}
                entry={entry}
                activationContext={launcherActivationContext}
                showScope={
                  entry.item.category === "recipe" && recipeNameCollisions.has(entry.item.name)
                }
                data-toolbar-item=""
              />
            ),
            isAvailable: true,
          },
        ])
      ),
    }),
    [
      isFocusMode,
      onToggleFocusMode,
      hasWorkspace,
      canCopyTree,
      agentAvailability,
      agentPins,
      onLaunchAgent,
      launcherData,
      launchAgentFromToolbar,
      launcherCatalog,
      launcherActivationContext,
      recipeNameCollisions,
      sidebarShortcut,
      sidebarAriaShortcut,
      sidebarHintHover,
      copyTreeCombo,
      copyTreeAriaShortcut,
      currentProject,
      forgeStatsLevel,
      handleCopyTreeOpenChange,
      handleCopyTreeFullContext,
      handleCopyTreeRunRecent,
      handleOpenContextSettings,
      handleCopyTreeCloseAutoFocus,
      copyTreeOpen,
      copyTreeNotice,
      copyTreeAnnouncement,
      copyTreeTooltipHovered,
      clearCopyTreeNotice,
      isCopyingTree,
      showCopyingSpinner,
      onSettings,
      onPreloadSettings,
      onToggleProblems,
      errorCount,
      watcherDegraded,
      topologyWatcherDark,
      showDeveloperTools,
      notificationsEnabled,
      canopyHidden,
      pluginButtonIds,
      pluginConfigs,
      devServerCombo,
      devServerHintHover,
      openFileBrowser,
      fileBrowserCombo,
      fileBrowserAriaShortcut,
      fileBrowserHintHover,
    ]
  );

  const {
    appPinnedButtons,
    pinnedButtons,
    resolveToolbarGroup,
    positionedLeftButtons,
    positionedRightButtons,
    effectiveLeftButtons,
    effectiveRightButtons,
    availableLeftIds,
    availableRightIds,
    pinnedIds,
    demotedIds,
    measuredLeftIds,
    measuredRightIds,
  } = useToolbarItemPlacement({
    toolbarLayout,
    positionAgentButton,
    projectToolbarMode,
    profileLevels,
    promotedPluginButtons: toolbarOverlay.promotedPluginButtons,
    presentation,
    hasProject: currentProject !== null,
    devPreviewPlaced,
    devPreviewHidden,
    forgeStatsHidden,
    agentPins,
    agentAvailability,
    launcherCatalog,
    pluginButtonIds,
    pluginConfigs,
    buttonRegistry,
    hasActiveVoiceRecording,
  });

  // The left `…` lives inside the left row, after its last visible button: its
  // 32px plus the 4px margin and 2px row gap that put it 6px clear, as the
  // right side's trigger sits. A demoted button or the branch row keeps it up
  // whatever the width.
  const leftTriggerPinned =
    branchOverflowRow !== null || availableLeftIds.some((id) => demotedIds.has(id));
  const leftOverflowTrigger = useMemo(
    () => ({ reserve: 38, pinned: leftTriggerPinned }),
    [leftTriggerPinned]
  );

  // Where the hairlines fall, which the overflow budget has to count the same
  // way the render draws them.
  const resolveDividerRun = useCallback(
    (id: AnyToolbarButtonId) => toolbarDividerRun(resolveToolbarGroup(id)),
    [resolveToolbarGroup]
  );

  // A button carrying a live signal holds its place on the strip while it is
  // lit: a squeezed window keeps Problems with errors and Canopy with an urgent
  // ask, and evicts a quiet tool in their place. Unread is ambient, so the bell
  // keeps its own tier — above the tools, below a lit error. Unlit, they fall
  // back to their ordinary tier.
  const overflowPriorities = useMemo(
    () =>
      withLitSignalPriorities({
        problems: errorCount > 0 || watcherDegraded || topologyWatcherDark,
        canopy: canopyUrgentCount > 0,
        ...Object.fromEntries(
          [...agentAttentionStates].map(([agentId, state]) => [agentId, state === "waiting"])
        ),
      }),
    [errorCount, watcherDegraded, topologyWatcherDark, canopyUrgentCount, agentAttentionStates]
  );

  const {
    leftVisible,
    leftOverflow: measuredLeftOverflow,
    rightVisible,
    rightOverflow: measuredRightOverflow,
  } = useToolbarOverflow(
    leftGroupRef,
    rightGroupRef,
    measuredLeftIds,
    measuredRightIds,
    pinnedIds,
    resolveDividerRun,
    overflowPriorities,
    leftOverflowTrigger
  );
  const leftOverflow = useMemo(
    () => withDemotedOverflow(availableLeftIds, measuredLeftOverflow, demotedIds),
    [availableLeftIds, measuredLeftOverflow, demotedIds]
  );
  const rightOverflow = useMemo(
    () => withDemotedOverflow(availableRightIds, measuredRightOverflow, demotedIds),
    [availableRightIds, measuredRightOverflow, demotedIds]
  );

  const {
    visibleLeftOverflow,
    visibleRightOverflow,
    leftMenuSeverity,
    rightMenuSeverity,
    leftObservations,
    rightObservations,
  } = useToolbarOverflowStatus({
    leftOverflow,
    rightOverflow,
    hasActiveVoiceRecording,
    hasProject: currentProject !== null,
    errorCount,
    canopyUrgentCount,
    watcherStatus,
    forgeUnavailableObservation:
      forgeDataUnavailable && forgeStatsLevel !== "hidden"
        ? `${forgeProviderName ?? "Repository"} data unavailable`
        : null,
    pluginConfigs,
    pinnedButtons,
  });

  // Read from the side lists, not measured overflow: a demoted button never
  // reaches the overflow hook.
  const copyTreeOnRight = rightOverflow.includes("copy-tree");

  const leftVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(leftVisible), [leftVisible]);
  const rightVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(rightVisible), [rightVisible]);

  useToolbarOverflowEviction({
    measuredLeftOverflow,
    measuredRightOverflow,
    demotedIds,
    copyTreeOnRight,
    toolbarRef,
    forgeStatsRef,
    recordCopyTreeEvictionFocus,
    setCopyTreeOpen,
  });

  const renderGroupedButtons = (
    buttonIds: AnyToolbarButtonId[],
    visibleSet: Set<AnyToolbarButtonId>
  ) => {
    const available = buttonIds.filter((id) => buttonRegistry[id]?.isAvailable);
    // `buttonIds` arrives already grouped, so a divider belongs after every
    // visible button whose declared group differs from the next visible one
    // (#11681). Overflow-hidden buttons stay mounted for measurement but are
    // excluded, so an evicted button never strands a divider.
    const dividerAfter = getToolbarDividerAfterIds(
      available,
      (id) => visibleSet.has(id),
      resolveDividerRun
    );

    const elements: React.ReactNode[] = [];
    for (const id of available) {
      const isVisible = visibleSet.has(id);
      elements.push(
        <div
          key={id}
          data-toolbar-button-id={id}
          className={cn("app-no-drag", !isVisible && "invisible absolute pointer-events-none")}
          aria-hidden={isVisible ? undefined : true}
          data-toolbar-placeholder={
            !currentProject && PROJECT_SCOPED_TOOLBAR_IDS.has(id) ? "true" : undefined
          }
        >
          {buttonRegistry[id]!.render()}
        </div>
      );
      if (isVisible && dividerAfter.has(id)) {
        elements.push(
          <div key={`group-divider-${id}`} className={toolbarDividerClass} aria-hidden="true" />
        );
      }
    }
    return elements;
  };

  const pluginTrayGroups = useMemo(
    () =>
      groupPluginToolbarButtons(
        pluginConfigs,
        (id) => pluginMetaById.get(id)?.displayName ?? pluginManifestIdFromInstanceKey(id)
      ),
    [pluginConfigs, pluginMetaById]
  );

  // One map for both dynamic classes: the overflow menu looks a button's label
  // and glyph up by id and doesn't care which registry minted it, and merging
  // here means a launcher item that overflows still renders as itself rather
  // than falling through to the unnamed-button path.
  const dynamicOverflowMeta = useMemo(
    () => ({
      ...buildPluginToolbarMeta(pluginButtonIds, pluginConfigs),
      ...buildLauncherToolbarMeta(launcherCatalog),
    }),
    [pluginButtonIds, pluginConfigs, launcherCatalog]
  );

  const { toolbarMenuRows, handleToolbarMenuToggle, projectToolbarMenu } = useToolbarCustomization({
    hasProject: currentProject !== null,
    projectToolbarMode,
    toolbarOverlay,
    presentation,
    explicitDevPreviewLevel,
    appPinnedButtons,
    pinnedButtons,
    toolbarLayout,
    positionAgentButton,
    agentPins,
    agentAvailability,
    pluginButtonIds,
    pluginConfigs,
    positionedLeftButtons,
    positionedRightButtons,
    dynamicOverflowMeta,
    buttonRegistry,
  });

  const overflowActions = useMemo<Partial<Record<AnyToolbarButtonId, () => void>>>(
    () => ({
      ...Object.fromEntries(BUILT_IN_AGENT_IDS.map((id) => [id, () => onLaunchAgent(id)])),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "file-browser": openFileBrowser,
      "dev-server": () => {
        void actionService.dispatch("devServer.start", undefined, { source: "user" });
      },
      "notification-center": () => {
        void actionService.dispatch("notifications.toggle", undefined, { source: "user" });
      },
      canopy: () => {
        void actionService.dispatch("canopy.toggle", undefined, { source: "user" });
      },
      "copy-tree": () => {
        void handleCopyTreeClick();
      },
      "command-palette": () => {
        void actionService.dispatch("action.palette.open", undefined, { source: "user" });
      },
      "resume-sessions": () => {
        void actionService.dispatch("terminal.resumeSessions", undefined, { source: "user" });
      },
      settings: onSettings,
      problems: onToggleProblems,
      ...Object.fromEntries(
        pluginButtonIds.map((id) => {
          const config = pluginConfigs.get(id);
          return [
            id,
            () => {
              // A popover button opens off the overflow menu itself, which
              // routes it there before reaching this map.
              if (config?.actionId !== undefined) {
                void actionService.dispatch(
                  config.actionId as Parameters<typeof actionService.dispatch>[0],
                  undefined,
                  { source: "user" }
                );
              }
            },
          ];
        })
      ),
      // An overflowed launcher item stays clickable, and clicks through the
      // same seam its top-level button uses so the two can't diverge.
      ...Object.fromEntries(
        [...launcherCatalog.values()].map((entry) => [
          entry.buttonId,
          () => activateDockLaunchItem(entry.item, launcherActivationContext),
        ])
      ),
    }),
    [
      onLaunchAgent,
      openFileBrowser,
      handleCopyTreeClick,
      onSettings,
      onToggleProblems,
      pluginButtonIds,
      pluginConfigs,
      launcherCatalog,
      launcherActivationContext,
    ]
  );

  // Mirrors the launcher's own row gates so an inlined overflow row degrades
  // the same way the launcher row does rather than silently opening nothing.
  // A pinned launcher row that can't launch right now stays on the toolbar,
  // disabled with its reason; overflowing it must not quietly re-enable it.
  // The two built-in panel buttons with a precondition carry the launcher row's
  // own gate and wording for it.
  const overflowUnavailableReasons = useMemo(() => {
    const reasons: Partial<Record<string, string>> = {};
    for (const entry of launcherCatalog.values()) {
      const reason = entry.item.disabled?.reason;
      if (reason !== undefined) reasons[entry.buttonId] = reason;
    }
    const preconditions = { hasWorkspace, hasProject: currentProject !== null };
    const fileBrowser = panelPrecondition("file-browser", preconditions)?.reason;
    const devPreview = panelPrecondition("dev-preview", preconditions)?.reason;
    if (fileBrowser !== undefined) reasons["file-browser"] = fileBrowser;
    if (devPreview !== undefined) reasons["dev-server"] = devPreview;
    return reasons;
  }, [launcherCatalog, hasWorkspace, currentProject]);

  const panelTrayDisabled: Partial<Record<string, boolean>> = {
    "file-browser": !hasWorkspace,
    "dev-server": !currentProject,
  };

  const launcherPanelItems = useMemo(
    () =>
      devPreviewHidden
        ? LAUNCHER_PANEL_ITEMS.filter((item) => item.id !== "dev-server")
        : LAUNCHER_PANEL_ITEMS,
    [devPreviewHidden]
  );

  // Same filter the launcher's own Launch section applies, so the rows the
  // overflow menu inlines are exactly the rows the dropdown would have shown.
  const launcherAgentIds = useMemo(
    () => BUILT_IN_AGENT_IDS.filter((id) => isAgentLaunchable(agentAvailability?.[id])),
    [agentAvailability]
  );

  const renderOverflowMenu = (
    overflowIds: AnyToolbarButtonId[],
    side: "left" | "right",
    severity: OverflowBadgeSeverity,
    agentObservations: readonly string[],
    branchRow: OverflowMenuProps["branchRow"] = null,
    triggerClassName?: string
  ) => (
    <OverflowMenu
      overflowIds={overflowIds}
      side={side}
      severity={severity}
      errorCount={errorCount}
      notificationUnreadCount={notificationUnreadCount}
      canopyUrgentCount={canopyUrgentCount}
      watcherStatus={watcherStatus}
      agentObservations={agentObservations}
      agentAttentionStates={agentAttentionStates}
      canCopyTree={canCopyTree}
      forgeStatsRef={forgeStatsRef}
      forgeProviderName={forgeProviderName}
      forgeDataUnavailable={forgeDataUnavailable}
      overflowActions={overflowActions}
      dynamicOverflowMeta={dynamicOverflowMeta}
      pluginTrayGroups={pluginTrayGroups}
      pluginConfigs={pluginConfigs}
      launcherAgentIds={launcherAgentIds}
      launcherPanelItems={launcherPanelItems}
      panelTrayDisabled={panelTrayDisabled}
      keybindingById={OVERFLOW_KEYBINDING_BY_ID}
      branchRow={branchRow}
      resolveGroup={resolveDividerRun}
      unavailableReasonById={overflowUnavailableReasons}
      triggerClassName={triggerClassName}
    />
  );

  // Static per view: a project view is bound to one host for its life.
  const remoteWindow = getViewHostId() !== null;

  return (
    <header>
      {/* Brand marks in the toolbar are painted on the toolbar surface, not on
          whichever surface the theme happens to make hardest. */}
      <BrandSurface surface="surface-toolbar">
        <ToolbarButtonsContextMenu
          rows={toolbarMenuRows}
          onToggle={handleToolbarMenuToggle}
          projectToolbar={projectToolbarMenu}
        >
          <div
            ref={toolbarRef}
            role="toolbar"
            aria-label="Main toolbar"
            onKeyDown={handleToolbarKeyDown}
            onFocusCapture={handleToolbarFocusCapture}
            onBlurCapture={handleToolbarBlurCapture}
            // A window working on another machine shows it as light behind the
            // project pill and host chip (toolbar/surface.css), so the difference reads
            // before anything is read.
            data-remote-window={remoteWindow ? "" : undefined}
            className={cn(
              "@container/toolbar relative z-[var(--z-toolbar)] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 h-12 items-center px-4 shrink-0 app-drag-region surface-toolbar border-b border-divider",
              // macOS paints its window-rim highlight over our top pixel row, and
              // the eye reads it as separate from the strip; centre in what's left.
              // Fullscreen has no rim.
              isMac() && !isFullscreen && "pt-px"
            )}
          >
            {!isLinux() && <div className="window-resize-strip" />}

            {/* LEFT GROUP */}
            <div
              role="group"
              aria-label="Navigation and agents"
              className="flex items-center gap-1.5 z-20"
            >
              {isMac() && (
                <div
                  data-fullscreen={isFullscreen ? "true" : undefined}
                  className={cn(
                    "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120 motion-reduce:transition-none",
                    // A zero-width flex item still owns a gap on each side;
                    // the negative margin folds the group's gap back in so
                    // fullscreen's first button lands at the same inset a
                    // spacer-less platform gives it.
                    isFullscreen ? "w-0 -mr-1.5" : "w-16"
                  )}
                />
              )}
              {/* Fixed chrome, never part of buttonRegistry/overflow: this is the
              recovery surface for the application menu itself, so it must not
              be hideable or reorderable into an overflow popover (#11813).
              Gated here as well as inside the component so macOS doesn't keep
              an empty flex item, which would add a stray gap-1.5 column. */}
              {!isMac() && (
                <div className="app-no-drag">
                  <AppMenuButton />
                </div>
              )}
              <div className="app-no-drag">{buttonRegistry["sidebar-toggle"]!.render()}</div>

              <div className={toolbarFixedDividerClass} />

              <div
                ref={leftGroupRef}
                className="toolbar-measured-row flex flex-1 min-w-0 items-center gap-0.5"
              >
                {renderGroupedButtons(effectiveLeftButtons, leftVisibleSet)}
                {renderOverflowMenu(
                  visibleLeftOverflow,
                  "left",
                  leftMenuSeverity,
                  leftObservations,
                  branchOverflowRow,
                  // Clear of the last visible button; with none left, the
                  // group's own gap already spaces it from the divider.
                  leftVisible.length > 0 ? "ml-1" : undefined
                )}
              </div>
            </div>

            {/* CENTER GROUP - Grid-centered, shrinks gracefully on narrow windows */}
            <div
              role="group"
              aria-label="Project"
              className="app-no-drag relative flex items-center justify-center min-w-0 max-w-full pointer-events-none justify-self-center"
            >
              {/* Anchor-only sibling of the pill — see ProjectIdentityEditor. */}
              {currentProject && shouldMountIdentityEditor && (
                <Suspense fallback={null}>
                  <LazyProjectIdentityEditor
                    project={currentProject}
                    open={isIdentityEditorOpen}
                    onOpenChange={handleIdentityEditorOpenChange}
                    onCloseAutoFocus={suppressPillTooltipForFocusRestore}
                  />
                </Suspense>
              )}
              <Tooltip
                open={workspaceIdentity.kind !== "none" ? pillTooltipOpen : false}
                onOpenChange={
                  workspaceIdentity.kind !== "none" ? handlePillTooltipOpenChange : undefined
                }
              >
                <ContextMenu onOpenChange={handlePillContextMenuOpenChange}>
                  {shouldMountProjectSwitcherDropdown ? (
                    <Suspense fallback={projectSwitcherTrigger}>
                      <LazyProjectSwitcherPalette
                        mode="dropdown"
                        isOpen={isDropdownOpen}
                        query={projectSwitcher.query}
                        results={projectSwitcher.results}
                        browseBands={projectSwitcher.browseBands}
                        selectedIndex={projectSwitcher.selectedIndex}
                        cycleRequest={projectSwitcher.cycleRequest}
                        onQueryChange={projectSwitcher.setQuery}
                        onSelectPrevious={projectSwitcher.selectPrevious}
                        onSelectNext={projectSwitcher.selectNext}
                        onSelect={projectSwitcher.selectRow}
                        onHoverProject={projectSwitcher.onHoverProject}
                        onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
                        onHoverRow={projectSwitcher.hoverRow}
                        fleetLiveness={projectSwitcher.fleetLiveness}
                        onClose={handlePillDropdownClose}
                        onDropdownCloseAutoFocus={suppressPillTooltipForFocusRestore}
                        consumeCloseAutoFocusSuppression={
                          projectSwitcher.consumeCloseAutoFocusSuppression
                        }
                        onAddProject={projectSwitcher.addProject}
                        onCloneRepo={projectSwitcher.cloneRepo}
                        onStopProject={handleStopProject}
                        onCloseProject={handleCloseProject}
                        onSleepProject={handleSleepProject}
                        onRestartProject={handleRestartProject}
                        onLocateProject={handleLocateProject}
                        onMoveOrRenameProject={handleMoveOrRenameProject}
                        onTogglePinProject={projectSwitcher.togglePinProject}
                        onCopyPath={projectSwitcher.copyPath}
                        onOpenProjectSettings={
                          currentProject ? handleOpenProjectSettings : undefined
                        }
                        onSelectNewWindow={handleSelectNewWindow}
                        dropdownAlign="center"
                        removeConfirmProject={projectSwitcher.removeConfirmProject}
                        onRemoveConfirmClose={handleRemoveConfirmClose}
                        onConfirmRemove={projectSwitcher.confirmRemoveProject}
                        isRemovingProject={projectSwitcher.isRemovingProject}
                        sleepConfirmProject={projectSwitcher.sleepConfirmProject}
                        onSleepConfirmClose={() => projectSwitcher.setSleepConfirmProject(null)}
                        onConfirmSleep={projectSwitcher.confirmSleep}
                        isSleepingProject={projectSwitcher.isSleepingProject}
                        rankedSearch={projectSwitcher.isRankedSearch}
                        scratchResults={projectSwitcher.scratchResults}
                        onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
                        onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
                        onRequestDeleteScratch={projectSwitcher.requestDeleteScratch}
                        deleteScratchConfirm={projectSwitcher.deleteScratchConfirm}
                        onDismissDeleteScratchConfirm={projectSwitcher.dismissDeleteScratchConfirm}
                        onConfirmDeleteScratch={() => void projectSwitcher.confirmDeleteScratch()}
                        isDeletingScratch={projectSwitcher.isDeletingScratch}
                        onRequestDeleteAllScratches={projectSwitcher.requestDeleteAllScratches}
                        deleteAllScratchesConfirm={projectSwitcher.deleteAllScratchesConfirm}
                        onDismissDeleteAllScratchesConfirm={
                          projectSwitcher.dismissDeleteAllScratchesConfirm
                        }
                        onConfirmDeleteAllScratches={() =>
                          void projectSwitcher.confirmDeleteAllScratches()
                        }
                        isDeletingAllScratches={projectSwitcher.isDeletingAllScratches}
                        onRenameScratch={(scratchId, name) =>
                          void projectSwitcher.renameScratch(scratchId, name)
                        }
                        onSaveAsProject={(scratchId) =>
                          void projectSwitcher.saveAsProject(scratchId)
                        }
                        saveAsProjectConfirm={projectSwitcher.saveAsProjectConfirm}
                        onDismissSaveAsProjectConfirm={projectSwitcher.dismissSaveAsProjectConfirm}
                        onOpenSavedProject={projectSwitcher.openSavedProject}
                      >
                        {projectSwitcherTrigger}
                      </LazyProjectSwitcherPalette>
                    </Suspense>
                  ) : (
                    projectSwitcherTrigger
                  )}
                  {currentProject && (
                    <ContextMenuContent
                      className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
                      onCloseAutoFocus={handlePillContextMenuCloseAutoFocus}
                    >
                      {/* The display name and emoji. Distinct from the switcher
                        row's "Move or rename project…", which relocates the
                        folder on disk. */}
                      <ContextMenuItem onSelect={handleEditProjectIdentity}>
                        <Pencil data-menu-icon className="mr-2 h-3.5 w-3.5" />
                        Edit name and icon…
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={handlePillTogglePin}>
                        {activeSearchableProject?.isPinned ? (
                          <>
                            <PinOff data-menu-icon className="mr-2 h-3.5 w-3.5" />
                            Unpin project
                          </>
                        ) : (
                          <>
                            <Pin data-menu-icon className="mr-2 h-3.5 w-3.5" />
                            Pin project
                          </>
                        )}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={handleCopyProjectPath}>
                        <Copy data-menu-icon className="mr-2 h-3.5 w-3.5" />
                        Copy path
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={handleOpenProjectSettings}>
                        <Settings data-menu-icon className="mr-2 h-3.5 w-3.5" />
                        Project settings…
                      </ContextMenuItem>
                      <ProjectPluginMenuItems projectId={currentProject.id} />
                      {activeSearchableProject && activeProjectHasProcesses && (
                        <ContextMenuItem
                          destructive
                          onSelect={() => handleStopProject(currentProject.id)}
                        >
                          <CircleStop data-menu-icon className="mr-2 h-3.5 w-3.5" />
                          Stop project
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        destructive
                        onSelect={() => handleCloseProject(currentProject.id)}
                      >
                        <X data-menu-icon className="mr-2 h-3.5 w-3.5" />
                        Close project
                      </ContextMenuItem>
                    </ContextMenuContent>
                  )}
                </ContextMenu>
                {currentProject && (
                  <TooltipContent side="bottom">
                    <ToolbarProjectPillTooltipBody
                      name={currentProject.name}
                      branchLabel={pillBranchLabel}
                      path={currentProject.path}
                    />
                  </TooltipContent>
                )}
                {!currentProject && currentScratch && (
                  <TooltipContent side="bottom">
                    <ToolbarProjectPillTooltipBody
                      name={currentScratch.name}
                      branchLabel={undefined}
                      path={undefined}
                    />
                  </TooltipContent>
                )}
              </Tooltip>
              <HostChip />
              <AttachedMachinesIndicator />
            </div>

            {/* RIGHT GROUP */}
            <div
              role="group"
              aria-label="Tools and settings"
              className="flex items-center justify-end gap-1.5 z-20"
            >
              <div
                ref={rightGroupRef}
                className="toolbar-measured-row flex flex-1 min-w-0 items-center gap-0.5 justify-end"
              >
                {renderGroupedButtons(effectiveRightButtons, rightVisibleSet)}
              </div>
              {renderOverflowMenu(
                visibleRightOverflow,
                "right",
                rightMenuSeverity,
                rightObservations
              )}

              {/* Fixed chrome outside the measured button row: it exists only
                  while a terminal host has output paused for memory (#12375),
                  so there is nothing to pin, hide, or overflow. */}
              {hostMemoryPauseVisible && (
                <div className="app-no-drag shrink-0">
                  <HostMemoryPauseIndicator />
                </div>
              )}

              <div className={toolbarFixedDividerClass} />

              <div className="app-no-drag flex items-center gap-0.5">
                {buttonRegistry["assistant-toggle"]!.render()}
                {buttonRegistry["portal-toggle"]!.render()}
              </div>

              {isWindows() && (
                <div
                  aria-hidden="true"
                  data-fullscreen={isFullscreen ? "true" : undefined}
                  className={cn(
                    "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120 motion-reduce:transition-none",
                    isFullscreen && "w-0 -ml-1.5"
                  )}
                  style={isFullscreen ? undefined : { width: `${WINDOWS_CAPTION_WIDTH_PX}px` }}
                />
              )}
            </div>
          </div>
        </ToolbarButtonsContextMenu>
      </BrandSurface>
    </header>
  );
}
