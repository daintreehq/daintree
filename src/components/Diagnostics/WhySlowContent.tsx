import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Gauge, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { systemClient } from "@/clients/systemClient";
import { logError } from "@/utils/logger";
import type { WhySlowSnapshot } from "@shared/types/whySlow";
import { MetricTile, type MetricTone } from "./MetricTile";
import { DiagnosticsNotice } from "./DiagnosticsNotice";

export interface WhySlowContentProps {
  className?: string;
}

// Keep the dock live without a live-pull into the renderer: the snapshot IPC
// reads a passively-maintained main-process cache. Aligned with the main-process
// app-metrics cache TTL (~5s) so polling doesn't force redundant metric scans —
// avoiding adding the very overhead this panel exists to diagnose.
const REFRESH_INTERVAL_MS = 5_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 10_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// Shared by the PTY-lag tile tone, the findings and isAllClear so the calm
// summary can never disagree with a warn-toned tile over the same number.
const PTY_LAG_WARN_THRESHOLD_MS = 50;

/**
 * One observed reason the app may feel slow, phrased for someone who doesn't
 * know the internals. `info` is ordinary activity worth knowing about (a git
 * fetch, a backgrounded window) — it still rules out "all clear", but it isn't
 * counted as something slowing Daintree down.
 */
export interface SlowdownFinding {
  id: string;
  tone: Exclude<MetricTone, "default"> | "info";
  text: string;
  /** What the reader can do about it, when there is something. */
  suggestion?: string;
}

// How much each profile throttles, so a pending switch reads as easing or worsening.
const PROFILE_RANK: Record<string, number> = { performance: 0, balanced: 1, efficiency: 2 };
const PROFILE_MODE: Record<string, string> = {
  performance: "full-speed",
  balanced: "balanced",
  efficiency: "power-saving",
};

/**
 * Turn the snapshot into the observations that explain a slowdown, worst
 * first. Every condition here is one a tile below also flags, so the summary
 * and the readings can never disagree; it states what was measured and never
 * guesses at a cause the snapshot doesn't carry.
 */
