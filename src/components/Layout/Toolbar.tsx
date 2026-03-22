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
  Copy,
  Check,
  Loader2,
  ChevronsUpDown,
  Globe,
  Leaf,
  Monitor,
  Bell,
  LayoutGrid,
  Signal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isMac, isLinux, createTooltipWithShortcut } from "@/lib/platform";
import { getProjectGradient } from "@/lib/colorUtils";
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
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useProjectSettings, useKeybindingDisplay } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import {
  usePortalStore,
  usePreferencesStore,
  useToolbarPreferencesStore,
  useVoiceRecordingStore,
  usePaletteStore,
} from "@/store";
import type { ToolbarButtonId } from "@/../../shared/types/toolbar";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useNativeContextMenu } from "@/hooks";
import type { CliAvailability, AgentSettings } from "@shared/types";
import type { MenuItemOption } from "@/types";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { DetectedServersList } from "@/components/DetectedServers/DetectedServersList";
import type { DetectedDevServer } from "@shared/types/ipc/globalDevServers";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

const AGENT_TOOLBAR_IDS = new Set<ToolbarButtonId>([
  "agent-setup",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
]);

interface ToolbarProps {
  onLaunchAgent: (type: string) => void;
  onSettings: () => void;
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
  errorCount = 0,
  onToggleProblems,
  isFocusMode = false,
  onToggleFocusMode,
  agentAvailability,
  agentSettings,
  projectSwitcherPalette,
}: ToolbarProps) {
  const { showMenu } = useNativeContextMenu();
  const currentProject = useProjectStore((state) => state.currentProject);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const projectSwitcher = projectSwitcherPalette;
  const { settings: projectSettings } = useProjectSettings();
  const devServerCommand = projectSettings?.devServerCommand?.trim();
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

  const [detectedServers, setDetectedServers] = useState<DetectedDevServer[]>([]);
  const [detectedServersOpen, setDetectedServersOpen] = useState(false);
  const detectedServersButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void window.electron.globalDevServers.get().then((result) => {
      setDetectedServers(result.servers);
    });
    const cleanup = window.electron.globalDevServers.onChanged((payload) => {
      setDetectedServers(payload.servers);
    });
    return cleanup;
  }, []);

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

  const handleSettingsContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const template: MenuItemOption[] = [
        { id: "settings:general", label: "General" },
        { id: "settings:agents", label: "Agents" },
        { id: "settings:terminal", label: "Terminal" },
        { id: "settings:keyboard", label: "Keyboard" },
        { id: "settings:notifications", label: "Notifications" },
        { id: "settings:portal", label: "Portal" },
        { type: "separator" },
        { id: "settings:toolbar", label: "Customize Toolbar…" },
        { id: "settings:troubleshooting", label: "Troubleshooting" },
      ];

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      const tab = actionId.replace("settings:", "");
      void actionService.dispatch("app.settings.openTab", { tab }, { source: "context-menu" });
    },
    [showMenu]
  );

  const getToolbarItems = useCallback(
    () =>
      toolbarRef.current
        ? Array.from(
            toolbarRef.current.querySelectorAll<HTMLElement>("[data-toolbar-item]:not(:disabled)")
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

  const buttonRegistry = useMemo<
    Record<ToolbarButtonId, { render: () => React.ReactNode; isAvailable: boolean }>
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
                  className="text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
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
                  className="text-canopy-text hover:bg-overlay-medium transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
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
                  className="text-canopy-text hover:bg-overlay-medium transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
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
      "dev-server": {
        render: () => (
          <div key="dev-server" className="relative inline-flex items-center gap-0.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      data-toolbar-item=""
                      onClick={() => {
                        void actionService.dispatch("devServer.start", undefined, {
                          source: "user",
                        });
                      }}
                      disabled={!currentProject}
                      className="text-canopy-text hover:bg-overlay-medium transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
                      aria-label={
                        !currentProject
                          ? "Open a project to use Dev Preview"
                          : devServerCommand
                            ? "Start Dev Server"
                            : "Open Dev Preview"
                      }
                    >
                      <Monitor />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {!currentProject
                    ? "Open a project to use Dev Preview"
                    : devServerCommand
                      ? "Start Dev Server"
                      : "Open Dev Preview"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {detectedServers.length > 0 && (
              <>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        ref={detectedServersButtonRef}
                        variant="ghost"
                        size="icon"
                        data-toolbar-item=""
                        onClick={() => setDetectedServersOpen(!detectedServersOpen)}
                        className="relative text-canopy-text hover:bg-overlay-medium transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent h-8 w-8"
                        aria-label={`${detectedServers.length} detected dev servers`}
                      >
                        <Signal className="h-4 w-4" />
                        <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-canopy-accent text-[10px] font-bold tabular-nums text-accent-foreground">
                          {detectedServers.length}
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Detected Dev Servers</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <FixedDropdown
                  open={detectedServersOpen}
                  onOpenChange={setDetectedServersOpen}
                  anchorRef={detectedServersButtonRef}
                  className="p-0 w-[350px]"
                >
                  <DetectedServersList
                    servers={detectedServers}
                    onOpen={(url) => {
                      void actionService.dispatch(
                        "devServer.openDetected",
                        { url },
                        { source: "user" }
                      );
                    }}
                    onClose={() => setDetectedServersOpen(false)}
                  />
                </FixedDropdown>
              </>
            )}
          </div>
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
                  className="text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
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
              className="relative flex items-center h-8 rounded-[var(--radius-md)] overflow-hidden bg-overlay-soft border border-divider divide-x divide-[var(--border-divider)] mr-2"
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
                        "text-canopy-text hover:bg-overlay-medium hover:text-text-primary h-full px-3 gap-2 rounded-none rounded-l-[var(--radius-md)]",
                        stats?.issueCount === 0 && "opacity-50",
                        isStale && "opacity-60",
                        issuesOpen &&
                          "bg-overlay-medium ring-1 ring-github-open/20 text-text-primary"
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
                        "text-canopy-text hover:bg-overlay-medium hover:text-text-primary h-full px-3 gap-2 rounded-none",
                        stats?.prCount === 0 && "opacity-50",
                        isStale && "opacity-60",
                        prsOpen &&
                          "bg-overlay-medium ring-1 ring-github-merged/20 text-text-primary"
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
                        "text-canopy-text hover:bg-overlay-medium hover:text-text-primary h-full px-3 gap-2 rounded-none rounded-r-[var(--radius-md)]",
                        stats?.commitCount === 0 && "opacity-50",
                        commitsOpen &&
                          "bg-overlay-medium ring-1 ring-border-strong text-text-primary"
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
                    projectPath={currentProject.path}
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
                    className="text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
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
        isAvailable: true,
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
                  className="text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
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
                    "transition-colors",
                    treeCopied
                      ? "text-status-success bg-status-success/10"
                      : "text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent",
                    isCopyingTree && "cursor-wait opacity-70",
                    !activeWorktree && "opacity-50"
                  )}
                  aria-label={
                    isCopyingTree ? "Copying…" : treeCopied ? "Context Copied" : "Copy Context"
                  }
                >
                  {isCopyingTree ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" />
                  ) : treeCopied ? (
                    <Check />
                  ) : (
                    <Copy />
                  )}
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
          <TooltipProvider key="settings">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  onClick={onSettings}
                  onContextMenu={handleSettingsContextMenu}
                  className="text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
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
                    "text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent relative transition-colors",
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
                  className={cn(
                    "text-canopy-text hover:bg-overlay-medium hover:text-canopy-accent transition-colors"
                  )}
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
      devServerCommand,
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
      handleSettingsContextMenu,
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
      detectedServers,
      detectedServersOpen,
      setIssueSearchQuery,
      setPrSearchQuery,
    ]
  );

  const renderButtons = (buttonIds: ToolbarButtonId[]) => {
    return buttonIds
      .filter((id) => buttonRegistry[id]?.isAvailable)
      .map((id) => buttonRegistry[id].render());
  };

  const renderLeftButtons = (buttonIds: ToolbarButtonId[]) => {
    const visible = buttonIds.filter((id) => buttonRegistry[id]?.isAvailable);
    const elements: React.ReactNode[] = [];
    for (let i = 0; i < visible.length; i++) {
      elements.push(buttonRegistry[visible[i]].render());
      if (
        i < visible.length - 1 &&
        AGENT_TOOLBAR_IDS.has(visible[i]) !== AGENT_TOOLBAR_IDS.has(visible[i + 1])
      ) {
        elements.push(
          <div
            key={`group-divider-${i}`}
            className="w-px h-5 bg-border-divider mx-1"
            aria-hidden="true"
          />
        );
      }
    }
    return elements;
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
        className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] h-12 items-center px-4 pt-1 shrink-0 app-drag-region surface-toolbar border-b border-divider"
      >
        {!isLinux() && <div className="window-resize-strip" />}

        {/* LEFT GROUP */}
        <div
          role="group"
          aria-label="Navigation and agents"
          className="flex items-center gap-1.5 app-no-drag z-20 justify-self-start"
        >
          {isMac() && (
            <div
              className={cn(
                "shrink-0 transition-[width] duration-200",
                isFullscreen ? "w-0" : "w-16"
              )}
            />
          )}
          {buttonRegistry["sidebar-toggle"].render()}

          <div className="w-px h-5 bg-border-divider mx-1" />

          <div className="flex items-center gap-0.5">
            {renderLeftButtons(toolbarLayout.leftButtons)}
          </div>
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
              className={cn(
                "app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden rounded-[var(--radius-md)] border border-border-subtle px-3 shadow-[inset_0_1px_0_var(--color-overlay-strong)] outline-none",
                "cursor-pointer transition-colors hover:border-border-default hover:shadow-[inset_0_1px_0_var(--color-overlay-emphasis)]"
              )}
              data-testid="project-switcher-trigger"
              style={{
                background: currentProject
                  ? `linear-gradient(180deg, color-mix(in oklab, var(--color-overlay-soft) 70%, transparent), color-mix(in oklab, var(--color-overlay-medium) 75%, transparent)), ${getProjectGradient(currentProject.color)}`
                  : "linear-gradient(135deg, var(--color-surface-panel-elevated), var(--color-surface-panel))",
              }}
              onClick={() => projectSwitcher.open("dropdown")}
            >
              {currentProject ? (
                <>
                  <span className="text-base leading-none shrink-0" aria-label="Project emoji">
                    {currentProject.emoji}
                  </span>
                  <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-canopy-text [text-shadow:0_1px_0_rgba(255,255,255,0.18)]">
                    {currentProject.name}
                  </span>
                  {branchName && (
                    <span
                      className="shrink-0 rounded-full border border-border-subtle bg-overlay-soft px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-secondary"
                      aria-label={`Current branch ${branchName}`}
                    >
                      {branchName}
                    </span>
                  )}
                  <ChevronsUpDown className="ml-0.5 h-3 w-3 shrink-0 text-text-muted" />
                </>
              ) : (
                <>
                  <span className="text-xs font-medium text-canopy-text tracking-wide truncate min-w-0">
                    Canopy Command Center
                  </span>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent shrink-0">
                    Beta
                  </span>
                  <ChevronsUpDown className="ml-0.5 h-3 w-3 shrink-0 text-text-muted" />
                </>
              )}
            </button>
          </ProjectSwitcherPalette>
        </div>

        {/* RIGHT GROUP */}
        <div
          role="group"
          aria-label="Tools and settings"
          className="flex items-center gap-1.5 app-no-drag z-20 justify-self-end"
        >
          <div className="flex items-center gap-0.5">
            {renderButtons(toolbarLayout.rightButtons)}
          </div>

          <div className="w-px h-5 bg-border-divider mx-1" />

          {buttonRegistry["portal-toggle"].render()}
        </div>
      </div>
    </>
  );
}
