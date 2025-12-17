import { useRef, useState, useEffect } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import {
  Settings,
  Terminal,
  AlertCircle,
  GitCommit,
  GitPullRequest,
  AlertTriangle,
  PanelRightOpen,
  PanelRightClose,
  PanelLeft,
  PanelLeftClose,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { GitHubResourceList } from "@/components/GitHub";
import { AgentButton } from "./AgentButton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useProjectStore } from "@/store/projectStore";
import { useSidecarStore } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useNativeContextMenu } from "@/hooks";
import type { CliAvailability, AgentSettings } from "@shared/types";
import type { MenuItemOption } from "@/types";

interface ToolbarProps {
  onLaunchAgent: (type: "claude" | "gemini" | "codex" | "terminal") => void;
  onSettings: () => void;
  onOpenAgentSettings?: () => void;
  errorCount?: number;
  onToggleProblems?: () => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
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
}: ToolbarProps) {
  const { showMenu } = useNativeContextMenu();
  const currentProject = useProjectStore((state) => state.currentProject);
  const { stats, error: statsError, refresh: refreshStats } = useRepositoryStats();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeDataStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );
  const branchName = activeWorktree?.branch;

  const sidecarOpen = useSidecarStore((state) => state.isOpen);
  const toggleSidecar = useSidecarStore((state) => state.toggle);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const issuesButtonRef = useRef<HTMLButtonElement>(null);
  const prsButtonRef = useRef<HTMLButtonElement>(null);
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { handleCopyTree } = useWorktreeActions();

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
    window.dispatchEvent(new CustomEvent("canopy:open-settings-tab", { detail: tab }));
  };

  return (
    <header className="relative h-12 flex items-center px-4 shrink-0 app-drag-region bg-canopy-sidebar/95 backdrop-blur-sm border-b border-canopy-border shadow-sm">
      <div className="window-resize-strip" />

      <div
        className={cn("shrink-0 transition-[width] duration-200", isFullscreen ? "w-0" : "w-16")}
      />

      <div className="flex items-center gap-1 app-no-drag">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleFocusMode}
          className={cn(
            "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-8 w-8 transition-colors mr-2"
          )}
          title={isFocusMode ? "Show Sidebar (Cmd+B)" : "Hide Sidebar (Cmd+B)"}
          aria-label="Toggle Sidebar"
          aria-pressed={!isFocusMode}
        >
          {isFocusMode ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
        <AgentButton
          type="claude"
          availability={agentAvailability?.claude}
          isEnabled={agentSettings?.agents?.claude?.enabled ?? true}
          onLaunch={() => onLaunchAgent("claude")}
          onOpenSettings={openAgentSettings}
        />
        <AgentButton
          type="gemini"
          availability={agentAvailability?.gemini}
          isEnabled={agentSettings?.agents?.gemini?.enabled ?? true}
          onLaunch={() => onLaunchAgent("gemini")}
          onOpenSettings={openAgentSettings}
        />
        <AgentButton
          type="codex"
          availability={agentAvailability?.codex}
          isEnabled={agentSettings?.agents?.codex?.enabled ?? true}
          onLaunch={() => onLaunchAgent("codex")}
          onOpenSettings={openAgentSettings}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onLaunchAgent("terminal")}
          className="text-canopy-text hover:bg-white/[0.06] h-8 w-8 transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
          title="Open Terminal (⌘T for palette)"
          aria-label="Open Terminal"
        >
          <Terminal className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 flex justify-center items-center h-full opacity-70 hover:opacity-100 transition-opacity">
        {currentProject ? (
          <div
            className="flex items-center gap-2 px-3 py-1 rounded-[var(--radius-md)] select-none"
            style={{
              background: getProjectGradient(currentProject.color),
            }}
          >
            <span className="text-lg" aria-label="Project emoji">
              {currentProject.emoji}
            </span>
            <span className="text-xs font-medium text-white tracking-wide drop-shadow-md">
              {currentProject.name}
            </span>
            {branchName && (
              <span
                className="text-xs font-medium text-white/60 tracking-wide drop-shadow-md"
                aria-label={`Current branch ${branchName}`}
              >
                [{branchName}]
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 select-none">
            <span className="text-xs font-medium text-canopy-text tracking-wide">
              Canopy Command Center
            </span>
            <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent">
              Beta
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 app-no-drag">
        {stats && currentProject && (
          <>
            <div className="flex items-center gap-1">
              <Button
                ref={issuesButtonRef}
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPrsOpen(false);
                  const willOpen = !issuesOpen;
                  setIssuesOpen(willOpen);
                  if (willOpen) {
                    refreshStats({ force: true });
                  }
                }}
                className={cn(
                  "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-7 px-2 gap-1.5",
                  (stats.issueCount === 0 || statsError) && "opacity-50",
                  statsError && "text-[var(--color-status-error)]",
                  issuesOpen && "bg-canopy-border text-canopy-accent"
                )}
                title={
                  statsError
                    ? `GitHub error: ${statsError} (click to retry)`
                    : "Browse GitHub Issues"
                }
                aria-label={
                  statsError ? "GitHub stats error" : `${stats.issueCount ?? 0} open issues`
                }
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{stats.issueCount ?? "?"}</span>
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
                size="sm"
                onClick={() => {
                  setIssuesOpen(false);
                  const willOpen = !prsOpen;
                  setPrsOpen(willOpen);
                  if (willOpen) {
                    refreshStats({ force: true });
                  }
                }}
                className={cn(
                  "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-7 px-2 gap-1.5",
                  (stats.prCount === 0 || statsError) && "opacity-50",
                  statsError && "text-[var(--color-status-error)]",
                  prsOpen && "bg-canopy-border text-canopy-accent"
                )}
                title={
                  statsError
                    ? `GitHub error: ${statsError} (click to retry)`
                    : "Browse GitHub Pull Requests"
                }
                aria-label={
                  statsError ? "GitHub stats error" : `${stats.prCount ?? 0} open pull requests`
                }
              >
                <GitPullRequest className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{stats.prCount ?? "?"}</span>
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

              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 h-7 rounded-[var(--radius-md)]",
                  (stats.commitCount === 0 || statsError) && "opacity-50",
                  statsError && "text-[var(--color-status-error)]"
                )}
                title={
                  statsError ? `GitHub error: ${statsError}` : "Total commits in current branch"
                }
                aria-label={statsError ? "GitHub stats error" : `${stats.commitCount} commits`}
              >
                <GitCommit className="h-3.5 w-3.5 text-canopy-text" />
                <span className="text-xs font-medium text-canopy-text">{stats.commitCount}</span>
              </div>
            </div>
            <div className="w-px h-5 bg-white/[0.08]" />
          </>
        )}

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleProblems}
            className={cn(
              "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-8 w-8 relative",
              errorCount > 0 && "text-[var(--color-status-error)]"
            )}
            title="Show Problems Panel (Ctrl+Shift+M)"
            aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}`}
          >
            <AlertCircle className="h-4 w-4" />
            {errorCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-[var(--color-status-error)] rounded-full" />
            )}
          </Button>
        </div>

        <div className="w-px h-5 bg-white/[0.08]" />

        <TooltipProvider>
          <Tooltip open={treeCopied} delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyTreeClick}
                disabled={isCopyingTree || !activeWorktree}
                className={cn(
                  "h-8 w-8 transition-colors",
                  treeCopied
                    ? "text-green-400 bg-green-400/10"
                    : "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent",
                  isCopyingTree && "cursor-wait opacity-70",
                  !activeWorktree && "opacity-50"
                )}
                title={activeWorktree ? "Copy Context" : "No active worktree"}
                aria-label={treeCopied ? "Context Copied" : "Copy Context"}
              >
                {isCopyingTree ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : treeCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
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

        <div className="w-px h-5 bg-white/[0.08]" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onSettings}
            onContextMenu={handleSettingsContextMenu}
            className="text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-8 w-8"
            title="Open Settings"
            aria-label="Open settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidecar}
            className={cn(
              "text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent h-8 w-8 transition-colors"
            )}
            title={sidecarOpen ? "Close Context Sidecar" : "Open Context Sidecar"}
            aria-label={sidecarOpen ? "Close context sidecar" : "Open context sidecar"}
            aria-pressed={sidecarOpen}
          >
            {sidecarOpen ? (
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );
}
