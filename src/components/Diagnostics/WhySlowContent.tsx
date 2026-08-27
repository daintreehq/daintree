import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { systemClient } from "@/clients/systemClient";
import { logError } from "@/utils/logger";
import type { WhySlowSnapshot } from "@shared/types/whySlow";

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

// Shared by the PTY-lag tile tone and isAllClear so the calm summary can never
// disagree with a warn-toned tile over the same number.
const PTY_LAG_WARN_THRESHOLD_MS = 50;

/**
 * True when nothing in the snapshot would render a warn/alert tone — the same
 * conditions the tiles and badges below use, so the calm summary line can
 * never contradict a highlighted metric next to it. The resource and pty
 * sections must be present: a section degraded to null means "unknown", and
 * claiming all-clear over missing data would be false calm. `worktrees` may be
 * null legitimately (no workspace open), so it only vetoes when present, as do
 * renderer samples (an empty push cache just means no view has reported yet).
 */
export function isAllClear(snapshot: WhySlowSnapshot): boolean {
  const r = snapshot.resource;
  if (!r) return false;
  if (
    r.currentProfile !== "performance" ||
    r.targetProfile !== "performance" ||
    r.reasons.length > 0 ||
    r.lagPressureActive ||
    r.interactiveOverrideActive ||
    r.isOnBattery ||
    (r.thermalState !== "unknown" && r.thermalState !== "nominal") ||
    r.speedLimit < 100
  ) {
    return false;
  }
  if (snapshot.focusThrottle.throttled) return false;
  // Any view on the DOM fallback renders the WebGL tile in warn tone.
  if (snapshot.rendererTerminals.some((s) => s.webglMode === "dom")) return false;
  const p = snapshot.pty;
  if (!p) return false;
  if (p.totalPendingBytes > 0 || p.pausedCount > 0) return false;
  if (p.eventLoopP99Ms !== null && p.eventLoopP99Ms > PTY_LAG_WARN_THRESHOLD_MS) return false;
  if (snapshot.worktrees && snapshot.worktrees.fetchInFlightCount > 0) return false;
  return true;
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

function profileTone(profile: string): MetricTone {
  if (profile === "efficiency") return "alert";
  if (profile === "balanced") return "warn";
  return "default";
}

type MetricTone = "default" | "warn" | "alert";

interface MetricTileProps {
  label: string;
  value: string;
  unit?: string;
  tone?: MetricTone;
}

function MetricTile({ label, value, unit, tone = "default" }: MetricTileProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2 rounded border border-daintree-border/40 bg-daintree-sidebar/30",
        tone === "warn" && "border-status-warning/40 bg-status-warning/5",
        tone === "alert" && "border-status-error/40 bg-status-error/5"
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium">
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-lg font-mono tabular-nums text-daintree-text",
            tone === "warn" && "text-status-warning",
            tone === "alert" && "text-status-error"
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-xs text-daintree-text/55 font-mono">{unit}</span> : null}
      </div>
    </div>
  );
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
  const memory = snapshot?.memory ?? null;
  const memoryWorkloads = memory?.terminalWorkloads ?? null;
  // "Has data" = a live measurement, or retained nonzero values from a prior
  // successful sweep. A never-sampled slice must render as "—", not a fake 0.
  const workloadsHaveData =
    memoryWorkloads !== null &&
    (memoryWorkloads.available ||
      (memoryWorkloads.ageMs !== null &&
        (memoryWorkloads.totalMemoryMb > 0 || memoryWorkloads.processCount > 0)));

  return (
    <div className={cn("h-full overflow-auto p-3 text-sm text-daintree-text", className)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-daintree-text/60" />
          <span className="font-medium">Why am I slow?</span>
        </div>
        <div className="flex items-center gap-2">
          {snapshot ? (
            error ? (
              <span
                data-testid="why-slow-stale-note"
                className="text-[10px] text-status-warning/80 tabular-nums"
              >
                Refresh failed · data from {formatSnapshotAge(snapshotAgeMs)}
              </span>
            ) : (
              <span
                data-testid="why-slow-updated-note"
                className="text-[10px] text-text-secondary tabular-nums"
              >
                Updated {formatSnapshotAge(snapshotAgeMs)}
              </span>
            )
          ) : null}
          <button
            onClick={() => void refresh()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-daintree-text/70 hover:text-daintree-text hover:bg-tint/[0.06] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent disabled:opacity-50"
            aria-label="Refresh diagnostics snapshot"
          >
            <SpinningIcon icon={RefreshCw} active={isRefreshing} className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {error && !snapshot ? (
        <div className="text-status-error text-xs">Couldn't load the diagnostics snapshot.</div>
      ) : null}

      {/* Suppressed while a refresh is failing: "right now" from stale data
          would contradict the stale note in the header. */}
      {snapshot && !error && isAllClear(snapshot) ? (
        <p data-testid="why-slow-all-clear" className="text-xs text-daintree-text/55 mb-3">
          Nothing is slowing Daintree down right now
        </p>
      ) : null}

      {snapshot ? (
        <div className="flex flex-col gap-4">
          {/* Resource profile + reasons */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium mb-2">
              Resource profile
            </h3>
            {resource ? (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <MetricTile
                    label="Current"
                    value={resource.currentProfile}
                    tone={profileTone(resource.currentProfile)}
                  />
                  <MetricTile
                    label="Target"
                    value={resource.targetProfile}
                    tone={
                      resource.targetProfile !== resource.currentProfile
                        ? "warn"
                        : profileTone(resource.targetProfile)
                    }
                  />
                  <MetricTile label="Pressure" value={String(resource.pressureScore)} />
                  <MetricTile
                    label="CPU limit"
                    value={String(resource.speedLimit)}
                    unit="%"
                    tone={resource.speedLimit < 100 ? "warn" : "default"}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {resource.lagPressureActive ? (
                    <Badge tone="alert">
                      event-loop lag{resource.lagEscalatedActive ? " (escalated)" : ""}
                    </Badge>
                  ) : null}
                  {resource.interactiveOverrideActive ? (
                    <Badge tone="warn">interactive override</Badge>
                  ) : null}
                  {resource.isOnBattery ? <Badge tone="warn">on battery</Badge> : null}
                  {resource.thermalState !== "unknown" && resource.thermalState !== "nominal" ? (
                    <Badge tone="warn">thermal {resource.thermalState}</Badge>
                  ) : null}
                </div>
                {sortedReasons.length > 0 ? (
                  <ul className="flex flex-col gap-1 mt-1">
                    {sortedReasons.map((r, index) => (
                      <li
                        key={r.signal}
                        className={cn(
                          "flex items-center justify-between text-xs font-mono",
                          // Bottleneck-first: the top contributor is the likely
                          // answer, so it reads at full strength; the rest recede.
                          index === 0 && sortedReasons.length > 1
                            ? "text-daintree-text font-medium"
                            : "text-daintree-text/75"
                        )}
                      >
                        <span>{r.detail}</span>
                        <span className="text-daintree-text/45 font-normal">+{r.contribution}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-daintree-text/45">No active pressure signals.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-daintree-text/45">Resource profile unavailable.</p>
            )}
          </section>

          {/* Rendering + throttle */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium mb-2">
              Rendering &amp; throttle
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MetricTile
                label="Focus throttle"
                value={snapshot.focusThrottle.throttled ? "on" : "off"}
                unit={
                  snapshot.focusThrottle.throttled
                    ? `×${snapshot.focusThrottle.pollMultiplier}`
                    : undefined
                }
                tone={snapshot.focusThrottle.throttled ? "warn" : "default"}
              />
              <MetricTile
                label="Terminal WebGL"
                value={renderer ? renderer.mode : "—"}
                tone={renderer && renderer.mode !== "webgl" ? "warn" : "default"}
              />
              <MetricTile
                label="Terminals"
                value={renderer ? String(renderer.terminalCount) : "—"}
              />
              <MetricTile
                label="WebGL wants"
                value={renderer ? String(renderer.wantsWebgl) : "—"}
              />
            </div>
            {renderer && Object.keys(renderer.countsByTier).length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Object.entries(renderer.countsByTier).map(([tier, count]) => (
                  <Badge key={tier}>{`${tier}: ${count}`}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-daintree-text/45 mt-2">
                No terminal renderer reports yet.
              </p>
            )}
          </section>

          {/* Memory: Daintree's own processes vs terminal descendant workloads */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium mb-2">
              Memory
            </h3>
            {memory && memoryWorkloads ? (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                      <Badge tone="warn">process table unavailable</Badge>
                    ) : null}
                    {memoryWorkloads.stale ? (
                      <Badge tone="warn">workload sample stale</Badge>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-daintree-text/45">Memory attribution unavailable.</p>
            )}
          </section>

          {/* PTY + worktrees */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium mb-2">
              PTY &amp; worktrees
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MetricTile
                label="PTY queued"
                value={snapshot.pty ? formatBytes(snapshot.pty.totalPendingBytes) : "—"}
                tone={snapshot.pty && snapshot.pty.totalPendingBytes > 0 ? "warn" : "default"}
              />
              <MetricTile
                label="Paused PTYs"
                value={snapshot.pty ? String(snapshot.pty.pausedCount) : "—"}
                tone={snapshot.pty && snapshot.pty.pausedCount > 0 ? "warn" : "default"}
              />
              <MetricTile
                label="PTY host lag p99"
                value={
                  snapshot.pty?.eventLoopP99Ms != null ? `${snapshot.pty.eventLoopP99Ms}ms` : "—"
                }
                tone={
                  snapshot.pty?.eventLoopP99Ms != null &&
                  snapshot.pty.eventLoopP99Ms > PTY_LAG_WARN_THRESHOLD_MS
                    ? "warn"
                    : "default"
                }
              />
              <MetricTile
                label="Worktree monitors"
                value={snapshot.worktrees ? String(snapshot.worktrees.monitorCount) : "—"}
              />
              <MetricTile
                label="Fetches in flight"
                value={snapshot.worktrees ? String(snapshot.worktrees.fetchInFlightCount) : "—"}
                tone={
                  snapshot.worktrees && snapshot.worktrees.fetchInFlightCount > 0
                    ? "warn"
                    : "default"
                }
              />
              <MetricTile
                label="Worker queue"
                value={snapshot.workers ? String(snapshot.workers.totalQueueDepth) : "—"}
                tone={snapshot.workers && snapshot.workers.totalQueueDepth > 0 ? "warn" : "default"}
              />
            </div>
            {snapshot.workers && snapshot.workers.degraded.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {snapshot.workers.degraded.map((id) => (
                  <Badge key={id} tone="warn">{`degraded: ${id}`}</Badge>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        !error && <p className="text-xs text-daintree-text/45">Loading…</p>
      )}
    </div>
  );
}

function Badge({ children, tone = "default" }: { children: ReactNode; tone?: MetricTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono border border-daintree-border/40 bg-daintree-sidebar/40 text-daintree-text/75",
        tone === "warn" && "border-status-warning/40 bg-status-warning/10 text-status-warning",
        tone === "alert" && "border-status-error/40 bg-status-error/10 text-status-error"
      )}
    >
      {children}
    </span>
  );
}
