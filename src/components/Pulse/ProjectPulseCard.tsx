import { useEffect, useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PulseRangeDays, ProjectPulse, ProjectHealthData } from "@shared/types";
import { usePulseStore, useProjectStore, PULSE_MAX_RETRIES } from "@/store";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  RefreshCw,
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
  WifiOff,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Activity } from "@/components/icons";
import { PulseHeatmap } from "./PulseHeatmap";
import { PulseSummary } from "./PulseSummary";
import { useProjectHealth } from "@/hooks/useProjectHealth";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { systemClient } from "@/clients/systemClient";
import { formatTimeSince } from "@/components/Layout/FreshnessUtils";

// Collapses paired window.focus + visibilitychange events that fire together
// on restore-from-minimize. Short enough that legitimate user actions
// (refocus after a few seconds away) still trigger a probe.
const FOCUS_REFRESH_DEDUPE_MS = 500;

interface ProjectPulseCardProps {
  worktreeId: string;
  className?: string;
}

const RANGE_OPTIONS: { value: PulseRangeDays; label: string; srLabel: string }[] = [
  { value: 60, label: "60d", srLabel: "60 days" },
  { value: 120, label: "120d", srLabel: "120 days" },
  { value: 180, label: "180d", srLabel: "180 days" },
];

function getCoachLine(pulse: ProjectPulse): string {
  const sortedCells = [...pulse.heatmap]
    .filter((cell) => !isNaN(new Date(cell.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const today = sortedCells.find((c) => c.isToday) ?? sortedCells.at(-1);

  const last7Days = sortedCells.slice(-7).filter((c) => c.count > 0).length;

  if (today && today.count > 0) {
    return `${today.count} commit${today.count !== 1 ? "s" : ""} today — nice.`;
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
      return <CircleMinus className="w-3.5 h-3.5 text-daintree-text/40" />;
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
  tone?: "success" | "working" | "warning" | "danger" | "info" | "accent" | "neutral";
}

function getPulseChipToneStyle(tone: NonNullable<HealthChipProps["tone"]>): React.CSSProperties {
  if (tone === "neutral") {
    return {
      background: "color-mix(in oklab, var(--color-text-primary) 6%, transparent)",
      borderColor: "color-mix(in oklab, var(--color-text-primary) 8%, transparent)",
      color: "var(--color-text-secondary)",
    };
  }

  const palette: Record<Exclude<NonNullable<HealthChipProps["tone"]>, "neutral">, string> = {
    success: "var(--color-status-success)",
    working: "var(--color-state-working)",
    warning: "var(--color-status-warning)",
    danger: "var(--color-status-error)",
    info: "var(--color-status-info)",
    accent: "var(--color-accent-primary)",
  };

  const toneColor = palette[tone];
  return {
    background: `color-mix(in oklab, ${toneColor} 14%, transparent)`,
    borderColor: `color-mix(in oklab, ${toneColor} 20%, transparent)`,
    color: toneColor,
  };
}

function HealthChip({ icon, label, onClick, className, tone = "neutral" }: HealthChipProps) {
  const Wrapper = onClick ? "button" : "span";
  return (
    <Wrapper
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        onClick && "cursor-pointer transition-colors hover:opacity-85",
        className
      )}
      style={getPulseChipToneStyle(tone)}
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

  const mergedInRange = health.mergeVelocity.mergedCounts[rangeDays] ?? 0;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <HealthChip
        icon={<CIStatusIcon status={health.ciStatus} />}
        label={ciStatusLabel(health.ciStatus)}
        onClick={health.ciStatus !== "none" ? () => openUrl("/actions") : undefined}
        tone={
          health.ciStatus === "failure" || health.ciStatus === "error"
            ? "danger"
            : health.ciStatus === "pending" || health.ciStatus === "expected"
              ? "warning"
              : health.ciStatus === "success"
                ? "success"
                : "neutral"
        }
      />
      <HealthChip
        icon={<CircleDot className="w-3.5 h-3.5 text-current" />}
        label={String(health.issueCount)}
        onClick={() => openUrl("/issues")}
        tone="info"
      />
      <HealthChip
        icon={<GitPullRequest className="w-3.5 h-3.5 text-current" />}
        label={String(health.prCount)}
        onClick={() => openUrl("/pulls")}
        tone="working"
      />
      {health.latestRelease && (
        <HealthChip
          icon={<Tag className="w-3.5 h-3.5 text-current" />}
          label={`${health.latestRelease.tagName}${health.latestRelease.publishedAt ? ` (${relativeTime(health.latestRelease.publishedAt)})` : ""}`}
          onClick={() => openUrl(health.latestRelease!.url)}
          tone="accent"
        />
      )}
      {health.securityAlerts.visible && health.securityAlerts.count > 0 && (
        <HealthChip
          icon={<ShieldAlert className="w-3.5 h-3.5 text-current" />}
          label={`${health.securityAlerts.count} alert${health.securityAlerts.count !== 1 ? "s" : ""}`}
          onClick={() => openUrl("/security/dependabot")}
          tone="warning"
        />
      )}
      {mergedInRange > 0 && (
        <HealthChip
          icon={<GitMerge className="w-3.5 h-3.5 text-current" />}
          label={`${mergedInRange} merged (${rangeDays}d)`}
          onClick={() => openUrl("/pulls?q=is%3Apr+is%3Amerged+sort%3Aupdated-desc")}
          tone="success"
        />
      )}
    </div>
  );
}

const SKELETON_COLS = 60;
const SKELETON_CELL = 10;
const SKELETON_GAP = 3;
const SKELETON_ROW_WIDTH = SKELETON_CELL * SKELETON_COLS + SKELETON_GAP * (SKELETON_COLS - 1);

function PulseSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "pulse-card w-fit rounded-[var(--radius-lg)] border border-daintree-border min-h-[240px]",
        className
      )}
    >
      <div className="pulse-card-header px-4 py-3 border-b border-daintree-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-[2px] pulse-skeleton-shimmer shrink-0" />
          <div className="h-4 pulse-skeleton-shimmer rounded w-36" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-6 pulse-skeleton-shimmer rounded-md w-32" />
          <div className="w-6 h-6 rounded-md pulse-skeleton-shimmer" />
        </div>
      </div>

      <div className="p-4 space-y-4 animate-pulse-delayed">
        <div
          className="flex"
          style={{ gap: `${SKELETON_GAP}px`, width: `${SKELETON_ROW_WIDTH}px` }}
        >
          {Array.from({ length: SKELETON_COLS }).map((_, col) => (
            <div
              key={col}
              className="rounded-[2px] pulse-skeleton-shimmer shrink-0"
              style={{ width: `${SKELETON_CELL}px`, height: `${SKELETON_CELL}px` }}
            />
          ))}
        </div>

        <div className="h-3 pulse-skeleton-shimmer rounded w-72" />

        <div className="border-t border-daintree-border pt-3 min-h-9">
          <div className="flex items-center gap-2">
            <div className="h-5 w-16 rounded-full pulse-skeleton-shimmer" />
            <div className="h-5 w-12 rounded-full pulse-skeleton-shimmer" />
            <div className="h-5 w-12 rounded-full pulse-skeleton-shimmer" />
            <div className="h-5 w-24 rounded-full pulse-skeleton-shimmer" />
          </div>
        </div>

        <div className="border-t border-daintree-border pt-3">
          <div className="flex items-center gap-4">
            <div className="h-4 pulse-skeleton-shimmer rounded w-20" />
            <div className="h-4 pulse-skeleton-shimmer rounded w-24" />
            <div className="h-4 pulse-skeleton-shimmer rounded w-16" />
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthSectionSkeleton() {
  return (
    <div className="animate-pulse-delayed flex items-center gap-2">
      <div className="h-5 pulse-skeleton-shimmer rounded-full w-16" />
      <div className="h-5 pulse-skeleton-shimmer rounded-full w-12" />
      <div className="h-5 pulse-skeleton-shimmer rounded-full w-12" />
      <div className="h-5 pulse-skeleton-shimmer rounded-full w-24" />
    </div>
  );
}