export function describeSlowdowns(snapshot: WhySlowSnapshot): SlowdownFinding[] {
  const findings: SlowdownFinding[] = [];
  const r = snapshot.resource;
  if (r) {
    if (r.lagPressureActive) {
      findings.push({
        id: "lag",
        tone: "alert",
        text: r.lagEscalatedActive
          ? "Daintree's main process stalled badly and is holding back background work"
          : "Daintree's main process is responding slowly and is holding back background work",
        suggestion: "Closing idle terminals and agents may help",
      });
    }
    const current = PROFILE_RANK[r.currentProfile] ?? 0;
    const target = PROFILE_RANK[r.targetProfile] ?? 0;
    if (current > 0) {
      const easing = target < current;
      findings.push({
        id: "profile",
        // Already on its way back is less urgent than staying throttled.
        tone: r.currentProfile === "efficiency" && !easing ? "alert" : "warn",
        text: `Daintree switched to ${PROFILE_MODE[r.currentProfile]} mode, so terminals and status checks update less often`,
        suggestion:
          target === current
            ? undefined
            : easing
              ? `Pressure has eased; it's heading back to ${PROFILE_MODE[r.targetProfile]} mode`
              : `Pressure is still rising; it's heading to ${PROFILE_MODE[r.targetProfile]} mode`,
      });
    } else if (target > 0) {
      findings.push({
        id: "profile",
        tone: "warn",
        text: `Daintree is about to switch to ${PROFILE_MODE[r.targetProfile]} mode`,
      });
    }
    if (r.isOnBattery) {
      findings.push({
        id: "battery",
        tone: "warn",
        text: "Running on battery",
        suggestion: "Plug in to lift the battery limits",
      });
    }
    if (r.thermalState !== "unknown" && r.thermalState !== "nominal") {
      findings.push({
        id: "thermal",
        tone: r.thermalState === "critical" ? "alert" : "warn",
        text: `The system is running hot (thermal state: ${r.thermalState})`,
        suggestion: "Pausing heavy agent work may help it cool down",
      });
    }
    if (r.speedLimit < 100) {
      findings.push({
        id: "cpu",
        tone: "warn",
        text: `The OS is limiting CPU speed to ${r.speedLimit}%`,
      });
    }
  }
  if (snapshot.focusThrottle.throttled) {
    findings.push({
      id: "focus",
      tone: "info",
      text: `No Daintree window is in front, so background checks run ${snapshot.focusThrottle.pollMultiplier}× less often`,
      suggestion: "This is expected and lifts as soon as you switch back",
    });
  }
  const domViews = snapshot.rendererTerminals.filter((s) => s.webglMode === "dom");
  if (domViews.length > 0) {
    const terminals = domViews.reduce((sum, s) => sum + s.terminalCount, 0);
    findings.push({
      id: "webgl",
      tone: "warn",
      text: `${plural(terminals, "terminal is", "terminals are")} drawn without GPU acceleration`,
      suggestion: "Closing some terminals may bring it back",
    });
  }
  const p = snapshot.pty;
  if (p) {
    if (p.pausedCount > 0 || p.totalPendingBytes > 0) {
      findings.push({
        id: "pty-backlog",
        tone: "warn",
        text:
          p.pausedCount > 0
            ? `${plural(p.pausedCount, "terminal is", "terminals are")} paused because output arrives faster than it can be drawn (${formatBytes(p.totalPendingBytes)} waiting)`
            : `${formatBytes(p.totalPendingBytes)} of terminal output is waiting to be drawn`,
      });
    }
    if (p.eventLoopP99Ms !== null && p.eventLoopP99Ms > PTY_LAG_WARN_THRESHOLD_MS) {
      findings.push({
        id: "pty-lag",
        tone: "warn",
        text: `The terminal host is busy: ${p.eventLoopP99Ms}ms delays, where under ${PTY_LAG_WARN_THRESHOLD_MS}ms is normal`,
      });
    }
  }
  if (snapshot.worktrees && snapshot.worktrees.fetchInFlightCount > 0) {
    findings.push({
      id: "fetch",
      tone: "info",
      text: `${plural(snapshot.worktrees.fetchInFlightCount, "git fetch is", "git fetches are")} running`,
    });
  }
  const w = snapshot.workers;
  if (w && w.totalQueueDepth > 0) {
    findings.push({
      id: "queue",
      tone: "warn",
      text: `${plural(w.totalQueueDepth, "background job is", "background jobs are")} waiting in the queue`,
    });
  }
  if (w && w.degraded.length > 0) {
    findings.push({
      id: "degraded",
      tone: "warn",
      text: `${plural(w.degraded.length, "background worker is", "background workers are")} running on a slower fallback`,
    });
  }
  const order: Record<SlowdownFinding["tone"], number> = { alert: 0, warn: 1, info: 2 };
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => order[a.finding.tone] - order[b.finding.tone] || a.index - b.index)
    .map(({ finding }) => finding);
}

/**
 * True when nothing in the snapshot would render a warn/alert tone — the same
 * conditions the findings and tiles use, so the calm summary line can never
 * contradict a highlighted metric next to it. The resource and pty sections
 * must be present: a section degraded to null means "unknown", and claiming
 * all-clear over missing data would be false calm. `worktrees` and `workers`
 * may be null legitimately, so they only veto when present, as do renderer
 * samples (an empty push cache just means no view has reported yet).
 */
export function isAllClear(snapshot: WhySlowSnapshot): boolean {
  const r = snapshot.resource;
  if (!r || !snapshot.pty) return false;
  if (r.reasons.length > 0) return false;
  return describeSlowdowns(snapshot).length === 0;
}

/**
 * Bottleneck-first ordering: the largest pressure contribution is the likeliest
 * answer to "why am I slow?", so it leads the list. Stable sort keeps the
 * collector's declaration order for ties.
 */
export function sortReasonsByContribution<T extends { contribution: number }>(
  reasons: readonly T[]
): T[] {
  return [...reasons].sort((a, b) => b.contribution - a.contribution);
}

const PROFILE_LABEL: Record<string, string> = {
  performance: "Full speed",
  balanced: "Balanced",
  efficiency: "Power-saving",
};

function profileTone(profile: string): MetricTone {
  if (profile === "efficiency") return "alert";
  if (profile === "balanced") return "warn";
  return "default";
}

