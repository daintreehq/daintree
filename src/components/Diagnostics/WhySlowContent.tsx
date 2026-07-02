import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { systemClient } from "@/clients/systemClient";
import { logError } from "@/utils/logger";
import type { WhySlowSnapshot } from "@shared/types/whySlow";

export interface WhySlowContentProps {
  className?: string;
}

// Keep the dock live without a live-pull into the renderer: the snapshot IPC
// reads a passively-maintained main-process cache, so a light poll is cheap.
const REFRESH_INTERVAL_MS = 2_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const next = await systemClient.getWhySlowSnapshot();
      setSnapshot(next);
      setError(false);
    } catch (err) {
      logError("Failed to load why-slow snapshot", err);
      setError(true);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const renderer = snapshot ? aggregateRenderer(snapshot) : null;
  const resource = snapshot?.resource ?? null;

  return (
    <div className={cn("h-full overflow-auto p-3 text-sm text-daintree-text", className)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-daintree-text/60" />
          <span className="font-medium">Why am I slow?</span>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-daintree-text/70 hover:text-daintree-text hover:bg-tint/[0.06] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent disabled:opacity-50"
          aria-label="Refresh diagnostics snapshot"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && !snapshot ? (
        <div className="text-status-error text-xs">Couldn't load the diagnostics snapshot.</div>
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
                {resource.reasons.length > 0 ? (
                  <ul className="flex flex-col gap-1 mt-1">
                    {resource.reasons.map((r) => (
                      <li
                        key={r.signal}
                        className="flex items-center justify-between text-xs text-daintree-text/75 font-mono"
                      >
                        <span>{r.detail}</span>
                        <span className="text-daintree-text/45">+{r.contribution}</span>
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
                  <Badge key={tier}>
                    {tier}: {count}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-daintree-text/45 mt-2">
                No terminal renderer reports yet.
              </p>
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
            </div>
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
