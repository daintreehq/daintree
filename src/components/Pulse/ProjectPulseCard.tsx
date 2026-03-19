import { useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PulseRangeDays, ProjectPulse, ProjectHealthData } from "@shared/types";
import { usePulseStore, useProjectStore } from "@/store";
import { cn } from "@/lib/utils";
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  Activity,
  GitBranch,
  CheckCircle2,
  XCircle,
  Clock,
  CircleMinus,
  Tag,
  ShieldAlert,
  GitPullRequest,
  CircleDot,
  GitMerge,
  Github,
} from "lucide-react";
import { PulseHeatmap } from "./PulseHeatmap";
import { PulseSummary } from "./PulseSummary";
import { useProjectHealth } from "@/hooks/useProjectHealth";
import { systemClient } from "@/clients/systemClient";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface ProjectPulseCardProps {
  worktreeId: string;
  className?: string;
}

const RANGE_OPTIONS: { value: PulseRangeDays; label: string }[] = [
  { value: 60, label: "60 days" },
  { value: 120, label: "120 days" },
  { value: 180, label: "180 days" },
];

function getCoachLine(pulse: ProjectPulse): string {
  const sortedCells = [...pulse.heatmap]
    .filter((cell) => !isNaN(new Date(cell.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const today = sortedCells.find((c) => c.isToday) ?? sortedCells.at(-1);

  const last7Days = sortedCells.slice(-7).filter((c) => c.count > 0).length;

  if (today && today.count > 0) {
    return "Nice — progress logged today.";
  }
  if (pulse.currentStreakDays && pulse.currentStreakDays > 0) {
    return "One small commit today keeps your streak going.";
  }
  if (last7Days > 0) {
    return `Momentum's building: ${last7Days} active day${last7Days !== 1 ? "s" : ""} this week.`;
  }
  return "Make a tiny win: ship one small change today.";
}

function CIStatusIcon({ status }: { status: ProjectHealthData["ciStatus"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="w-3.5 h-3.5 text-status-success" />;
    case "failure":
    case "error":
      return <XCircle className="w-3.5 h-3.5 text-status-error" />;
    case "pending":
    case "expected":
      return <Clock className="w-3.5 h-3.5 text-status-warning" />;
    default:
      return <CircleMinus className="w-3.5 h-3.5 text-canopy-text/40" />;
  }
}

function ciStatusLabel(status: ProjectHealthData["ciStatus"]): string {
  switch (status) {
    case "success":
      return "passing";
    case "failure":
      return "failing";
    case "error":
      return "error";
    case "pending":
    case "expected":
      return "pending";
    default:
      return "no CI";
  }
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1mo ago";
  return `${months}mo ago`;
}

interface HealthChipProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
}

function HealthChip({ icon, label, onClick, className }: HealthChipProps) {
  const Wrapper = onClick ? "button" : "span";
  return (
    <Wrapper
      className={cn(
        "flex items-center gap-1 text-xs text-canopy-text/75 px-1.5 py-0.5 rounded",
        onClick && "hover:bg-tint/5 hover:text-canopy-text/90 transition-colors cursor-pointer",
        className
      )}
      onClick={onClick}
    >
      {icon}
      <span className="font-mono tabular-nums">{label}</span>
    </Wrapper>
  );
}

function HealthSignals({
  health,
  rangeDays,
}: {
  health: ProjectHealthData;
  rangeDays: PulseRangeDays;
}) {
  const openUrl = (path: string) => {
    const url = path.startsWith("http") ? path : `${health.repoUrl}${path}`;
    systemClient.openExternal(url);
  };

  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  const mergedInRange = health.mergeVelocity.recentMergedDates.filter(
    (d) => new Date(d).getTime() >= cutoff
  ).length;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <HealthChip
        icon={<CIStatusIcon status={health.ciStatus} />}
        label={ciStatusLabel(health.ciStatus)}
        onClick={health.ciStatus !== "none" ? () => openUrl("/actions") : undefined}
      />
      <HealthChip
        icon={<CircleDot className="w-3.5 h-3.5 text-status-info" />}
        label={String(health.issueCount)}
        onClick={() => openUrl("/issues")}
      />
      <HealthChip
        icon={<GitPullRequest className="w-3.5 h-3.5 text-status-info" />}
        label={String(health.prCount)}
        onClick={() => openUrl("/pulls")}
      />
      {health.latestRelease && (
        <HealthChip
          icon={<Tag className="w-3.5 h-3.5 text-canopy-accent" />}
          label={`${health.latestRelease.tagName}${health.latestRelease.publishedAt ? ` (${relativeTime(health.latestRelease.publishedAt)})` : ""}`}
          onClick={() => openUrl(health.latestRelease!.url)}
        />
      )}
      {health.securityAlerts.visible && health.securityAlerts.count > 0 && (
        <HealthChip
          icon={<ShieldAlert className="w-3.5 h-3.5 text-status-warning" />}
          label={`${health.securityAlerts.count} alert${health.securityAlerts.count !== 1 ? "s" : ""}`}
          onClick={() => openUrl("/security/dependabot")}
        />
      )}
      {mergedInRange > 0 && (
        <HealthChip
          icon={<GitMerge className="w-3.5 h-3.5 text-purple-400" />}
          label={`${mergedInRange} merged (${rangeDays}d)`}
          onClick={() => openUrl("/pulls?q=is%3Apr+is%3Amerged+sort%3Aupdated-desc")}
        />
      )}
    </div>
  );
}

const MAX_RETRIES = 3;

const SKELETON_COLS = 60;
const SKELETON_CELL = 10;
const SKELETON_GAP = 3;
const SKELETON_ROW_WIDTH = SKELETON_CELL * SKELETON_COLS + SKELETON_GAP * (SKELETON_COLS - 1);

function PulseSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "w-fit bg-canopy-sidebar rounded-[var(--radius-lg)] border border-canopy-border",
        className
      )}
    >
      <div className="px-4 py-3 border-b border-canopy-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-muted shrink-0" />
          <div className="h-4 bg-muted rounded w-36" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-5 bg-muted rounded w-14" />
          <div className="w-5 h-5 rounded bg-muted" />
        </div>
      </div>

      <div className="p-4 space-y-4 animate-pulse-delayed">
        <div
          className="flex"
          style={{ gap: `${SKELETON_GAP}px`, width: `${SKELETON_ROW_WIDTH}px` }}
        >
          {Array.from({ length: SKELETON_COLS }).map((_, i) => (
            <div
              key={i}
              className="rounded-full bg-muted shrink-0"
              style={{ width: `${SKELETON_CELL}px`, height: `${SKELETON_CELL}px` }}
            />
          ))}
        </div>

        <div className="h-3 bg-muted rounded w-52" />

        <div className="border-t border-canopy-border pt-3">
          <div className="flex items-center gap-2">
            <div className="h-5 bg-muted rounded w-16" />
            <div className="h-5 bg-muted rounded w-10" />
            <div className="h-5 bg-muted rounded w-10" />
            <div className="h-5 bg-muted rounded w-24" />
          </div>
        </div>

        <div className="border-t border-canopy-border pt-3">
          <div className="flex items-center gap-4">
            <div className="h-4 bg-muted rounded w-20" />
            <div className="h-4 bg-muted rounded w-24" />
            <div className="h-4 bg-muted rounded w-16" />
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthSectionSkeleton() {
  return (
    <div className="border-t border-canopy-border pt-3 animate-pulse-delayed">
      <div className="flex items-center gap-2">
        <div className="h-5 bg-muted rounded w-16" />
        <div className="h-5 bg-muted rounded w-10" />
        <div className="h-5 bg-muted rounded w-10" />
        <div className="h-5 bg-muted rounded w-24" />
      </div>
    </div>
  );
}