// Collapse the per-view renderer samples into one at-a-glance line: summed tier
// counts and a WebGL mode of "webgl"/"dom"/"mixed" across all reporting views.
function aggregateRenderer(snapshot: WhySlowSnapshot): {
  mode: string;
  terminalCount: number;
  wantsWebgl: number;
  countsByTier: Record<string, number>;
  viewCount: number;
} | null {
  const samples = snapshot.rendererTerminals;
  if (samples.length === 0) return null;
  const countsByTier: Record<string, number> = {};
  let terminalCount = 0;
  let wantsWebgl = 0;
  let anyWebgl = false;
  let anyDom = false;
  for (const s of samples) {
    terminalCount += s.terminalCount;
    wantsWebgl += s.wantsWebgl;
    if (s.webglMode === "webgl") anyWebgl = true;
    else anyDom = true;
    for (const [tier, count] of Object.entries(s.countsByTier)) {
      countsByTier[tier] = (countsByTier[tier] ?? 0) + count;
    }
  }
  const mode = anyWebgl && anyDom ? "mixed" : anyWebgl ? "webgl" : "dom";
  return { mode, terminalCount, wantsWebgl, countsByTier, viewCount: samples.length };
}

const RENDER_MODE_LABEL: Record<string, string> = {
  webgl: "GPU",
  dom: "No GPU",
  mixed: "Partly GPU",
};

