import {
  Suspense,
  lazy,
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  memo,
  forwardRef,
} from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { CircleDot, GitPullRequest, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
} from "@/components/GitHub/GitHubDropdownSkeletons";
import { GitHubStatusIndicator, type GitHubStatusIndicatorStatus } from "./GitHubStatusIndicator";
import type { Project } from "@shared/types";
import type { RepositoryStats } from "@shared/types";

function formatRateLimitCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

const LazyGitHubResourceList = lazy(() =>
  import("@/components/GitHub/GitHubResourceList").then((m) => ({
    default: m.GitHubResourceList,
  }))
);
const LazyCommitList = lazy(() =>
  import("@/components/GitHub/CommitList").then((m) => ({ default: m.CommitList }))
);

export interface GitHubStatsHandle {
  closeAll: () => void;
  openIssues: () => void;
  openPrs: () => void;
  openCommits: () => void;
  stats: RepositoryStats | null;
}

interface GitHubStatsToolbarButtonProps {
  currentProject: Project | null;
  "data-toolbar-item"?: string;
}

export const GitHubStatsToolbarButton = memo(
  forwardRef<GitHubStatsHandle, GitHubStatsToolbarButtonProps>(function GitHubStatsToolbarButton(
    { currentProject },
    ref
  ) {
    const {
      stats,
      loading: statsLoading,
      error: statsError,
      isTokenError,
      refresh: refreshStats,
      isStale,
      lastUpdated,
      rateLimitResetAt,
      rateLimitKind,
    } = useRepositoryStats();

    const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
    const activeWorktree = useWorktreeStore((state) =>
      activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
    );

    const setIssueSearchQuery = useGitHubFilterStore((s) => s.setIssueSearchQuery);
    const setPrSearchQuery = useGitHubFilterStore((s) => s.setPrSearchQuery);

    const [issuesOpen, setIssuesOpen] = useState(false);
    const [prsOpen, setPrsOpen] = useState(false);
    const [commitsOpen, setCommitsOpen] = useState(false);
    const [statsJustUpdated, setStatsJustUpdated] = useState(false);
    const [rateLimitCountdown, setRateLimitCountdown] = useState<string | null>(null);
    const prevLastUpdatedRef = useRef<number | null>(null);

    useEffect(() => {
      if (rateLimitResetAt === null || rateLimitResetAt <= Date.now()) {
        setRateLimitCountdown(null);
        return;
      }
      let intervalId: number | null = null;
      const tick = () => {
        const remainingMs = rateLimitResetAt - Date.now();
        if (remainingMs <= 0) {
          setRateLimitCountdown(null);
          // Stop ticking once we've hit zero — otherwise the 1Hz interval
          // keeps running uselessly until the component unmounts.
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }
        setRateLimitCountdown(formatRateLimitCountdown(remainingMs));
      };
      tick();
      intervalId = window.setInterval(tick, 1000);
      return () => {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
        }
      };
    }, [rateLimitResetAt]);

    const rateLimitActive = rateLimitCountdown !== null;
    const rateLimitLabel = rateLimitActive
      ? rateLimitKind === "secondary"
        ? `Paused · resumes in ${rateLimitCountdown}`
        : `Resets in ${rateLimitCountdown}`
      : null;

    const issuesButtonRef = useRef<HTMLButtonElement>(null);
    const prsButtonRef = useRef<HTMLButtonElement>(null);
    const commitsButtonRef = useRef<HTMLButtonElement>(null);

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
      if (statsError && !isTokenError) return "error";
      if (statsJustUpdated) return "success";
      return "idle";
    }, [statsLoading, statsError, isTokenError, statsJustUpdated]);

    const handleGitHubStatusTransitionEnd = useCallback(() => {
      setStatsJustUpdated(false);
    }, []);

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

    const openSettingsForToken = useCallback(() => {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "github", sectionId: "github-token" },
        { source: "user" }
      );
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        closeAll: () => {
          setIssuesOpen(false);
          setPrsOpen(false);
          setCommitsOpen(false);
        },
        openIssues: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          setIssuesOpen((p) => !p);
        },
        openPrs: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          setPrsOpen((p) => !p);
        },
        openCommits: () => setCommitsOpen((p) => !p),
        stats,
      }),
      [stats, isTokenError, openSettingsForToken]
    );

    if (!currentProject) return null;

    return (
      <div
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
                  if (isTokenError) {
                    setIssuesOpen(false);
                    setIssueSearchQuery("");
                    void actionService.dispatch(
                      "app.settings.openTab",
                      { tab: "github", sectionId: "github-token" },
                      { source: "user" }
                    );
                    return;
                  }
                  const willOpen = !issuesOpen;
                  setIssuesOpen(willOpen);
                  if (!willOpen) setIssueSearchQuery("");
                  if (willOpen) refreshStats({ force: true });
                }}
                className={cn(
                  "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                  isTokenError && "opacity-40",
                  !isTokenError && stats?.issueCount === 0 && "opacity-50",
                  !isTokenError && isStale && "opacity-60",
                  issuesOpen &&
                    "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-open/20"
                )}
                aria-label={
                  isTokenError
                    ? "Configure GitHub token to see issues"
                    : `${stats?.issueCount ?? "\u2014"} open issues${isStale ? " (cached)" : ""}`
                }
              >
                <CircleDot
                  className={cn(
                    "h-4 w-4",
                    isTokenError ? "text-muted-foreground" : "text-github-open"
                  )}
                />
                <span className="text-xs font-medium tabular-nums">
                  {stats?.issueCount ?? "\u2014"}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isTokenError
                ? "Configure GitHub token to see issues"
                : isStale
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
                  if (isTokenError) {
                    setPrsOpen(false);
                    setPrSearchQuery("");
                    void actionService.dispatch(
                      "app.settings.openTab",
                      { tab: "github", sectionId: "github-token" },
                      { source: "user" }
                    );
                    return;
                  }
                  const willOpen = !prsOpen;
                  setPrsOpen(willOpen);
                  if (!willOpen) setPrSearchQuery("");
                  if (willOpen) refreshStats({ force: true });
                }}
                className={cn(
                  "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                  isTokenError && "opacity-40",
                  !isTokenError && stats?.prCount === 0 && "opacity-50",
                  !isTokenError && isStale && "opacity-60",
                  prsOpen &&
                    "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-merged/20"
                )}
                aria-label={
                  isTokenError
                    ? "Configure GitHub token to see pull requests"
                    : `${stats?.prCount ?? "\u2014"} open pull requests${isStale ? " (cached)" : ""}`
                }
              >
                <GitPullRequest
                  className={cn(
                    "h-4 w-4",
                    isTokenError ? "text-muted-foreground" : "text-github-merged"
                  )}
                />
                <span className="text-xs font-medium tabular-nums">
                  {stats?.prCount ?? "\u2014"}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isTokenError
                ? "Configure GitHub token to see pull requests"
                : isStale
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
            fallback={<GitHubResourceListSkeleton count={stats?.prCount} immediate type="pr" />}
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
                  "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
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
              branch={activeWorktree?.branch}
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
        {rateLimitActive && rateLimitLabel ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  role="status"
                  aria-live="polite"
                  aria-label={
                    rateLimitKind === "secondary"
                      ? `GitHub secondary rate limit — resuming in ${rateLimitCountdown}`
                      : `GitHub rate limit — resets in ${rateLimitCountdown}`
                  }
                  className="flex h-full items-center px-2 text-[10px] font-medium text-muted-foreground opacity-60"
                >
                  {rateLimitLabel}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {rateLimitKind === "secondary"
                  ? "GitHub triggered a secondary (abuse) rate limit — polling paused until it clears."
                  : "GitHub API quota exhausted — polling paused until the quota resets."}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
    );
  })
);