function NoRemoteHint() {
  return (
    <div className="flex items-center gap-2 text-xs text-daintree-text/75">
      <Github className="w-3.5 h-3.5" />
      <span>Connect a GitHub remote for CI status, issues, and PRs</span>
    </div>
  );
}

function OfflineHint() {
  return (
    <div className="flex items-center gap-2 text-xs text-daintree-text/75">
      <WifiOff className="w-3.5 h-3.5" />
      <span>Offline — GitHub status unavailable</span>
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

  // Announce silent-refresh completion exactly once via a polite live region.
  // aria-busy alone does not satisfy WCAG 4.1.3 — assistive tech only re-reads
  // when a live region changes. The hasEverLoadedRef guard suppresses the
  // first successful load (no need to announce "updated" when the user hasn't
  // seen anything yet) and also any successful load that happens while error
  // is set (failed silent refresh while stale data is retained).
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const wasLoadingRef = useRef(false);
  const hasEverLoadedRef = useRef(false);
  const lastFocusProbeRef = useRef(0);
  const minuteTick = useGlobalMinuteTicker();
  useEffect(() => {
    const hadPulse = !!pulse;
    if (isLoading && hadPulse) {
      setRefreshAnnouncement("Refreshing pulse data");
    } else if (
      wasLoadingRef.current &&
      !isLoading &&
      hadPulse &&
      !error &&
      hasEverLoadedRef.current
    ) {
      setRefreshAnnouncement("Pulse data updated");
    }
    if (!isLoading && hadPulse && !error) {
      hasEverLoadedRef.current = true;
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, pulse, error]);

  useEffect(() => {
    if (!pulse && !isLoading && !error) {
      fetchPulse(worktreeId);
    }
  }, [worktreeId, pulse, isLoading, error, fetchPulse]);

  // Re-fetch when the window regains focus or the tab becomes visible. The
  // service runs a HEAD-SHA probe under the 60s TTL, so non-forced requests
  // stay cheap when nothing changed. Both events fire together on
  // restore-from-minimize — the cooldown ref collapses them into one call.
  useEffect(() => {
    const handleFocusOrVisible = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastFocusProbeRef.current < FOCUS_REFRESH_DEDUPE_MS) return;
      lastFocusProbeRef.current = now;
      void fetchPulse(worktreeId);
    };
    window.addEventListener("focus", handleFocusOrVisible);
    document.addEventListener("visibilitychange", handleFocusOrVisible);
    return () => {
      window.removeEventListener("focus", handleFocusOrVisible);
      document.removeEventListener("visibilitychange", handleFocusOrVisible);
    };
  }, [worktreeId, fetchPulse]);

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

  // ARIA radio-group keyboard contract: arrow keys cycle the selection and
  // move focus to the newly-selected option. Tab enters/exits the group at
  // the active button only.
  const rangeButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const handleRangeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.shiftKey) return;
      const isForward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const isBackward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!isForward && !isBackward) return;
      event.preventDefault();
      const currentIndex = RANGE_OPTIONS.findIndex((opt) => opt.value === rangeDays);
      const safeIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = isForward
        ? (safeIndex + 1) % RANGE_OPTIONS.length
        : (safeIndex - 1 + RANGE_OPTIONS.length) % RANGE_OPTIONS.length;
      const next = RANGE_OPTIONS[nextIndex]!;
      handleRangeChange(next.value);
      rangeButtonRefs.current[nextIndex]?.focus();
    },
    [rangeDays, handleRangeChange]
  );

  if (isLoading && !pulse) {
    return <PulseSkeleton className={className} />;
  }

  if (!pulse && error === null) {
    return (
      <div
        className={cn(
          "pulse-card p-4 rounded-[var(--radius-lg)] border border-daintree-border",
          // Hold the slot at PulseSkeleton's natural height so the empty-state
          // column doesn't reflow when the skeleton swaps to this one-liner
          // (#7671). The card centers its short message inside the reserved
          // box instead of shrinking and shifting siblings up.
          "min-h-[240px] flex items-center",
          className
        )}
      >
        <div className="flex items-center gap-2 text-daintree-text/75">
          <GitBranch className="w-4 h-4 text-status-info" aria-hidden="true" />
          <span className="text-xs">
            New repository — make your first commit to start tracking activity
          </span>
        </div>
      </div>
    );
  }

  if (error && !pulse) {
    const isRetrying = retryCount > 0 && retryCount < PULSE_MAX_RETRIES;

    return (
      <div
        className={cn(
          "pulse-card p-4 rounded-[var(--radius-lg)] border border-daintree-border",
          // Match PulseSkeleton height so the error swap doesn't collapse the
          // card and shift siblings up (#7671).
          "min-h-[240px] flex items-center",
          className
        )}
      >
        <div className="flex flex-col gap-2 w-full">
          <div className="flex items-center gap-2 text-daintree-text/75" role="alert">
            <AlertCircle className="w-4 h-4 text-status-error" aria-hidden="true" />
            <span className="text-xs">{error}</span>
            <button
              onClick={handleRefresh}
              className="pulse-control ml-auto rounded-md p-1 text-daintree-text/55 transition-colors hover:text-daintree-text/80"
              aria-label="Retry now"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
          {isRetrying && (
            <div
              className="flex items-center gap-2 text-daintree-text/55"
              role="status"
              aria-live="polite"
            >
              <Spinner size="xs" />
              <span className="text-xs">
                Retrying ({retryCount}/{PULSE_MAX_RETRIES})...
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

  // minuteTick is read so the freshness label re-renders on each 30s tick.
  // useGlobalMinuteTicker pauses while hidden and emits on visibility restore.
  void minuteTick;
  const updatedLabel = formatTimeSince(pulse.generatedAt, Date.now());

  return (
    <div
      className={cn(
        "pulse-card w-fit rounded-[var(--radius-lg)] border border-daintree-border min-h-[240px]",
        className
      )}
      aria-busy={isLoading}
    >
      <span role="status" aria-live="polite" className="sr-only">
        {refreshAnnouncement}
      </span>
      <div className="pulse-card-header px-4 py-3 border-b border-daintree-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-status-success" />
          <span className="text-sm font-medium text-daintree-text/90">{title}</span>
          {isLoading && <Spinner size="xs" className="text-daintree-text/55" />}
        </div>

        <div className="flex items-center gap-2">
          <div
            className="pulse-range flex items-center rounded-md border border-transparent text-[11px] font-medium"
            role="radiogroup"
            aria-label="Activity range"
            onKeyDown={handleRangeKeyDown}
          >
            {RANGE_OPTIONS.map((option, index) => {
              const isActive = option.value === rangeDays;
              return (
                <button
                  key={option.value}
                  ref={(el) => {
                    rangeButtonRefs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  onClick={() => handleRangeChange(option.value)}
                  className={cn(
                    "rounded-md border px-2 py-1 transition-colors",
                    isActive
                      ? "bg-overlay-selected border-border-strong text-daintree-text"
                      : "pulse-control border-transparent text-daintree-text/55 hover:text-daintree-text/80"
                  )}
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                >
                  <span aria-hidden="true">{option.label}</span>
                  <span className="sr-only">{option.srLabel}</span>
                </button>
              );
            })}
          </div>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="pulse-control rounded-md p-1.5 text-daintree-text/55 transition-colors hover:text-daintree-text/80 disabled:opacity-50 disabled:pointer-events-none"
            aria-label="Refresh"
          >
            <RefreshCw
              className={cn("w-3 h-3", isLoading && "animate-spin motion-reduce:animate-none")}
            />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <PulseHeatmap cells={pulse.heatmap} rangeDays={pulse.rangeDays} />

        <p className="text-xs text-daintree-text/80">{getCoachLine(pulse)}</p>

        {/* Health section: always renders the wrapper so the 4 sub-variants
            (signals, skeleton, no-remote hint, offline hint) can swap without
            growing or collapsing the card. `min-h-9` matches the chip row
            height (h-5 chip + pt-3 padding) so the loaded HealthSignals row
            doesn't push siblings down when it resolves after pulse (#7671). */}
        <div className="border-t border-daintree-border pt-3 min-h-9">
          {health && !health.error && health.repoUrl ? (
            <HealthSignals health={health} rangeDays={rangeDays} />
          ) : healthLoading ? (
            <HealthSectionSkeleton />
          ) : health && !health.hasRemote ? (
            <NoRemoteHint />
          ) : health && health.hasRemote ? (
            <OfflineHint />
          ) : null}
        </div>

        <div className="border-t border-daintree-border pt-3">
          <PulseSummary pulse={pulse} />
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className="pulse-control mt-2 inline-flex items-center text-[11px] text-daintree-text/55 transition-colors hover:text-daintree-text/80 disabled:opacity-50 disabled:pointer-events-none"
            aria-label={`Refresh — last updated ${updatedLabel}`}
            data-testid="pulse-last-updated"
          >
            <span>Updated {updatedLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
