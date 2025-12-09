import { useRef, useState, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { BulkActionsMenu } from "@/components/Terminal";
import { GitHubResourceList } from "@/components/GitHub";
import { AgentButton } from "./AgentButton";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useSidecarStore } from "@/store";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import type { CliAvailability, AgentSettings } from "@shared/types";

interface ToolbarProps {
  onLaunchAgent: (type: "claude" | "gemini" | "codex" | "shell") => void;
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
  const currentProject = useProjectStore((state) => state.currentProject);
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const { stats, error: statsError, refresh: refreshStats } = useRepositoryStats();

  const sidecarOpen = useSidecarStore((state) => state.isOpen);
  const toggleSidecar = useSidecarStore((state) => state.toggle);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const issuesButtonRef = useRef<HTMLButtonElement>(null);
  const prsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return window.electron.window.onFullscreenChange(setIsFullscreen);
  }, []);

  const showBulkActions = terminals.length > 0;
  const openAgentSettings = onOpenAgentSettings ?? onSettings;

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
            "text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-8 w-8 transition-colors mr-2",
            !isFocusMode && "bg-canopy-accent/20 text-canopy-accent"
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
          isEnabled={agentSettings?.claude?.enabled ?? true}
          onLaunch={() => onLaunchAgent("claude")}
          onOpenSettings={openAgentSettings}
        />
        <AgentButton
          type="gemini"
          availability={agentAvailability?.gemini}
          isEnabled={agentSettings?.gemini?.enabled ?? true}
          onLaunch={() => onLaunchAgent("gemini")}
          onOpenSettings={openAgentSettings}
        />
        <AgentButton
          type="codex"
          availability={agentAvailability?.codex}
          isEnabled={agentSettings?.codex?.enabled ?? true}
          onLaunch={() => onLaunchAgent("codex")}
          onOpenSettings={openAgentSettings}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onLaunchAgent("shell")}
          className="text-canopy-text hover:bg-canopy-border h-8 w-8 transition-colors hover:text-canopy-accent focus-visible:text-canopy-accent"
          title="Open Terminal (⌘T for palette)"
          aria-label="Open Terminal"
        >
          <Terminal className="h-4 w-4" />
        </Button>
        {showBulkActions && <BulkActionsMenu />}
      </div>

      <div className="flex-1 flex justify-center items-center h-full opacity-70 hover:opacity-100 transition-opacity">
        {currentProject ? (
          <div
            className="flex items-center gap-2 px-3 py-1 rounded-md select-none"
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
                  "text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-7 px-2 gap-1.5",
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
                  "text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-7 px-2 gap-1.5",
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
                />
              </FixedDropdown>

              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 h-7 rounded-md",
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
            <div className="w-px h-6 bg-canopy-border" />
          </>
        )}

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleProblems}
            className={cn(
              "text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-8 w-8 relative",
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

        <div className="w-px h-6 bg-canopy-border" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onSettings}
            className="text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-8 w-8"
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
              "text-canopy-text hover:bg-canopy-border hover:text-canopy-accent h-8 w-8 transition-colors",
              sidecarOpen && "bg-canopy-accent/20 text-canopy-accent"
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