export function WhySlowContent({ className }: WhySlowContentProps) {
  const [snapshot, setSnapshot] = useState<WhySlowSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const failStreakRef = useRef(0);

  const refresh = useCallback(async () => {
    // Skip if a fetch is already in flight so the poll interval can't stack
    // overlapping requests when a snapshot is slow to return.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsRefreshing(true);
    try {
      const next = await systemClient.getWhySlowSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(next);
      setError(false);
      failStreakRef.current = 0;
    } catch (err) {
      if (!mountedRef.current) return;
      // Log only the first failure of a streak — the poll retries every 5s
      // indefinitely, so a persistently-dead collector would otherwise write
      // an identical error line on every tick. The streak resets on success
      // so a fresh outage still logs.
      failStreakRef.current += 1;
      if (failStreakRef.current === 1) {
        logError("Failed to load why-slow snapshot", err);
      }
      setError(true);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const renderer = snapshot ? aggregateRenderer(snapshot) : null;
  const resource = snapshot?.resource ?? null;
  const snapshotAgeMs = snapshot ? Math.max(0, Date.now() - snapshot.timestamp) : 0;
  const sortedReasons = resource ? sortReasonsByContribution(resource.reasons) : [];
  const findings = snapshot ? describeSlowdowns(snapshot) : [];
  const allClear = snapshot ? isAllClear(snapshot) : false;
  const memory = snapshot?.memory ?? null;
  // A verdict over readings that didn't arrive has to say so.
  const readingsIncomplete =
    !!snapshot &&
    (!snapshot.resource ||
      !snapshot.pty ||
      !snapshot.memory ||
      !snapshot.memory.terminalWorkloads.available ||
      // Terminals exist but no view has reported how it draws them. An empty
      // renderer cache is fine with no terminals; with some, it's a gap.
      (snapshot.pty.terminalCount > 0 && snapshot.rendererTerminals.length === 0));
  // Present but old: the verdict can't speak for "right now" either.
  const readingsStale = !!snapshot?.memory?.terminalWorkloads.stale;
  const memoryWorkloads = memory?.terminalWorkloads ?? null;
  // "Has data" = a live measurement, or retained nonzero values from a prior
  // successful sweep. A never-sampled slice must render as "—", not a fake 0.
  const workloadsHaveData =
    memoryWorkloads !== null &&
    (memoryWorkloads.available ||
      (memoryWorkloads.ageMs !== null &&
        (memoryWorkloads.totalMemoryMb > 0 || memoryWorkloads.processCount > 0)));

  return (
    <div className={cn("h-full overflow-auto px-3 py-2.5 text-sm text-text-primary", className)}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <Verdict
          snapshot={snapshot}
          error={error}
          findings={findings}
          allClear={allClear}
          incomplete={readingsIncomplete}
          stale={readingsStale}
        />
        <div className="flex shrink-0 items-center gap-2">
          {snapshot && !error ? (
            <span
              data-testid="why-slow-updated-note"
              className="text-2xs tabular-nums text-text-secondary"
            >
              Updated {formatSnapshotAge(snapshotAgeMs)}
            </span>
          ) : null}
          {/* While a read is failing, the notice's Retry is the one action. */}
          {!error ? (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void refresh()}
              disabled={isRefreshing}
              aria-label="Refresh diagnostics snapshot"
            >
              <SpinningIcon icon={RefreshCw} active={isRefreshing} />
              Refresh
            </Button>
          ) : null}
        </div>
      </div>

      {error && !snapshot ? (
        <DiagnosticsNotice
          kind="failed"
          title="Couldn't read the performance snapshot"
          description="The diagnostics collector didn't answer. It's retried every 5 seconds."
          onRetry={() => void refresh()}
          retrying={isRefreshing}
        />
      ) : null}

      {snapshot && error ? (
        <DiagnosticsNotice
          kind="stale"
          className="mb-2.5"
          title="Showing older data"
          description={
            <span data-testid="why-slow-stale-note">
              Refresh failed · data from {formatSnapshotAge(snapshotAgeMs)}
            </span>
          }
          onRetry={() => void refresh()}
          retrying={isRefreshing}
        />
      ) : null}

      {!snapshot && !error ? <WhySlowSkeleton /> : null}

      {snapshot ? (
        <div className="flex flex-col gap-3">
          {sortedReasons.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-1 text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Biggest factors:</span>
              <ul aria-label="Pressure contributions" className="contents">
                {sortedReasons.map((r, index) => (
                  <li key={r.signal}>
                    {index > 0 ? "· " : ""}
                    {r.detail} <span className="tabular-nums">(+{r.contribution})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {findings.length > 0 ? <FindingsList findings={findings} /> : null}

          <section aria-labelledby="why-slow-resource">
            <SectionHeading id="why-slow-resource">Resource mode</SectionHeading>
            {resource ? (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricTile
                    label="Current mode"
                    value={PROFILE_LABEL[resource.currentProfile] ?? resource.currentProfile}
                    tone={profileTone(resource.currentProfile)}
                  />
                  <MetricTile
                    label="Heading to"
                    value={PROFILE_LABEL[resource.targetProfile] ?? resource.targetProfile}
                    tone={
                      // Moving back toward full speed is recovery, not a warning.
                      (PROFILE_RANK[resource.targetProfile] ?? 0) <
                      (PROFILE_RANK[resource.currentProfile] ?? 0)
                        ? "default"
                        : resource.targetProfile !== resource.currentProfile
                          ? "warn"
                          : profileTone(resource.targetProfile)
                    }
                  />
                  <MetricTile
                    label="Pressure score"
                    value={String(resource.pressureScore)}
                    hint="3+ means power-saving"
                    tone={resource.pressureScore >= 3 ? "warn" : "default"}
                  />
                  <MetricTile
                    label="CPU limit"
                    value={String(resource.speedLimit)}
                    unit="%"
                    tone={resource.speedLimit < 100 ? "warn" : "default"}
                  />
                </div>
              </div>
            ) : (
              <p className="text-xs text-text-secondary">Resource mode unavailable</p>
            )}
          </section>

          <section aria-labelledby="why-slow-rendering">
            <SectionHeading id="why-slow-rendering">Rendering</SectionHeading>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricTile
                label="Background checks"
                value={snapshot.focusThrottle.throttled ? "Slowed" : "Normal"}
                unit={
                  snapshot.focusThrottle.throttled
                    ? `×${snapshot.focusThrottle.pollMultiplier}`
                    : undefined
                }
                hint={snapshot.focusThrottle.throttled ? "window in background" : undefined}
              />
              <MetricTile
                label="Terminal drawing"
                value={renderer ? (RENDER_MODE_LABEL[renderer.mode] ?? renderer.mode) : "—"}
                tone={renderer && renderer.mode !== "webgl" ? "warn" : "default"}
              />
              <MetricTile
                label="Terminals"
                value={renderer ? String(renderer.terminalCount) : "—"}
              />
              <MetricTile label="Want GPU" value={renderer ? String(renderer.wantsWebgl) : "—"} />
            </div>
            {renderer && Object.keys(renderer.countsByTier).length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Terminals by refresh tier">
                {Object.entries(renderer.countsByTier).map(([tier, count]) => (
                  <Chip key={tier}>{`${tier}: ${count}`}</Chip>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-text-secondary">
                No terminal views have reported yet
              </p>
            )}
          </section>

          <section aria-labelledby="why-slow-memory">
            <SectionHeading id="why-slow-memory">Memory</SectionHeading>
            {memory && memoryWorkloads ? (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricTile
                    label="Daintree app"
                    value={memory.appMemoryMb !== null ? String(memory.appMemoryMb) : "—"}
                    unit={memory.appMemoryMb !== null ? "MB" : undefined}
                  />
                  <MetricTile
                    label="Terminal workloads"
                    value={workloadsHaveData ? String(memoryWorkloads.totalMemoryMb) : "—"}
                    unit={workloadsHaveData ? "MB" : undefined}
                  />
                  <MetricTile
                    label="Workload processes"
                    value={workloadsHaveData ? String(memoryWorkloads.processCount) : "—"}
                  />
                  <MetricTile
                    label="Workload terminals"
                    value={workloadsHaveData ? String(memoryWorkloads.terminalCount) : "—"}
                  />
                </div>
                {!memoryWorkloads.available || memoryWorkloads.stale ? (
                  <div className="flex flex-wrap gap-1.5">
                    {!memoryWorkloads.available ? (
                      <Chip tone="warn">process table unavailable</Chip>
                    ) : null}
                    {memoryWorkloads.stale ? <Chip tone="warn">workload sample stale</Chip> : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-text-secondary">Memory breakdown unavailable</p>
            )}
          </section>

          <section aria-labelledby="why-slow-background">
            <SectionHeading id="why-slow-background">Terminals and background work</SectionHeading>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <MetricTile
                label="Output waiting"
                value={snapshot.pty ? formatBytes(snapshot.pty.totalPendingBytes) : "—"}
                tone={snapshot.pty && snapshot.pty.totalPendingBytes > 0 ? "warn" : "default"}
              />
              <MetricTile
                label="Paused terminals"
                value={snapshot.pty ? String(snapshot.pty.pausedCount) : "—"}
                tone={snapshot.pty && snapshot.pty.pausedCount > 0 ? "warn" : "default"}
              />
              <MetricTile
                label="Terminal host delay"
                value={
                  snapshot.pty?.eventLoopP99Ms != null ? `${snapshot.pty.eventLoopP99Ms}ms` : "—"
                }
                hint={`under ${PTY_LAG_WARN_THRESHOLD_MS}ms`}
                tone={
                  snapshot.pty?.eventLoopP99Ms != null &&
                  snapshot.pty.eventLoopP99Ms > PTY_LAG_WARN_THRESHOLD_MS
                    ? "warn"
                    : "default"
                }
              />
              <MetricTile
                label="Watched worktrees"
                value={snapshot.worktrees ? String(snapshot.worktrees.monitorCount) : "—"}
              />
              <MetricTile
                label="Git fetches running"
                value={snapshot.worktrees ? String(snapshot.worktrees.fetchInFlightCount) : "—"}
              />
              <MetricTile
                label="Queued jobs"
                value={snapshot.workers ? String(snapshot.workers.totalQueueDepth) : "—"}
                tone={snapshot.workers && snapshot.workers.totalQueueDepth > 0 ? "warn" : "default"}
              />
            </div>
            {snapshot.workers && snapshot.workers.degraded.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {snapshot.workers.degraded.map((id) => (
                  <Chip key={id} tone="warn">{`degraded: ${id}`}</Chip>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Verdict({
  snapshot,
  error,
  findings,
  allClear,
  incomplete,
  stale,
}: {
  snapshot: WhySlowSnapshot | null;
  error: boolean;
  findings: SlowdownFinding[];
  allClear: boolean;
  incomplete: boolean;
  stale: boolean;
}) {
  const problems = findings.filter((f) => f.tone !== "info").length;
  let text: string;
  if (!snapshot) {
    text = error ? "Performance snapshot unavailable" : "Checking what's slowing Daintree down";
  } else if (problems > 0) {
    text =
      problems === 1
        ? "1 thing may be slowing Daintree down"
        : `${problems} things may be slowing Daintree down`;
  } else if (error) {
    // Stale data must not claim "right now" — the notice below carries the age.
    text = incomplete
      ? "No slowdowns at the last reading, but some readings were missing"
      : "Nothing was slowing Daintree down at the last reading";
  } else if (incomplete) {
    text = "No slowdowns found, but some readings are unavailable";
  } else if (stale) {
    text = "No slowdowns found, but some readings are out of date";
  } else if (allClear) {
    text = "";
  } else {
    text = "Nothing major is slowing Daintree down";
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Gauge aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      {text ? (
        <h3 className="truncate text-sm font-medium text-text-primary">{text}</h3>
      ) : (
        <h3
          data-testid="why-slow-all-clear"
          className="truncate text-sm font-medium text-text-primary"
        >
          Nothing is slowing Daintree down right now
        </h3>
      )}
    </div>
  );
}

// Enough to answer the question at the default dock height; the rest are a
// click away rather than pushing the readings off screen.
const FINDINGS_VISIBLE = 4;

function FindingsList({ findings }: { findings: SlowdownFinding[] }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = findings.length - FINDINGS_VISIBLE;
  const collapsible = hidden > 1;
  const visible = showAll || !collapsible ? findings : findings.slice(0, FINDINGS_VISIBLE);
  // The verdict counts slowdowns, not notes, so the disclosure says which it hides.
  const hiddenNotes = collapsible
    ? findings.slice(FINDINGS_VISIBLE).filter((f) => f.tone === "info").length
    : 0;
  const hiddenProblems = hidden - hiddenNotes;
  const moreLabel = [
    hiddenProblems > 0 ? `${hiddenProblems} more` : null,
    hiddenNotes > 0 ? plural(hiddenNotes, "note", "notes") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div className="flex flex-col gap-1">
      <ul
        id="why-slow-findings"
        className="flex flex-col gap-1.5"
        aria-label="What's slowing Daintree down"
      >
        {visible.map((finding) => (
          <FindingRow key={finding.id} finding={finding} />
        ))}
      </ul>
      {collapsible ? (
        <Button
          variant="ghost"
          size="xs"
          className="self-start text-text-primary underline decoration-text-secondary underline-offset-2"
          aria-expanded={showAll}
          aria-controls="why-slow-findings"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show ${moreLabel}`}
        </Button>
      ) : null}
    </div>
  );
}

function FindingRow({ finding }: { finding: SlowdownFinding }) {
  const Glyph =
    finding.tone === "alert" ? CircleAlert : finding.tone === "warn" ? TriangleAlert : Info;
  return (
    <li className="flex items-start gap-2" data-finding={finding.id}>
      <Glyph
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-3.5 w-3.5 shrink-0",
          finding.tone === "alert"
            ? "text-status-error"
            : finding.tone === "warn"
              ? "text-status-warning"
              : "text-text-secondary"
        )}
      />
      <div className="min-w-0 text-xs">
        <span className="text-text-primary">{finding.text}</span>
        {finding.suggestion ? (
          <span className="text-text-secondary"> — {finding.suggestion}</span>
        ) : null}
      </div>
    </li>
  );
}

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h4 id={id} className="mb-1.5 text-2xs font-medium text-text-secondary">
      {children}
    </h4>
  );
}

function WhySlowSkeleton() {
  return (
    <Skeleton label="Loading performance snapshot" className="flex flex-col gap-3">
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-1.5">
          <SkeletonBone className="h-2.5 w-24 rounded-[var(--radius-sm)]" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonBone key={i} className="h-11 rounded-[var(--radius-md)]" />
            ))}
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

function Chip({ children, tone = "default" }: { children: ReactNode; tone?: MetricTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border bg-surface-panel px-1.5 py-0.5 text-2xs text-text-secondary",
        tone === "default" ? "border-border-default" : "border-status-warning/60"
      )}
    >
      {tone !== "default" ? (
        <TriangleAlert aria-hidden="true" className="h-2.5 w-2.5 text-status-warning" />
      ) : null}
      {children}
    </span>
  );
}
