import { useRef, useState, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  SlidersHorizontal,
  SquareTerminal,
  AlertCircle,
  GitCommit,
  GitPullRequest,
  CircleDot,
  PanelLeftOpen,
  PanelLeftClose,
  Check,
  ChevronsUpDown,
  Globe,
  Monitor,
  Bell,
  Ellipsis,
  GitBranch,
  StickyNote,
  Plug,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { CopyTreeIcon, McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { isMac, isLinux, createTooltipWithShortcut } from "@/lib/platform";
import { AgentButton } from "./AgentButton";
import { AgentTrayButton } from "./AgentTrayButton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToolbarOverflow } from "@/hooks/useToolbarOverflow";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useKeybindingDisplay } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { useProjectStore } from "@/store/projectStore";
import { usePreferencesStore, useToolbarPreferencesStore, useVoiceRecordingStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import type { ToolbarButtonId, AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { CliAvailability, AgentSettings } from "@shared/types";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { useUIStore } from "@/store/uiStore";
import { GitHubStatsToolbarButton, type GitHubStatsHandle } from "./GitHubStatsToolbarButton";
import { NotificationCenterToolbarButton } from "./NotificationCenterToolbarButton";
import { ToolbarLauncherButton } from "./ToolbarLauncherButton";
import { ToolbarSettingsButton } from "./ToolbarSettingsButton";
import { ToolbarProblemsButton } from "./ToolbarProblemsButton";
import { ToolbarPortalButton } from "./ToolbarPortalButton";

import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import { getAgentConfig } from "@/config/agents";

const AGENT_TOOLBAR_IDS = new Set<ToolbarButtonId>([
  "agent-tray",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
]);

type OverflowMenuMeta = { label: string; icon: React.ComponentType<{ className?: string }> };

export const OVERFLOW_MENU_META: Partial<Record<AnyToolbarButtonId, OverflowMenuMeta>> = {
  ...(Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => [
      id,
      { label: getAgentConfig(id)?.name ?? id, icon: SquareTerminal },
    ])
  ) as unknown as Record<BuiltInAgentId, OverflowMenuMeta>),
  "agent-tray": { label: "Agent Tray", icon: Plug },
  terminal: { label: "Terminal", icon: SquareTerminal },
  browser: { label: "Browser", icon: Globe },
  "dev-server": { label: "Dev Preview", icon: Monitor },
  "github-stats": { label: "GitHub Stats", icon: GitPullRequest },
  "notification-center": { label: "Notifications", icon: Bell },
  notes: { label: "Notes", icon: StickyNote },
  "copy-tree": { label: "Copy Context", icon: CopyTreeIcon },
  settings: { label: "Settings", icon: SlidersHorizontal },
  problems: { label: "Problems", icon: AlertCircle },
};

interface ToolbarProps {
  onLaunchAgent: (type: string) => void;
  onSettings: () => void;
  onPreloadSettings?: () => void;
  errorCount?: number;
  onToggleProblems?: () => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
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
  agentAvailability,
  agentSettings,
  projectSwitcherPalette,
}: ToolbarProps) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const projectSwitcher = projectSwitcherPalette;

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );
  const branchName = activeWorktree?.branch;

  useEffect(() => {
    loadProjects();
    getCurrentProject();

    const cleanup = projectClient.onSwitch(() => {
      getCurrentProject();
      loadProjects();
    });

    return cleanup;
  }, [loadProjects, getCurrentProject]);

  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);
  // Live subscription so pin/unpin toggles from the AgentTrayButton immediately
  // update per-agent toolbar button visibility. The `agentSettings` prop is
  // sourced from `useAgentLauncher()`'s local useState which does not react to
  // store mutations, so we prefer the store value when available.
  const liveAgentSettings = useAgentSettingsStore((s) => s.settings);
  const effectiveAgentSettings = liveAgentSettings ?? agentSettings;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasActiveVoiceRecording = useVoiceRecordingStore(
    (state) =>
      state.activeTarget !== null &&
      (state.status === "connecting" ||
        state.status === "recording" ||
        state.status === "finishing")
  );

  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const activeToolbarIndexRef = useRef<number>(0);
  const githubStatsRef = useRef<GitHubStatsHandle>(null);

  const { handleCopyTree } = useWorktreeActions();
  const sidebarShortcut = useKeybindingDisplay("nav.toggleSidebar");
  const notesShortcut = useKeybindingDisplay("notes.openPalette");
  const copyTreeShortcut = useKeybindingDisplay("worktree.copyTree");

  const handleOpenProjectSettings = useCallback(() => {
    projectSwitcher.close();
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, [projectSwitcher]);

  const handleStopProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.stopProject(projectId);
    },
    [projectSwitcher]
  );

  const handleCloseProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.removeProject(projectId);
    },
    [projectSwitcher]
  );

  const handleRemoveConfirmClose = useCallback(() => {
    projectSwitcher.setRemoveConfirmProject(null);
  }, [projectSwitcher]);

  const handleSelectNewWindow = useCallback(
    (project: SearchableProject) => {
      if (project.isMissing) return;
      projectSwitcher.close();
      void actionService.dispatch(
        "app.newWindow",
        { projectPath: project.path },
        { source: "user" }
      );
    },
    [projectSwitcher]
  );

  useEffect(() => {
    return window.electron.window.onFullscreenChange(setIsFullscreen);
  }, []);

  useEffect(() => {
    return () => {
      if (treeCopyTimeoutRef.current) {
        clearTimeout(treeCopyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyTreeClick = useCallback(async () => {
    if (isCopyingTree || !activeWorktree) return;

    setIsCopyingTree(true);

    try {
      const resultMessage = await handleCopyTree(activeWorktree);

      if (resultMessage) {
        setTreeCopied(true);
        setCopyFeedback(resultMessage);
        shortcutHintStore.getState().hide();

        if (treeCopyTimeoutRef.current) {
          clearTimeout(treeCopyTimeoutRef.current);
        }

        treeCopyTimeoutRef.current = setTimeout(() => {
          setTreeCopied(false);
          setCopyFeedback("");
          treeCopyTimeoutRef.current = null;
        }, 2000);
      }
    } finally {
      setIsCopyingTree(false);
    }
  }, [isCopyingTree, activeWorktree, handleCopyTree]);

  const getToolbarItems = useCallback(
    () =>
      toolbarRef.current
        ? Array.from(
            toolbarRef.current.querySelectorAll<HTMLElement>("[data-toolbar-item]:not(:disabled)")
          ).filter((el) => el.offsetParent !== null)
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
    const clamped = Math.min(activeToolbarIndexRef.current, items.length - 1);
    activeToolbarIndexRef.current = clamped;
    syncToolbarTabStops(items, clamped);
  });

  const handleToolbarFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const items = getToolbarItems();
      const idx = items.indexOf(target);
      if (idx !== -1) {
        activeToolbarIndexRef.current = idx;
        syncToolbarTabStops(items, idx);
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  const handleToolbarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
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

  const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";
  const toolbarDividerClass = "toolbar-divider w-px h-5 mx-1";

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  const buttonRegistry = useMemo<
    Record<string, { render: () => React.ReactNode; isAvailable: boolean }>
  >(
    () => ({
      "sidebar-toggle": {
        render: () => (
          <TooltipProvider key="sidebar-toggle">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={onToggleFocusMode}
                  className={toolbarIconButtonClass}
                  aria-label="Toggle Sidebar"
                  aria-pressed={!isFocusMode}
                >
                  {isFocusMode ? <PanelLeftOpen /> : <PanelLeftClose />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut(
                  isFocusMode ? "Show Sidebar" : "Hide Sidebar",
                  sidebarShortcut
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      "agent-tray": {
        render: () => (
          <AgentTrayButton
            key="agent-tray"
            agentAvailability={agentAvailability}
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
            isAvailable:
              isAgentInstalled(agentAvailability?.[id]) &&
              isAgentPinned(effectiveAgentSettings?.agents?.[id]),
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
      "dev-server": {
        render: () => (
          <TooltipProvider key="dev-server">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={() =>
                    actionService.dispatch("devServer.start", undefined, { source: "user" })
                  }
                  className={toolbarIconButtonClass}
                  aria-label="Open Dev Preview"
                >
                  <Monitor />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open Dev Preview</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: !!currentProject,
      },
      "voice-recording": {
        render: () => <VoiceRecordingToolbarButton key="voice-recording" data-toolbar-item="" />,
        isAvailable: hasActiveVoiceRecording,
      },
      "github-stats": {
        render: () => (
          <GitHubStatsToolbarButton
            key="github-stats"
            ref={githubStatsRef}
            currentProject={currentProject}
            data-toolbar-item=""
          />
        ),
        isAvailable: !!currentProject,
      },
      "notification-center": {
        render: () => (
          <NotificationCenterToolbarButton key="notification-center" data-toolbar-item="" />
        ),
        isAvailable: notificationsEnabled,
      },
      notes: {
        render: () => (
          <TooltipProvider key="notes">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={() => actionService.dispatch("notes.create", {}, { source: "user" })}
                  className={toolbarIconButtonClass}
                  aria-label="Open notes palette"
                >
                  <StickyNote />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Notes", notesShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      "copy-tree": {
        render: () => (
          <TooltipProvider key="copy-tree">
            <Tooltip open={treeCopied || undefined} delayDuration={treeCopied ? 0 : 300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={handleCopyTreeClick}
                  disabled={isCopyingTree || !activeWorktree}
                  className={cn(
                    "toolbar-icon-button transition-colors",
                    treeCopied ? "text-status-success bg-status-success/10" : "text-daintree-text",
                    isCopyingTree && "cursor-wait opacity-70",
                    !activeWorktree && "opacity-50"
                  )}
                  aria-label={
                    isCopyingTree ? "Copying…" : treeCopied ? "Context Copied" : "Copy Context"
                  }
                >
                  {isCopyingTree ? <Spinner /> : treeCopied ? <Check /> : <CopyTreeIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="font-medium">
                {isCopyingTree ? (
                  "Copying…"
                ) : treeCopied ? (
                  <span role="status" aria-live="polite">
                    {copyFeedback}
                  </span>
                ) : (
                  createTooltipWithShortcut("Copy Context", copyTreeShortcut)
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
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
            onToggleProblems={onToggleProblems}
            data-toolbar-item=""
          />
        ),
        isAvailable: showDeveloperTools,
      },
      "portal-toggle": {
        render: () => <ToolbarPortalButton key="portal-toggle" data-toolbar-item="" />,
        isAvailable: true,
      },
      ...Object.fromEntries(
        pluginButtonIds.map((pluginId) => {
          const config = pluginConfigs.get(pluginId);
          return [
            pluginId,
            {
              render: () => (
                <TooltipProvider key={pluginId}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        data-toolbar-item=""
                        onClick={() => {
                          void actionService.dispatch(
                            config!.actionId as Parameters<typeof actionService.dispatch>[0],
                            undefined,
                            { source: "user" }
                          );
                        }}
                        className={toolbarIconButtonClass}
                        aria-label={config?.label ?? pluginId}
                      >
                        <McpServerIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{config?.label ?? pluginId}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ),
              isAvailable: true,
            },
          ];
        })
      ),
    }),
    [
      isFocusMode,
      onToggleFocusMode,
      agentAvailability,
      effectiveAgentSettings,
      onLaunchAgent,
      sidebarShortcut,
      notesShortcut,
      copyTreeShortcut,
      hasActiveVoiceRecording,
      currentProject,
      handleCopyTreeClick,
      isCopyingTree,
      activeWorktree,
      treeCopied,
      copyFeedback,
      onSettings,
      onPreloadSettings,
      onToggleProblems,
      errorCount,
      showDeveloperTools,
      notificationsEnabled,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  const hiddenSet = useMemo(
    () => new Set(toolbarLayout.hiddenButtons),
    [toolbarLayout.hiddenButtons]
  );

  const effectiveLeftButtons = useMemo(
    () => toolbarLayout.leftButtons.filter((id) => !hiddenSet.has(id)),
    [toolbarLayout.leftButtons, hiddenSet]
  );

  const effectiveRightButtons = useMemo(() => {
    const existing = new Set(toolbarLayout.rightButtons);
    const extra = pluginButtonIds.filter((id) => !existing.has(id));
    return [...toolbarLayout.rightButtons, ...extra].filter((id) => !hiddenSet.has(id));
  }, [toolbarLayout.rightButtons, pluginButtonIds, hiddenSet]);

  const availableLeftIds = useMemo(
    () => effectiveLeftButtons.filter((id) => buttonRegistry[id]?.isAvailable),
    [effectiveLeftButtons, buttonRegistry]
  );

  const availableRightIds = useMemo(
    () => effectiveRightButtons.filter((id) => buttonRegistry[id]?.isAvailable),
    [effectiveRightButtons, buttonRegistry]
  );

  const { leftVisible, leftOverflow, rightVisible, rightOverflow } = useToolbarOverflow(
    leftGroupRef,
    rightGroupRef,
    availableLeftIds,
    availableRightIds
  );

  const leftVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(leftVisible), [leftVisible]);
  const rightVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(rightVisible), [rightVisible]);

  // Close open dropdowns when their buttons move into overflow
  useEffect(() => {
    const overflowSet = new Set<AnyToolbarButtonId>([...leftOverflow, ...rightOverflow]);
    if (overflowSet.has("github-stats")) {
      githubStatsRef.current?.closeAll();
    }
    if (overflowSet.has("notification-center")) {
      useUIStore.getState().closeNotificationCenter();
    }
  }, [leftOverflow, rightOverflow]);

  const renderButtons = (buttonIds: AnyToolbarButtonId[], visibleSet: Set<AnyToolbarButtonId>) => {
    return buttonIds
      .filter((id) => buttonRegistry[id]?.isAvailable)
      .map((id) => (
        <div
          key={id}
          data-toolbar-button-id={id}
          className={cn(
            "app-no-drag",
            !visibleSet.has(id) && "invisible absolute pointer-events-none"
          )}
          aria-hidden={visibleSet.has(id) ? undefined : true}
        >
          {buttonRegistry[id]!.render()}
        </div>
      ));
  };

  const renderLeftButtons = (
    buttonIds: AnyToolbarButtonId[],
    visibleSet: Set<AnyToolbarButtonId>
  ) => {
    const available = buttonIds.filter((id) => buttonRegistry[id]?.isAvailable);
    const visible = available.filter((id) => visibleSet.has(id));
    const elements: React.ReactNode[] = [];

    // Render all available items (visible + hidden for measurement)
    for (const id of available) {
      const isVisible = visibleSet.has(id);
      elements.push(
        <div
          key={id}
          data-toolbar-button-id={id}
          className={cn("app-no-drag", !isVisible && "invisible absolute pointer-events-none")}
          aria-hidden={isVisible ? undefined : true}
        >
          {buttonRegistry[id]!.render()}
        </div>
      );
    }

    // Insert group dividers between agent and non-agent visible items
    const withDividers: React.ReactNode[] = [];
    let visibleIdx = 0;
    for (const el of elements) {
      withDividers.push(el);
      const key = (el as React.ReactElement).key as string;
      if (visibleSet.has(key as AnyToolbarButtonId)) {
        if (
          visibleIdx < visible.length - 1 &&
          AGENT_TOOLBAR_IDS.has(visible[visibleIdx] as ToolbarButtonId) !==
            AGENT_TOOLBAR_IDS.has(visible[visibleIdx + 1] as ToolbarButtonId)
        ) {
          withDividers.push(
            <div
              key={`group-divider-${visibleIdx}`}
              className={toolbarDividerClass}
              aria-hidden="true"
            />
          );
        }
        visibleIdx++;
      }
    }
    return withDividers;
  };

  const pluginOverflowMeta = useMemo(() => {
    const meta: Record<
      string,
      { label: string; icon: React.ComponentType<{ className?: string }> }
    > = {};
    for (const id of pluginButtonIds) {
      const config = pluginConfigs.get(id);
      if (config) {
        meta[id] = { label: config.label, icon: McpServerIcon };
      }
    }
    return meta;
  }, [pluginButtonIds, pluginConfigs]);

  const overflowActions = useMemo<Partial<Record<AnyToolbarButtonId, () => void>>>(
    () => ({
      ...Object.fromEntries(BUILT_IN_AGENT_IDS.map((id) => [id, () => onLaunchAgent(id)])),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "dev-server": () => {
        void actionService.dispatch("devServer.start", undefined, { source: "user" });
      },
      "notification-center": () => {
        useUIStore.getState().toggleNotificationCenter();
      },
      notes: () => {
        void actionService.dispatch("notes.create", {}, { source: "user" });
      },
      "copy-tree": () => {
        void handleCopyTreeClick();
      },
      settings: onSettings,
      problems: onToggleProblems,
      ...Object.fromEntries(
        pluginButtonIds.map((id) => {
          const config = pluginConfigs.get(id);
          return [
            id,
            () => {
              if (config) {
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
    }),
    [
      onLaunchAgent,
      handleCopyTreeClick,
      onSettings,
      onToggleProblems,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  const renderOverflowMenu = (overflowIds: AnyToolbarButtonId[], side: "left" | "right") => {
    if (overflowIds.length === 0) return null;
    return (
      <DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  className={toolbarIconButtonClass}
                  aria-label={`${overflowIds.length} more toolbar items`}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">More items</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align={side === "left" ? "start" : "end"} sideOffset={4}>
          {overflowIds.flatMap((id, idx) => {
            if (id === "github-stats") {
              const ghStats = githubStatsRef.current?.stats;
              const items = [
                <DropdownMenuItem
                  key="gh-issues"
                  onClick={() => githubStatsRef.current?.openIssues()}
                >
                  <CircleDot className="mr-2 h-4 w-4 text-github-open" />
                  Issues {ghStats?.issueCount != null ? `(${ghStats.issueCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem key="gh-prs" onClick={() => githubStatsRef.current?.openPrs()}>
                  <GitPullRequest className="mr-2 h-4 w-4 text-github-merged" />
                  Pull Requests {ghStats?.prCount != null ? `(${ghStats.prCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem
                  key="gh-commits"
                  onClick={() => githubStatsRef.current?.openCommits()}
                >
                  <GitCommit className="mr-2 h-4 w-4" />
                  Commits {ghStats?.commitCount != null ? `(${ghStats.commitCount})` : ""}
                </DropdownMenuItem>,
              ];
              if (idx < overflowIds.length - 1) {
                items.push(<DropdownMenuSeparator key="gh-sep" />);
              }
              return items;
            }
            const meta = OVERFLOW_MENU_META[id] ?? pluginOverflowMeta[id];
            if (!meta) return [];
            const Icon = meta.icon;
            return [
              <DropdownMenuItem key={id} onClick={() => overflowActions[id]?.()}>
                <Icon className="mr-2 h-4 w-4" />
                {meta.label}
              </DropdownMenuItem>,
            ];
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  return (
    <header>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Main toolbar"
        onKeyDown={handleToolbarKeyDown}
        onFocusCapture={handleToolbarFocusCapture}
        className="@container/toolbar relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] h-12 items-center px-4 pt-1 shrink-0 app-drag-region surface-toolbar border-b border-divider"
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
              className={cn(
                "shrink-0 transition-[width] duration-200",
                isFullscreen ? "w-0" : "w-16"
              )}
            />
          )}
          <div className="app-no-drag">{buttonRegistry["sidebar-toggle"]!.render()}</div>

          <div className={toolbarDividerClass} />

          <div
            ref={leftGroupRef}
            className="flex flex-1 min-w-0 items-center gap-0.5 overflow-hidden"
          >
            {renderLeftButtons(effectiveLeftButtons, leftVisibleSet)}
          </div>
          <div className="app-no-drag">{renderOverflowMenu(leftOverflow, "left")}</div>
        </div>

        {/* CENTER GROUP - Grid-centered, shrinks gracefully on narrow windows */}
        <div
          role="group"
          aria-label="Project"
          className="flex items-center justify-center min-w-0 max-w-full pointer-events-none justify-self-center"
        >
          <ProjectSwitcherPalette
            mode="dropdown"
            isOpen={isDropdownOpen}
            query={projectSwitcher.query}
            results={projectSwitcher.results}
            selectedIndex={projectSwitcher.selectedIndex}
            onQueryChange={projectSwitcher.setQuery}
            onSelectPrevious={projectSwitcher.selectPrevious}
            onSelectNext={projectSwitcher.selectNext}
            onSelect={projectSwitcher.selectProject}
            onClose={handleDropdownClose}
            onAddProject={projectSwitcher.addProject}
            onCloneRepo={projectSwitcher.cloneRepo}
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            onTogglePinProject={projectSwitcher.togglePinProject}
            onOpenProjectSettings={currentProject ? handleOpenProjectSettings : undefined}
            onSelectNewWindow={handleSelectNewWindow}
            dropdownAlign="center"
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={handleRemoveConfirmClose}
            onConfirmRemove={projectSwitcher.confirmRemoveProject}
            isRemovingProject={projectSwitcher.isRemovingProject}
          >
            <button
              data-toolbar-item=""
              className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden border px-3 outline-none"
              data-testid="project-switcher-trigger"
              onClick={() => projectSwitcher.open("dropdown")}
            >
              {currentProject ? (
                <>
                  <span className="text-base leading-none shrink-0" aria-label="Project emoji">
                    {currentProject.emoji}
                  </span>
                  <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-daintree-text">
                    {currentProject.name}
                  </span>
                  {branchName && (
                    <span
                      className="toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums"
                      aria-label={`Current branch ${branchName}`}
                    >
                      <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
                      <span className="toolbar-project-chip-label">{branchName}</span>
                    </span>
                  )}
                  <ChevronsUpDown className="toolbar-project-meta ml-0.5 h-3 w-3 shrink-0" />
                </>
              ) : (
                <>
                  <span className="text-xs font-medium text-daintree-text tracking-wide truncate min-w-0">
                    Daintree
                  </span>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-daintree-accent/20 text-daintree-accent shrink-0">
                    Beta
                  </span>
                  <ChevronsUpDown className="toolbar-project-meta ml-0.5 h-3 w-3 shrink-0" />
                </>
              )}
            </button>
          </ProjectSwitcherPalette>
        </div>

        {/* RIGHT GROUP */}
        <div
          role="group"
          aria-label="Tools and settings"
          className="flex items-center justify-end gap-1.5 z-20"
        >
          <div
            ref={rightGroupRef}
            className="flex flex-1 min-w-0 items-center gap-0.5 overflow-hidden justify-end"
          >
            {renderButtons(effectiveRightButtons, rightVisibleSet)}
          </div>
          <div className="app-no-drag">{renderOverflowMenu(rightOverflow, "right")}</div>

          <div className={toolbarDividerClass} />

          <div className="app-no-drag">{buttonRegistry["portal-toggle"]!.render()}</div>
        </div>
      </div>
    </header>
  );
}
