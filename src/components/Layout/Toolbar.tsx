import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import {
  Settings,
  Terminal,
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
  StickyNote,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { GitHubResourceList, CommitList } from "@/components/GitHub";
import { AgentButton } from "./AgentButton";
import { GitHubStatusIndicator, type GitHubStatusIndicatorStatus } from "./GitHubStatusIndicator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useProjectSettings } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useSidecarStore, usePreferencesStore, useToolbarPreferencesStore } from "@/store";
import type { ToolbarButtonId } from "@/../../shared/types/domain";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useNativeContextMenu } from "@/hooks";
import type { CliAvailability, AgentSettings } from "@shared/types";
import type { MenuItemOption } from "@/types";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";

interface ToolbarProps {
  onLaunchAgent: (
    type: "claude" | "gemini" | "codex" | "opencode" | "terminal" | "browser"
  ) => void;
  onSettings: () => void;
  onOpenAgentSettings?: () => void;
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
  onOpenAgentSettings,
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

  const sidecarOpen = useSidecarStore((state) => state.isOpen);
  const toggleSidecar = useSidecarStore((state) => state.toggle);
  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const issuesButtonRef = useRef<HTMLButtonElement>(null);
  const prsButtonRef = useRef<HTMLButtonElement>(null);
  const commitsButtonRef = useRef<HTMLButtonElement>(null);
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statsJustUpdated, setStatsJustUpdated] = useState(false);
  const prevLastUpdatedRef = useRef<number | null>(null);

  const { handleCopyTree } = useWorktreeActions();

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

  const getTimeSinceUpdate = (timestamp: number | null): string => {
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
  };

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

  const handleCopyTreeClick = async () => {
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
  };

  const openAgentSettings = onOpenAgentSettings ?? onSettings;

  const handleSettingsContextMenu = async (event: React.MouseEvent) => {
    const template: MenuItemOption[] = [
      { id: "settings:general", label: "General" },
      { id: "settings:agents", label: "Agents" },
      { id: "settings:terminal", label: "Terminal" },
      { id: "settings:keyboard", label: "Keyboard" },
      { id: "settings:sidecar", label: "Sidecar" },
      { type: "separator" },
      { id: "settings:troubleshooting", label: "Troubleshooting" },
    ];

    const actionId = await showMenu(event, template);
    if (!actionId) return;

    const tab = actionId.replace("settings:", "");
    void actionService.dispatch("app.settings.openTab", { tab }, { source: "context-menu" });
  };

  const buttonRegistry = useMemo<
    Record<ToolbarButtonId, { render: () => React.ReactNode; isAvailable: boolean }>
  >(
    () => ({
      "sidebar-toggle": {
        render: () => (
          <Button
            key="sidebar-toggle"
            variant="ghost"
            size="icon"
            onClick={onToggleFocusMode}
            className="text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent transition-colors"
            title={isFocusMode ? "Show Sidebar (Cmd+B)" : "Hide Sidebar (Cmd+B)"}
            aria-label="Toggle Sidebar"
            aria-pressed={!isFocusMode}
          >
            {isFocusMode ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        ),
        isAvailable: true,
      },
      claude: {
        render: () => (
          <AgentButton
            key="claude"
            type="claude"
            availability={agentAvailability?.claude}
            isEnabled={agentSettings?.agents?.claude?.enabled ?? true}
            onOpenSettings={openAgentSettings}
          />
        ),
        isAvailable: true,
      },
      gemini: {
        render: () => (
          <AgentButton
            key="gemini"
            type="gemini"
            availability={agentAvailability?.gemini}
            isEnabled={agentSettings?.agents?.gemini?.enabled ?? true}
            onOpenSettings={openAgentSettings}
          />
        ),
        isAvailable: true,
      },
      codex: {
        render: () => (
          <AgentButton
            key="codex"
            type="codex"
            availability={agentAvailability?.codex}
            isEnabled={agentSettings?.agents?.codex?.enabled ?? true}
            onOpenSettings={openAgentSettings}
          />
        ),
        isAvailable: true,
      },
      opencode: {
        render: () => (
          <AgentButton
            key="opencode"
            type="opencode"
            availability={agentAvailability?.opencode}
            isEnabled={agentSettings?.agents?.opencode?.enabled ?? true}
            onOpenSettings={openAgentSettings}
          />
        ),
        isAvailable: true,
      },
      terminal: {
        render: () => (
          <Button
            key="terminal"
            variant="ghost"
            size="icon"
            onClick={() => onLaunchAgent("terminal")}
            className="text-canopy-text hover:bg-white/[0.06] transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
            title="Open Terminal (⌘T for palette)"
            aria-label="Open Terminal"
          >
            <Terminal />
          </Button>
        ),
        isAvailable: true,
      },
      browser: {
        render: () => (
          <Button
            key="browser"
            variant="ghost"
            size="icon"
            onClick={() => onLaunchAgent("browser")}
            className="text-canopy-text hover:bg-white/[0.06] transition-colors hover:text-blue-400 focus-visible:text-blue-400"
            title="Open Browser"
            aria-label="Open Browser"
          >
            <Globe />
          </Button>
        ),
        isAvailable: true,
      },
      "dev-server": {
        render: () => (
          <Button
            key="dev-server"
            variant="ghost"
            size="icon"
            onClick={() => {
              void actionService.dispatch("devServer.start", undefined, { source: "user" });
            }}
            className="text-canopy-text hover:bg-white/[0.06] transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
            title="Start Dev Server"
            aria-label="Start Dev Server"
          >
            <Monitor />
          </Button>
        ),
        isAvailable: !!devServerCommand,
      },
      "github-stats": {
        render: () =>
          stats && currentProject ? (
            <div
              key="github-stats"
              className="relative flex items-center h-8 rounded-[var(--radius-md)] overflow-hidden bg-white/[0.03] border border-divider divide-x divide-[var(--border-divider)] mr-2"
            >
              <Button
                ref={issuesButtonRef}
                variant="ghost"
                onClick={() => {
                  setPrsOpen(false);
                  setCommitsOpen(false);
                  const willOpen = !issuesOpen;
                  setIssuesOpen(willOpen);
                  if (willOpen) {
                    refreshStats({ force: true });
                  }
                }}
                className={cn(
                  "text-canopy-text hover:bg-white/[0.04] hover:text-canopy-accent h-full px-3 gap-2 rounded-none rounded-l-[var(--radius-md)]",
                  stats.issueCount === 0 && "opacity-50",
                  isStale && "opacity-60",
                  issuesOpen && "bg-white/[0.04] ring-1 ring-canopy-accent/20 text-canopy-accent"
                )}
                title={
                  isStale
                    ? `${stats.issueCount ?? "?"} open issues (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                    : "Browse GitHub Issues"
                }
                aria-label={`${stats.issueCount ?? "?"} open issues${isStale ? " (cached)" : ""}`}
              >
                <CircleDot className="h-4 w-4" />
                <span className="text-xs font-medium tabular-nums">{stats.issueCount ?? "?"}</span>
              </Button>
              <FixedDropdown
                open={issuesOpen}
                onOpenChange={setIssuesOpen}
                anchorRef={issuesButtonRef}
                className="p-0 w-[450px]"
              >
                <GitHubResourceList
                  type="issue"
                  projectPath={currentProject.path}
                  onClose={() => setIssuesOpen(false)}
                  initialCount={stats.issueCount}
                />
              </FixedDropdown>
              <Button
                ref={prsButtonRef}
                variant="ghost"
                onClick={() => {
                  setIssuesOpen(false);
                  setCommitsOpen(false);
                  const willOpen = !prsOpen;
                  setPrsOpen(willOpen);
                  if (willOpen) {
                    refreshStats({ force: true });
                  }
                }}
                className={cn(
                  "text-canopy-text hover:bg-white/[0.04] hover:text-canopy-accent h-full px-3 gap-2 rounded-none",
                  stats.prCount === 0 && "opacity-50",
                  isStale && "opacity-60",
                  prsOpen && "bg-white/[0.04] ring-1 ring-canopy-accent/20 text-canopy-accent"
                )}
                title={
                  isStale
                    ? `${stats.prCount ?? "?"} open PRs (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                    : "Browse GitHub Pull Requests"
                }
                aria-label={`${stats.prCount ?? "?"} open pull requests${isStale ? " (cached)" : ""}`}
              >
                <GitPullRequest className="h-4 w-4" />
                <span className="text-xs font-medium tabular-nums">{stats.prCount ?? "?"}</span>
              </Button>
              <FixedDropdown
                open={prsOpen}
                onOpenChange={setPrsOpen}
                anchorRef={prsButtonRef}
                className="p-0 w-[450px]"
              >
                <GitHubResourceList
                  type="pr"
                  projectPath={currentProject.path}
                  onClose={() => setPrsOpen(false)}
                  initialCount={stats.prCount}
                />
              </FixedDropdown>
              <Button
                ref={commitsButtonRef}
                variant="ghost"
                onClick={() => {
                  setIssuesOpen(false);
                  setPrsOpen(false);
                  setCommitsOpen(!commitsOpen);
                }}
                className={cn(
                  "text-canopy-text hover:bg-white/[0.04] hover:text-canopy-accent h-full px-3 gap-2 rounded-none rounded-r-[var(--radius-md)]",
                  stats.commitCount === 0 && "opacity-50",
                  commitsOpen && "bg-white/[0.04] ring-1 ring-canopy-accent/20 text-canopy-accent"
                )}
                title="Browse Git Commits"
                aria-label={`${stats.commitCount} commits`}
              >
                <GitCommit className="h-4 w-4" />
                <span className="text-xs font-medium tabular-nums">{stats.commitCount}</span>
              </Button>
              <FixedDropdown
                open={commitsOpen}
                onOpenChange={setCommitsOpen}
                anchorRef={commitsButtonRef}
                className="p-0 w-[450px]"
              >
                <CommitList
                  projectPath={currentProject.path}
                  onClose={() => setCommitsOpen(false)}
                  initialCount={stats.commitCount}
                />
              </FixedDropdown>
              <GitHubStatusIndicator
                status={getGitHubIndicatorStatus()}
                error={statsError ?? undefined}
                onTransitionEnd={handleGitHubStatusTransitionEnd}
              />
            </div>
          ) : null,
        isAvailable: !!(stats && currentProject),
      },
      notes: {
        render: () => (
          <Button
            key="notes"
            variant="ghost"
            size="icon"
            onClick={() => actionService.dispatch("notes.create", {}, { source: "user" })}
            className="text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent transition-colors"
            title="Notes"
            aria-label="Open notes palette"
          >
            <StickyNote />
          </Button>
        ),
        isAvailable: true,
      },
      "copy-tree": {
        render: () => (
          <TooltipProvider key="copy-tree">
            <Tooltip open={treeCopied} delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopyTreeClick}
                  disabled={isCopyingTree || !activeWorktree}
                  className={cn(
                    "transition-colors",
                    treeCopied
                      ? "text-[var(--color-status-success)] bg-[var(--color-status-success)]/10"
                      : "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent",
                    isCopyingTree && "cursor-wait opacity-70",
                    !activeWorktree && "opacity-50"
                  )}
                  title={activeWorktree ? "Copy Context" : "No active worktree"}
                  aria-label={treeCopied ? "Context Copied" : "Copy Context"}
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
                <span role="status" aria-live="polite">
                  {copyFeedback}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        isAvailable: true,
      },
      settings: {
        render: () => (
          <Button
            key="settings"
            variant="ghost"
            size="icon"
            onClick={onSettings}
            onContextMenu={handleSettingsContextMenu}
            className="text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent transition-colors"
            title="Open Settings"
            aria-label="Open settings"
          >
            <Settings />
          </Button>
        ),
        isAvailable: true,
      },
      problems: {
        render: () => (
          <Button
            key="problems"
            variant="ghost"
            size="icon"
            onClick={onToggleProblems}
            className={cn(
              "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent relative transition-colors",
              errorCount > 0 && "text-[var(--color-status-error)]"
            )}
            title="Show Problems Panel (Ctrl+Shift+M)"
            aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}`}
          >
            <AlertCircle />
            {errorCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[var(--color-status-error)] rounded-full" />
            )}
          </Button>
        ),
        isAvailable: showDeveloperTools,
      },
      assistant: {
        render: () => null,
        isAvailable: false,
      },
      "sidecar-toggle": {
        render: () => (
          <Button
            key="sidecar-toggle"
            variant="ghost"
            size="icon"
            onClick={toggleSidecar}
            className={cn(
              "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent transition-colors"
            )}
            title={sidecarOpen ? "Close Context Sidecar" : "Open Context Sidecar"}
            aria-label={sidecarOpen ? "Close context sidecar" : "Open context sidecar"}
            aria-pressed={sidecarOpen}
          >
            {sidecarOpen ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </Button>
        ),
        isAvailable: true,
      },
    }),
    [
      isFocusMode,
      onToggleFocusMode,
      agentAvailability,
      agentSettings,
      openAgentSettings,
      onLaunchAgent,
      devServerCommand,
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
      toggleSidecar,
      sidecarOpen,
      getTimeSinceUpdate,
    ]
  );

  const renderButtons = (buttonIds: ToolbarButtonId[]) => {
    return buttonIds
      .filter((id) => buttonRegistry[id]?.isAvailable)
      .map((id) => buttonRegistry[id].render());
  };

  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  return (
    <>
      <header className="relative flex h-12 items-center justify-between px-4 pt-1 shrink-0 app-drag-region bg-canopy-sidebar/95 backdrop-blur-sm border-b border-divider shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="window-resize-strip" />

        {/* LEFT GROUP */}
        <div className="flex items-center gap-1.5 app-no-drag z-20">
          <div
            className={cn(
              "shrink-0 transition-[width] duration-200",
              isFullscreen ? "w-0" : "w-16"
            )}
          />
          {buttonRegistry["sidebar-toggle"].render()}

          <div className="w-px h-5 bg-white/[0.08] mx-1" />

          <div className="flex items-center gap-0.5">
            {renderButtons(toolbarLayout.leftButtons)}
          </div>
        </div>

        {/* CENTER GROUP - Absolutely positioned dead center */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center z-10 pointer-events-none">
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
            onOpenProjectSettings={currentProject ? handleOpenProjectSettings : undefined}
            dropdownAlign="center"
          >
            <button
              className={cn(
                "flex items-center justify-center gap-2 px-3 h-9 rounded-[var(--radius-md)] select-none border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] app-no-drag pointer-events-auto outline-none",
                "opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
              )}
              style={{
                background: currentProject
                  ? getProjectGradient(currentProject.color)
                  : "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))",
              }}
              onClick={() => projectSwitcher.open("dropdown")}
            >
              {currentProject ? (
                <>
                  <span className="text-base leading-none" aria-label="Project emoji">
                    {currentProject.emoji}
                  </span>
                  <span className="text-xs font-medium text-white/90 tracking-wide">
                    {currentProject.name}
                  </span>
                  {branchName && (
                    <span
                      className="font-mono text-[10px] tabular-nums text-white/70 px-1.5 py-0.5 rounded-full bg-white/10"
                      aria-label={`Current branch ${branchName}`}
                    >
                      {branchName}
                    </span>
                  )}
                  <ChevronsUpDown className="h-3 w-3 text-white/50 ml-0.5" />
                </>
              ) : (
                <>
                  <span className="text-xs font-medium text-canopy-text tracking-wide">
                    Canopy Command Center
                  </span>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent">
                    Beta
                  </span>
                  <ChevronsUpDown className="h-3 w-3 text-canopy-text/50 ml-0.5" />
                </>
              )}
            </button>
          </ProjectSwitcherPalette>
        </div>

        {/* RIGHT GROUP */}
        <div className="flex items-center gap-1.5 app-no-drag z-20">
          <div className="flex items-center gap-0.5">
            {renderButtons(toolbarLayout.rightButtons)}
          </div>

          <div className="w-px h-5 bg-white/[0.08] mx-1" />

          {buttonRegistry["sidecar-toggle"].render()}
        </div>
      </header>
    </>
  );
}
