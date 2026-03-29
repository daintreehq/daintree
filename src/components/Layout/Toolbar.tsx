import {
  Suspense,
  lazy,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import {
  SlidersHorizontal,
  SquareTerminal,
  AlertCircle,
  GitCommit,
  GitPullRequest,
  CircleDot,
  PanelRightOpen,
  PanelRightClose,
  PanelLeftOpen,
  PanelLeftClose,
  Check,
  ChevronsUpDown,
  Globe,
  Leaf,
  Bell,
  LayoutGrid,
  Ellipsis,
  GitBranch,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { CopyTreeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { isMac, isLinux, createTooltipWithShortcut } from "@/lib/platform";
const LazyGitHubResourceList = lazy(() =>
  import("@/components/GitHub/GitHubResourceList").then((m) => ({
    default: m.GitHubResourceList,
  }))
);
const LazyCommitList = lazy(() =>
  import("@/components/GitHub/CommitList").then((m) => ({ default: m.CommitList }))
);
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
} from "@/components/GitHub/GitHubDropdownSkeletons";
import { AgentButton } from "./AgentButton";
import { AgentSetupButton } from "./AgentSetupButton";
import { GitHubStatusIndicator, type GitHubStatusIndicatorStatus } from "./GitHubStatusIndicator";
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
import { useProjectStore } from "@/store/projectStore";
import {
  usePortalStore,
  usePreferencesStore,
  useToolbarPreferencesStore,
  useVoiceRecordingStore,
  usePaletteStore,
} from "@/store";
import type { ToolbarButtonId, AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { Puzzle } from "lucide-react";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import type { CliAvailability, AgentSettings } from "@shared/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

const AGENT_TOOLBAR_IDS = new Set<ToolbarButtonId>([
  "agent-setup",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
]);

const OVERFLOW_MENU_META: Partial<
  Record<AnyToolbarButtonId, { label: string; icon: React.ComponentType<{ className?: string }> }>
> = {
  claude: { label: "Claude", icon: SquareTerminal },
  gemini: { label: "Gemini", icon: SquareTerminal },
  codex: { label: "Codex", icon: SquareTerminal },
  opencode: { label: "OpenCode", icon: SquareTerminal },
  cursor: { label: "Cursor", icon: SquareTerminal },
  terminal: { label: "Terminal", icon: SquareTerminal },
  browser: { label: "Browser", icon: Globe },
  "panel-palette": { label: "Panel Palette", icon: LayoutGrid },
  "github-stats": { label: "GitHub Stats", icon: GitPullRequest },
  "notification-center": { label: "Notifications", icon: Bell },
  notes: { label: "Notes", icon: Leaf },
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
  const {
    stats,
    loading: statsLoading,
    error: statsError,
    refresh: refreshStats,
    isStale,
    lastUpdated,
  } = useRepositoryStats();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeDataStore((state) =>
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

  const portalOpen = usePortalStore((state) => state.isOpen);
  const togglePortal = usePortalStore((state) => state.toggle);
  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const setIssueSearchQuery = useGitHubFilterStore((s) => s.setIssueSearchQuery);
  const setPrSearchQuery = useGitHubFilterStore((s) => s.setPrSearchQuery);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const issuesButtonRef = useRef<HTMLButtonElement>(null);
  const prsButtonRef = useRef<HTMLButtonElement>(null);
  const commitsButtonRef = useRef<HTMLButtonElement>(null);
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { notificationCenterOpen, toggleNotificationCenter, closeNotificationCenter } = useUIStore(
    useShallow((s) => ({
      notificationCenterOpen: s.notificationCenterOpen,
      toggleNotificationCenter: s.toggleNotificationCenter,
      closeNotificationCenter: s.closeNotificationCenter,
    }))
  );
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);
  useEffect(() => {
    if (!notificationsEnabled && notificationCenterOpen) closeNotificationCenter();
  }, [notificationsEnabled, notificationCenterOpen, closeNotificationCenter]);
  const hasActiveVoiceRecording = useVoiceRecordingStore(
    (state) =>
      state.activeTarget !== null &&
      (state.status === "connecting" ||
        state.status === "recording" ||
        state.status === "finishing")
  );
  const [statsJustUpdated, setStatsJustUpdated] = useState(false);
  const prevLastUpdatedRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const activeToolbarIndexRef = useRef<number>(0);

  const { handleCopyTree } = useWorktreeActions();
  const terminalShortcut = useKeybindingDisplay("agent.terminal");
  const browserShortcut = useKeybindingDisplay("agent.browser");
  const panelPaletteShortcut = useKeybindingDisplay("panel.palette");
  const sidebarShortcut = useKeybindingDisplay("nav.toggleSidebar");
  const diagnosticsShortcut = useKeybindingDisplay("panel.toggleDiagnostics");
  const portalShortcut = useKeybindingDisplay("panel.togglePortal");
  const notesShortcut = useKeybindingDisplay("notes.openPalette");
  const settingsShortcut = useKeybindingDisplay("app.settings");
  const panelPaletteOpen = usePaletteStore((state) => state.activePaletteId === "panel");

  const handleTogglePanelPalette = useCallback(() => {
    if (usePaletteStore.getState().activePaletteId === "panel") {
      usePaletteStore.getState().closePalette("panel");
    } else {
      void actionService.dispatch("panel.palette", undefined, { source: "user" });
    }
  }, []);

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

  const getTimeSinceUpdate = useCallback((timestamp: number | null): string => {
    if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
      return "unknown";
    }

    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return "just now";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }, []);

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

  useEffect(() => {
    if (statsLoading || statsError) {
      setStatsJustUpdated(false);
    } else if (
      lastUpdated != null &&
      prevLastUpdatedRef.current != null &&
      lastUpdated > prevLastUpdatedRef.current
    ) {
      setStatsJustUpdated(true);
    }
    prevLastUpdatedRef.current = lastUpdated;
  }, [lastUpdated, statsLoading, statsError]);

  const getGitHubIndicatorStatus = useCallback((): GitHubStatusIndicatorStatus => {
    if (statsLoading) return "loading";
    if (statsError) return "error";
    if (statsJustUpdated) return "success";
    return "idle";
  }, [statsLoading, statsError, statsJustUpdated]);

  const handleGitHubStatusTransitionEnd = useCallback(() => {
    setStatsJustUpdated(false);
  }, []);

  const handleCopyTreeClick = useCallback(async () => {
    if (isCopyingTree || !activeWorktree) return;

    setIsCopyingTree(true);

    try {
      const resultMessage = await handleCopyTree(activeWorktree);

      if (resultMessage) {
        setTreeCopied(true);
        setCopyFeedback(resultMessage);

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

  const settingsContextMenuTabs = useMemo(
    () => [
      { tab: "general", label: "General" },
      { tab: "agents", label: "Agents" },
      { tab: "terminal", label: "Terminal" },
      { tab: "keyboard", label: "Keyboard" },
      { tab: "notifications", label: "Notifications" },
      { tab: "portal", label: "Portal" },
    ],
    []
  );

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
        items[newIdx].focus();
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  const hasAnySelectedAgent = useMemo(() => {
    if (!agentSettings) return true;
    const agents = agentSettings.agents ?? {};
    return BUILT_IN_AGENT_IDS.some((id) => agents[id]?.selected !== false);
  }, [agentSettings]);

  const toolbarIconButtonClass = "toolbar-icon-button text-canopy-text transition-colors";
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
      "agent-setup": {
        render: () => <AgentSetupButton key="agent-setup" data-toolbar-item="" />,
        isAvailable: !hasAnySelectedAgent,
      },
      claude: {
        render: () => (
          <AgentButton
            key="claude"
            type="claude"
            availability={agentAvailability?.claude}
            data-toolbar-item=""
          />
        ),
        isAvailable: !agentSettings || agentSettings.agents?.claude?.selected !== false,
      },
      gemini: {
        render: () => (
          <AgentButton
            key="gemini"
            type="gemini"
            availability={agentAvailability?.gemini}
            data-toolbar-item=""
          />
        ),
        isAvailable: !agentSettings || agentSettings.agents?.gemini?.selected !== false,
      },
      codex: {
        render: () => (
          <AgentButton
            key="codex"
            type="codex"
            availability={agentAvailability?.codex}
            data-toolbar-item=""
          />
        ),
        isAvailable: !agentSettings || agentSettings.agents?.codex?.selected !== false,
      },
      opencode: {
        render: () => (
          <AgentButton
            key="opencode"
            type="opencode"
            availability={agentAvailability?.opencode}
            data-toolbar-item=""
          />
        ),
        isAvailable: !agentSettings || agentSettings.agents?.opencode?.selected !== false,
      },
      cursor: {
        render: () => (
          <AgentButton
            key="cursor"
            type="cursor"
            availability={agentAvailability?.cursor}
            data-toolbar-item=""
          />
        ),
        isAvailable: !agentSettings || agentSettings.agents?.cursor?.selected !== false,
      },
      terminal: {
        render: () => (
          <TooltipProvider key="terminal">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={() => onLaunchAgent("terminal")}
                  className={toolbarIconButtonClass}
                  aria-label="Open Terminal"
                >
                  <SquareTerminal />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Open Terminal", terminalShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      browser: {
        render: () => (
          <TooltipProvider key="browser">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={() => onLaunchAgent("browser")}
                  className={toolbarIconButtonClass}
                  aria-label="Open Browser"
                >
                  <Globe />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Open Browser", browserShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      "panel-palette": {
        render: () => (
          <TooltipProvider key="panel-palette">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={handleTogglePanelPalette}
                  className={toolbarIconButtonClass}
                  aria-label={panelPaletteOpen ? "Close panel palette" : "Open panel palette"}
                  aria-pressed={panelPaletteOpen}
                >
                  <LayoutGrid />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Panel Palette", panelPaletteShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      "voice-recording": {
        render: () => <VoiceRecordingToolbarButton key="voice-recording" data-toolbar-item="" />,
        isAvailable: hasActiveVoiceRecording,
      },
      "github-stats": {
        render: () =>
          currentProject ? (
            <div
              key="github-stats"
              className="toolbar-stats relative mr-2 flex h-8 items-center overflow-hidden rounded-[var(--toolbar-pill-radius,0.5rem)] border divide-x divide-[var(--toolbar-stats-divider,var(--theme-border-subtle))]"
              style={{
                ["--toolbar-stats-divider" as string]:
                  "var(--toolbar-stats-divider,var(--theme-border-subtle))",
              }}
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      ref={issuesButtonRef}
                      variant="ghost"
                      data-toolbar-item=""
                      onClick={() => {
                        setPrsOpen(false);
                        setPrSearchQuery("");
                        setCommitsOpen(false);
                        const willOpen = !issuesOpen;
                        setIssuesOpen(willOpen);
                        if (!willOpen) setIssueSearchQuery("");
                        if (willOpen) refreshStats({ force: true });
                      }}
                      className={cn(
                        "h-full gap-2 rounded-none px-3 text-canopy-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                        stats?.issueCount === 0 && "opacity-50",
                        isStale && "opacity-60",
                        issuesOpen &&
                          "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-open/20"
                      )}
                      aria-label={`${stats?.issueCount ?? "\u2014"} open issues${isStale ? " (cached)" : ""}`}
                    >
                      <CircleDot className="h-4 w-4 text-github-open" />
                      <span className="text-xs font-medium tabular-nums">
                        {stats?.issueCount ?? "\u2014"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isStale
                      ? `${stats?.issueCount ?? "\u2014"} open issues (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                      : "Browse GitHub Issues"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <FixedDropdown
                open={issuesOpen}
                onOpenChange={(open) => {
                  setIssuesOpen(open);
                  if (!open) {
                    setIssueSearchQuery("");
                    issuesButtonRef.current?.focus();
                  }
                }}
                anchorRef={issuesButtonRef}
                className="p-0 w-[450px]"
                persistThroughChildOverlays
              >
                <Suspense
                  fallback={
                    <GitHubResourceListSkeleton count={stats?.issueCount} immediate type="issue" />
                  }
                >
                  <LazyGitHubResourceList
                    type="issue"
                    projectPath={currentProject.path}
                    onClose={() => {
                      setIssuesOpen(false);
                      setIssueSearchQuery("");
                      issuesButtonRef.current?.focus();
                    }}
                    initialCount={stats?.issueCount}
                  />
                </Suspense>
              </FixedDropdown>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      ref={prsButtonRef}
                      variant="ghost"
                      data-toolbar-item=""
                      onClick={() => {
                        setIssuesOpen(false);
                        setIssueSearchQuery("");
                        setCommitsOpen(false);
                        const willOpen = !prsOpen;
                        setPrsOpen(willOpen);
                        if (!willOpen) setPrSearchQuery("");
                        if (willOpen) refreshStats({ force: true });
                      }}
                      className={cn(
                        "h-full gap-2 rounded-none px-3 text-canopy-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                        stats?.prCount === 0 && "opacity-50",
                        isStale && "opacity-60",
                        prsOpen &&
                          "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-merged/20"
                      )}
                      aria-label={`${stats?.prCount ?? "\u2014"} open pull requests${isStale ? " (cached)" : ""}`}
                    >
                      <GitPullRequest className="h-4 w-4 text-github-merged" />
                      <span className="text-xs font-medium tabular-nums">
                        {stats?.prCount ?? "\u2014"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isStale
                      ? `${stats?.prCount ?? "\u2014"} open PRs (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                      : "Browse GitHub Pull Requests"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <FixedDropdown
                open={prsOpen}
                onOpenChange={(open) => {
                  setPrsOpen(open);
                  if (!open) {
                    setPrSearchQuery("");
                    prsButtonRef.current?.focus();
                  }
                }}
                anchorRef={prsButtonRef}
                className="p-0 w-[450px]"
              >
                <Suspense
                  fallback={
                    <GitHubResourceListSkeleton count={stats?.prCount} immediate type="pr" />
                  }
                >
                  <LazyGitHubResourceList
                    type="pr"
                    projectPath={currentProject.path}
                    onClose={() => {
                      setPrsOpen(false);
                      setPrSearchQuery("");
                      prsButtonRef.current?.focus();
                    }}
                    initialCount={stats?.prCount}
                  />
                </Suspense>
              </FixedDropdown>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      ref={commitsButtonRef}
                      variant="ghost"
                      data-toolbar-item=""
                      onClick={() => {
                        setIssuesOpen(false);
                        setIssueSearchQuery("");
                        setPrsOpen(false);
                        setPrSearchQuery("");
                        setCommitsOpen(!commitsOpen);
                      }}
                      className={cn(
                        "h-full gap-2 rounded-none px-3 text-canopy-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                        stats?.commitCount === 0 && "opacity-50",
                        commitsOpen &&
                          "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-border-strong"
                      )}
                      aria-label={`${stats?.commitCount ?? "\u2014"} commits`}
                    >
                      <GitCommit className="h-4 w-4" />
                      <span className="text-xs font-medium tabular-nums">
                        {stats?.commitCount ?? "\u2014"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Browse Git Commits</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <FixedDropdown
                open={commitsOpen}
                onOpenChange={(open) => {
                  setCommitsOpen(open);
                  if (!open) commitsButtonRef.current?.focus();
                }}
                anchorRef={commitsButtonRef}
                className="p-0 w-[450px]"
              >
                <Suspense fallback={<CommitListSkeleton count={stats?.commitCount} immediate />}>
                  <LazyCommitList
                    projectPath={activeWorktree?.path ?? currentProject.path}
                    branch={activeWorktree?.branch ?? activeWorktree?.head}
                    onClose={() => {
                      setCommitsOpen(false);
                      commitsButtonRef.current?.focus();
                    }}
                    initialCount={stats?.commitCount}
                  />
                </Suspense>
              </FixedDropdown>
              <GitHubStatusIndicator
                status={getGitHubIndicatorStatus()}
                error={statsError ?? undefined}
                onTransitionEnd={handleGitHubStatusTransitionEnd}
              />
            </div>
          ) : null,
        isAvailable: !!currentProject,
      },
      "notification-center": {
        render: () => (
          <div key="notification-center" className="relative">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={notificationCenterButtonRef}
                    variant="ghost"
                    size="icon"
                    data-toolbar-item=""
                    onClick={toggleNotificationCenter}
                    className={toolbarIconButtonClass}
                    aria-label={
                      notificationUnreadCount > 0
                        ? `Notifications — ${notificationUnreadCount} unread`
                        : "Notifications"
                    }
                    aria-expanded={notificationCenterOpen}
                    aria-haspopup="dialog"
                  >
                    <Bell />
                    {notificationUnreadCount > 0 && (
                      <span className="absolute top-1 right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-canopy-accent text-[9px] font-bold tabular-nums text-canopy-bg px-0.5 leading-none">
                        {notificationUnreadCount > 99 ? "99+" : notificationUnreadCount}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Notifications</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <FixedDropdown
              open={notificationCenterOpen}
              onOpenChange={(open) => {
                if (!open) closeNotificationCenter();
              }}
              anchorRef={notificationCenterButtonRef}
              className="p-0"
            >
              <NotificationCenter open={notificationCenterOpen} onClose={closeNotificationCenter} />
            </FixedDropdown>
          </div>
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
                  <Leaf />
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
                    treeCopied ? "text-status-success bg-status-success/10" : "text-canopy-text",
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
                  "Copy Context"
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      settings: {
        render: () => (
          <ContextMenu key="settings">
            <ContextMenuTrigger asChild>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      data-toolbar-item=""
                      onClick={onSettings}
                      onPointerEnter={onPreloadSettings}
                      className={toolbarIconButtonClass}
                      aria-label="Open settings"
                    >
                      <SlidersHorizontal />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipWithShortcut("Open Settings", settingsShortcut)}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {settingsContextMenuTabs.map(({ tab, label }) => (
                <ContextMenuItem
                  key={tab}
                  onSelect={() =>
                    void actionService.dispatch(
                      "app.settings.openTab",
                      { tab },
                      { source: "context-menu" }
                    )
                  }
                >
                  {label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() =>
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "toolbar" },
                    { source: "context-menu" }
                  )
                }
              >
                Customize Toolbar…
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "troubleshooting" },
                    { source: "context-menu" }
                  )
                }
              >
                Troubleshooting
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ),
        isAvailable: true,
      },
      problems: {
        render: () => (
          <TooltipProvider key="problems">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={onToggleProblems}
                  className={cn(
                    toolbarIconButtonClass,
                    "relative",
                    errorCount > 0 && "text-status-error"
                  )}
                  aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}`}
                >
                  <AlertCircle />
                  {errorCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-status-error rounded-full" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Show Problems Panel", diagnosticsShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: showDeveloperTools,
      },
      "portal-toggle": {
        render: () => (
          <TooltipProvider key="portal-toggle">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={togglePortal}
                  className={toolbarIconButtonClass}
                  aria-label={portalOpen ? "Close context portal" : "Open context portal"}
                  aria-pressed={portalOpen}
                >
                  {portalOpen ? (
                    <PanelRightClose aria-hidden="true" />
                  ) : (
                    <PanelRightOpen aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut(
                  portalOpen ? "Close Context Portal" : "Open Context Portal",
                  portalShortcut
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
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
                        <Puzzle />
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
      agentSettings,
      hasAnySelectedAgent,
      onLaunchAgent,
      terminalShortcut,
      browserShortcut,
      sidebarShortcut,
      diagnosticsShortcut,
      portalShortcut,
      notesShortcut,
      settingsShortcut,
      panelPaletteOpen,
      panelPaletteShortcut,
      handleTogglePanelPalette,
      hasActiveVoiceRecording,
      stats,
      currentProject,
      issuesOpen,
      prsOpen,
      commitsOpen,
      isStale,
      lastUpdated,
      refreshStats,
      getGitHubIndicatorStatus,
      handleGitHubStatusTransitionEnd,
      statsError,
      handleCopyTreeClick,
      isCopyingTree,
      activeWorktree,
      treeCopied,
      copyFeedback,
      onSettings,
      settingsContextMenuTabs,
      onPreloadSettings,
      onToggleProblems,
      errorCount,
      showDeveloperTools,
      togglePortal,
      portalOpen,
      getTimeSinceUpdate,
      notificationCenterOpen,
      toggleNotificationCenter,
      closeNotificationCenter,
      notificationUnreadCount,
      setIssueSearchQuery,
      setPrSearchQuery,
      notificationsEnabled,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  const effectiveLeftButtons = useMemo(
    () => [...toolbarLayout.leftButtons],
    [toolbarLayout.leftButtons]
  );

  const effectiveRightButtons = useMemo(() => {
    const existing = new Set(toolbarLayout.rightButtons);
    const extra = pluginButtonIds.filter((id) => !existing.has(id));
    return [...toolbarLayout.rightButtons, ...extra];
  }, [toolbarLayout.rightButtons, pluginButtonIds]);

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
      setIssuesOpen(false);
      setPrsOpen(false);
      setCommitsOpen(false);
    }
    if (overflowSet.has("notification-center")) {
      closeNotificationCenter();
    }
  }, [leftOverflow, rightOverflow, closeNotificationCenter]);

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
          {buttonRegistry[id].render()}
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
          {buttonRegistry[id].render()}
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
        meta[id] = { label: config.label, icon: Puzzle };
      }
    }
    return meta;
  }, [pluginButtonIds, pluginConfigs]);

  const overflowActions = useMemo<Partial<Record<AnyToolbarButtonId, () => void>>>(
    () => ({
      claude: () => onLaunchAgent("claude"),
      gemini: () => onLaunchAgent("gemini"),
      codex: () => onLaunchAgent("codex"),
      opencode: () => onLaunchAgent("opencode"),
      cursor: () => onLaunchAgent("cursor"),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "panel-palette": handleTogglePanelPalette,
      "notification-center": toggleNotificationCenter,
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
      handleTogglePanelPalette,
      toggleNotificationCenter,
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
              const items = [
                <DropdownMenuItem key="gh-issues" onClick={() => setIssuesOpen((p) => !p)}>
                  <CircleDot className="mr-2 h-4 w-4 text-github-open" />
                  Issues {stats?.issueCount != null ? `(${stats.issueCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem key="gh-prs" onClick={() => setPrsOpen((p) => !p)}>
                  <GitPullRequest className="mr-2 h-4 w-4 text-github-merged" />
                  Pull Requests {stats?.prCount != null ? `(${stats.prCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem key="gh-commits" onClick={() => setCommitsOpen((p) => !p)}>
                  <GitCommit className="mr-2 h-4 w-4" />
                  Commits {stats?.commitCount != null ? `(${stats.commitCount})` : ""}
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
    <>
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
          <div className="app-no-drag">{buttonRegistry["sidebar-toggle"].render()}</div>

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
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            onTogglePinProject={(projectId) => projectSwitcher.togglePinProject(projectId)}
            onOpenProjectSettings={currentProject ? handleOpenProjectSettings : undefined}
            dropdownAlign="center"
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
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
                  <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-canopy-text">
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
                  <span className="text-xs font-medium text-canopy-text tracking-wide truncate min-w-0">
                    Canopy
                  </span>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent shrink-0">
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

          <div className="app-no-drag">{buttonRegistry["portal-toggle"].render()}</div>
        </div>
      </div>
    </>
  );
}