function NoRemoteHint() {
  return (
    <div className="border-t border-canopy-border pt-3">
      <div className="flex items-center gap-2 text-xs text-canopy-text/75">
        <Github className="w-3.5 h-3.5" />
        <span>Connect a GitHub remote for CI status, issues, and PRs</span>
      </div>
    </div>
  );
}

export function ProjectPulseCard({ worktreeId, className }: ProjectPulseCardProps) {
  const projectName = useProjectStore((s) => s.currentProject?.name);
  const { health, loading: healthLoading, refresh: refreshHealth } = useProjectHealth();
  const { pulse, isLoading, error, rangeDays, retryCount, fetchPulse, setRangeDays } =
    usePulseStore(
      useShallow((state) => ({
        pulse: state.getPulse(worktreeId),
        isLoading: state.isLoading(worktreeId),
        error: state.getError(worktreeId),
        rangeDays: state.rangeDays,
        retryCount: state.getRetryCount(worktreeId),
        fetchPulse: state.fetchPulse,
        setRangeDays: state.setRangeDays,
      }))
    );

  const title = projectName ? `${projectName} Project Pulse` : "Project Pulse";

  useEffect(() => {
    if (!pulse && !isLoading && !error) {
      fetchPulse(worktreeId);
    }
  }, [worktreeId, pulse, isLoading, error, fetchPulse]);

  const handleRefresh = useCallback(() => {
    fetchPulse(worktreeId, true);
    void refreshHealth({ force: true });
  }, [worktreeId, fetchPulse, refreshHealth]);

  const handleRangeChange = useCallback(
    (days: PulseRangeDays) => {
      setRangeDays(days);
      fetchPulse(worktreeId);
    },
    [setRangeDays, fetchPulse, worktreeId]
  );

  const currentRangeLabel =
    RANGE_OPTIONS.find((o) => o.value === rangeDays)?.label ?? `${rangeDays} days`;

  if (isLoading && !pulse) {
    return <PulseSkeleton className={className} />;
  }

  if (!pulse && error === null) {
    return (
      <div
        className={cn(
          "p-4 bg-canopy-sidebar rounded-[var(--radius-lg)] border border-canopy-border",
          className
        )}
      >
        <div className="flex items-center gap-2 text-canopy-text/75">
          <GitBranch className="w-4 h-4 text-status-info" aria-hidden="true" />
          <span className="text-xs">
            New repository — make your first commit to start tracking activity
          </span>
        </div>
      </div>
    );
  }

  if (error && !pulse) {
    const isRetrying = retryCount > 0 && retryCount < MAX_RETRIES;

    return (
      <div
        className={cn(
          "p-4 bg-canopy-sidebar rounded-[var(--radius-lg)] border border-canopy-border",
          className
        )}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-canopy-text/75" role="alert">
            <AlertCircle className="w-4 h-4 text-status-error" aria-hidden="true" />
            <span className="text-xs">{error}</span>
            <button
              onClick={handleRefresh}
              className="ml-auto p-1 hover:bg-tint/5 rounded transition-colors"
              aria-label="Retry now"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
          {isRetrying && (
            <div
              className="flex items-center gap-2 text-canopy-text/55"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
              <span className="text-xs">
                Retrying ({retryCount}/{MAX_RETRIES})...
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!pulse) {
    return null;
  }

  return (
    <div
      className={cn(
        "w-fit bg-canopy-sidebar rounded-[var(--radius-lg)] border border-canopy-border",
        className
      )}
    >
      <div className="px-4 py-3 border-b border-canopy-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-status-success" />
          <span className="text-sm font-medium text-canopy-text/90">{title}</span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-canopy-text/55" />}
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="text-xs text-canopy-text/70 hover:text-canopy-text/90 transition-colors px-2 py-1 rounded hover:bg-tint/5"
                aria-label="Change time range"
              >
                {currentRangeLabel}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {RANGE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => handleRangeChange(option.value)}
                  className={cn(
                    option.value === rangeDays && "bg-canopy-accent/15 text-canopy-accent"
                  )}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-1 text-canopy-text/55 hover:text-canopy-text/90 hover:bg-tint/5 rounded transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <PulseHeatmap cells={pulse.heatmap} rangeDays={pulse.rangeDays} />

        <p className="text-xs text-canopy-text/80 italic">{getCoachLine(pulse)}</p>

        {health && !health.error && health.repoUrl ? (
          <div className="border-t border-canopy-border pt-3">
            <HealthSignals health={health} rangeDays={rangeDays} />
          </div>
        ) : healthLoading ? (
          <HealthSectionSkeleton />
        ) : health && !health.repoUrl ? (
          <NoRemoteHint />
        ) : null}

        <div className="border-t border-canopy-border pt-3">
          <PulseSummary pulse={pulse} />
        </div>
      </div>
    </div>
  );
}
