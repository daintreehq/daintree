import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { projectClient, systemClient } from "@/clients";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { logError } from "@/utils/logger";
import type { ProcessMetricEntry, HeapStats, DiagnosticsInfo } from "@shared/types/ipc/system";
import type { BulkProjectStatsEntry } from "@shared/types/ipc/project";
import type { Project } from "@shared/types";
import {
  type MemoryState,
  type TrendDirection,
  type MemoryThresholds,
  FALLBACK_THRESHOLDS,
  computeThresholds,
  getMemoryState,
  getTrendDirection,
  formatMemory,
} from "./ProjectResourceBadge.utils";

const MAX_SAMPLES = 12;
const BADGE_POLL_MS = 10_000;
const POPOVER_POLL_MS = 4_000;
const SAMPLES_PER_MIN = 60_000 / BADGE_POLL_MS;
// Cadence for advancing the "updated Ns ago" freshness label while the popover is open.
const FRESHNESS_TICK_MS = 1_000;

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STATE_DOT_CLASSES: Record<MemoryState, string> = {
  normal: "bg-daintree-text/25",
  elevated: "bg-daintree-text/25",
  critical: "bg-daintree-text/25",
};

const STATE_TEXT_CLASSES: Record<MemoryState, string> = {
  normal: "text-daintree-text/30",
  elevated: "text-daintree-text/30",
  critical: "text-daintree-text/30",
};

const TREND_ARROWS: Record<TrendDirection, string> = {
  up: "\u2191",
  down: "\u2193",
  stable: "",
};

interface AggregateStats {
  runningProjects: number;
  totalMemoryMB: number;
  projects: Array<{ id: string; name: string }>;
}

interface PopoverData {
  processMetrics: ProcessMetricEntry[];
  heapStats: HeapStats;
  diagnosticsInfo: DiagnosticsInfo;
  projectStats: Record<string, BulkProjectStatsEntry>;
}

function HeapBar({ heapStats }: { heapStats: HeapStats }) {
  const barColor =
    heapStats.percent > 85
      ? "bg-status-error/80"
      : heapStats.percent > 70
        ? "bg-status-warning/80"
        : "bg-status-success/80";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-daintree-text/50">V8 Heap</span>
        <span className="font-mono text-daintree-text/40">
          {heapStats.usedMB.toFixed(0)} / {heapStats.limitMB}MB ({heapStats.percent.toFixed(0)}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-daintree-text/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] ${barColor}`}
          style={{ width: `${Math.min(heapStats.percent, 100)}%` }}
        />
      </div>
      {heapStats.externalMB > 50 && (
        <div className="text-[9px] text-daintree-text/30 font-mono">
          External: {heapStats.externalMB.toFixed(0)}MB
        </div>
      )}
    </div>
  );
}

function MemoryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-daintree-text/50">{label}</span>
      <span className="font-mono tabular-nums text-daintree-text/40">{value}</span>
    </div>
  );
}

function MemorySummary({
  appMemoryMB,
  workloadMB,
  systemAvailableMB,
}: {
  appMemoryMB: number;
  workloadMB: number | null;
  systemAvailableMB: number | null;
}) {
  return (
    <div className="space-y-1">
      <MemoryRow label="Daintree app" value={formatMemory(appMemoryMB)} />
      {workloadMB !== null && (
        <MemoryRow label="Terminal workloads" value={formatMemory(workloadMB)} />
      )}
      {systemAvailableMB !== null && (
        <MemoryRow label="System available" value={formatMemory(systemAvailableMB)} />
      )}
      {workloadMB !== null && (
        <div className="text-[9px] text-daintree-text/25 leading-tight">
          Workloads = dev servers, agents, and tools your terminals launched
        </div>
      )}
    </div>
  );
}

function ProcessTable({ metrics }: { metrics: ProcessMetricEntry[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-daintree-text/50 font-medium">Daintree processes</div>
      <div className="space-y-px">
        {metrics.map((proc) => (
          <div
            key={proc.pid}
            className="flex items-center justify-between text-[10px] font-mono py-0.5"
          >
            <span className="text-daintree-text/60 truncate max-w-[140px]">
              {proc.name} <span className="text-daintree-text/25">({proc.pid})</span>
            </span>
            <div className="flex gap-2 text-daintree-text/40 shrink-0">
              <span>{proc.memoryMB}MB</span>
              <span className="w-10 text-right">{proc.cpuPercent}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectBreakdown({
  projects,
  projectStats,
}: {
  projects: Array<{ id: string; name: string }>;
  projectStats: Record<string, BulkProjectStatsEntry>;
}) {
  const entries = projects.map((p) => ({ ...p, stats: projectStats[p.id] })).filter((p) => p.stats);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-daintree-text/50 font-medium">Projects</div>
      <div className="space-y-px">
        {entries.map((entry) => {
          const s = entry.stats!;
          // Prefer measured terminal-tree memory; the `~` prefix marks the
          // terminalCount*50 estimate used when the OS table couldn't be read.
          const memLabel =
            s.terminalMemoryMB !== undefined
              ? formatMemory(s.terminalMemoryMB)
              : `~${formatMemory(s.estimatedMemoryMB)}`;
          return (
            <div
              key={entry.id}
              className="flex items-center justify-between text-[10px] font-mono py-0.5 gap-2"
            >
              <span className="text-daintree-text/60 truncate min-w-0">
                {entry.name}
                {s.topProcess && (
                  <span className="text-daintree-text/25"> · {s.topProcess.name}</span>
                )}
              </span>
              <div className="flex gap-2 text-daintree-text/40 shrink-0">
                <span>{s.terminalCount} terms</span>
                <span className="tabular-nums">{memLabel}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiagnosticsSection({
  diagnosticsInfo,
  trend,
  trendSamples,
}: {
  diagnosticsInfo: DiagnosticsInfo;
  trend: TrendDirection;
  trendSamples: number[];
}) {
  const [expanded, setExpanded] = useState(false);

  const trendDeltaMB =
    trendSamples.length >= 2 ? trendSamples[trendSamples.length - 1]! - trendSamples[0]! : 0;
  const trendText =
    trend === "up"
      ? `Memory grew ${Math.abs(Math.round(trendDeltaMB))}MB in last 2 min`
      : trend === "down"
        ? `Memory decreased ${Math.abs(Math.round(trendDeltaMB))}MB in last 2 min`
        : "Memory stable";

  return (
    <div className="space-y-1">
      <button
        className="text-[10px] text-daintree-text/50 font-medium hover:text-daintree-text/70 transition-colors flex items-center gap-1"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[8px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        Diagnostics
      </button>
      {expanded && (
        <div className="space-y-1 text-[10px] font-mono text-daintree-text/40 pl-2">
          <div>{trendText}</div>
          <div>Uptime: {formatUptime(diagnosticsInfo.uptimeSeconds)}</div>
          {diagnosticsInfo.eventLoopP99Ms > 50 && (
            <div className="text-status-warning/80">
              Event loop P99: {diagnosticsInfo.eventLoopP99Ms}ms
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectResourceBadge() {
  const [stats, setStats] = useState<AggregateStats>({
    runningProjects: 0,
    totalMemoryMB: 0,
    projects: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [popoverData, setPopoverData] = useState<PopoverData | null>(null);
  const [popoverSampledAt, setPopoverSampledAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [thresholds, setThresholds] = useState<MemoryThresholds>(FALLBACK_THRESHOLDS);
  const samplesRef = useRef<number[]>([]);
  // Mirror into state so JSX doesn't read the ref during render (React Compiler).
  const [samples, setSamples] = useState<number[]>([]);

  const memoryState = getMemoryState(stats.totalMemoryMB, thresholds);
  const trend = getTrendDirection(samples, SAMPLES_PER_MIN);
  const projectIdsKey = useMemo(() => stats.projects.map((p) => p.id).join(","), [stats.projects]);

  // Sum measured terminal-tree memory across projects for the popover summary.
  // Null when no project reported a measurement (OS table unreadable) so the
  // row hides rather than implying a real 0.
  const workloadMB = useMemo(() => {
    if (!popoverData) return null;
    let sum = 0;
    let measured = false;
    for (const entry of Object.values(popoverData.projectStats)) {
      if (typeof entry.terminalMemoryMB === "number") {
        sum += entry.terminalMemoryMB;
        measured = true;
      }
    }
    return measured ? sum : null;
  }, [popoverData]);
  const systemAvailableMB = popoverData?.diagnosticsInfo.systemAvailableMB ?? null;
  const ageSec =
    popoverSampledAt !== null ? Math.max(0, Math.round((nowTs - popoverSampledAt) / 1000)) : null;
  const ageLabel =
    ageSec === null ? null : ageSec < 2 ? "Updated just now" : `Updated ${ageSec}s ago`;

  const fetchStats = useCallback(async () => {
    try {
      const [projects, appMetrics] = await Promise.all([
        projectClient.getAll(),
        systemClient.getAppMetrics(),
      ]);

      // Suppress the reading rather than reporting a misleading "0MB" when the
      // main process couldn't read process metrics.
      if (appMetrics.unavailable) return null;

      const currentStats = useProjectStatsStore.getState().stats;
      let running = 0;
      for (const p of projects) {
        if ((currentStats[p.id]?.processCount ?? 0) > 0) running++;
      }

      const nextSamples = [
        ...samplesRef.current.slice(-(MAX_SAMPLES - 1)),
        appMetrics.totalMemoryMB,
      ];

      return {
        nextSamples,
        runningProjects: running,
        totalMemoryMB: appMetrics.totalMemoryMB,
        projects: projects.map((p: Project) => ({ id: p.id, name: p.name })),
      };
    } catch (error) {
      logError("[ProjectResourceBadge] Failed to fetch stats", error);
      return null;
    }
  }, []);

  // Read total RAM once to scale the severity thresholds to the machine.
  useEffect(() => {
    let cancelled = false;
    void systemClient
      .getHardwareInfo()
      .then((info) => {
        if (!cancelled) setThresholds(computeThresholds(info.totalMemoryBytes));
      })
      .catch((error) => {
        logError("[ProjectResourceBadge] Failed to fetch hardware info", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const runFetch = async () => {
      // Skip if a previous poll is still in flight so a slow IPC round-trip
      // can't stack overlapping calls or write results out of order.
      if (pending) return;
      pending = true;
      try {
        const result = await fetchStats();
        if (!cancelled && result) {
          samplesRef.current = result.nextSamples;
          setSamples(result.nextSamples);
          setStats({
            runningProjects: result.runningProjects,
            totalMemoryMB: result.totalMemoryMB,
            projects: result.projects,
          });
          setIsLoading(false);
        }
      } finally {
        pending = false;
      }
    };

    const startInterval = () => {
      if (interval !== null) return;
      interval = setInterval(() => void runFetch(), BADGE_POLL_MS);
    };

    const stopInterval = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopInterval();
      } else {
        // The poll pauses while hidden, so pre-hide samples are arbitrarily old
        // relative to the resumed cadence — drop them so the trend slope isn't
        // computed across the gap.
        samplesRef.current = [];
        setSamples([]);
        void runFetch();
        startInterval();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) {
      void runFetch();
      startInterval();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      stopInterval();
    };
  }, [fetchStats]);

  // Stale-while-revalidate: keep the last snapshot across closes so reopening
  // shows data instantly; the poll below refreshes it silently.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const fetchPopoverData = async () => {
      try {
        const [processMetrics, heapStats, diagnosticsInfo] = await Promise.all([
          systemClient.getProcessMetrics(),
          systemClient.getHeapStats(),
          systemClient.getDiagnosticsInfo(),
        ]);

        const projectIds = projectIdsKey ? projectIdsKey.split(",") : [];
        const projectStats =
          projectIds.length > 0 ? await projectClient.getBulkStats(projectIds) : {};

        if (!cancelled) {
          setPopoverData({ processMetrics, heapStats, diagnosticsInfo, projectStats });
          setPopoverSampledAt(Date.now());
        }
      } catch (error) {
        logError("[ProjectResourceBadge] Failed to fetch popover data", error);
      }
    };

    void fetchPopoverData();
    const interval = setInterval(() => void fetchPopoverData(), POPOVER_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, projectIdsKey]);

  // Tick a 1s clock while the popover is open so the "updated Ns ago" label
  // advances and a stalled metric path reveals itself instead of looking fresh.
  useEffect(() => {
    if (!open) return;
    setNowTs(Date.now());
    const tick = setInterval(() => setNowTs(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(tick);
  }, [open]);

  if (isLoading || stats.runningProjects === 0) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="px-4 py-2 border-t border-divider surface-chrome flex items-center justify-between shrink-0 w-full hover:bg-daintree-text/[0.02] transition-colors cursor-pointer">
          <div className="flex items-center gap-2 min-w-0">
            <span
              key={memoryState}
              className={`inline-flex h-2 w-2 rounded-full ${STATE_DOT_CLASSES[memoryState]} animate-diagnostics-flash shrink-0`}
            />
            <span className="text-[10px] tabular-nums text-daintree-text/40 font-medium truncate">
              {stats.runningProjects} project{stats.runningProjects !== 1 ? "s" : ""} active
            </span>
          </div>
          <div
            className={`text-[10px] font-mono tabular-nums tracking-tight shrink-0 ${STATE_TEXT_CLASSES[memoryState]}`}
          >
            {trend !== "stable" && <span className="mr-0.5">{TREND_ARROWS[trend]}</span>}
            {formatMemory(stats.totalMemoryMB)}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-3">
        <div className="space-y-3">
          {popoverData ? (
            <>
              <MemorySummary
                appMemoryMB={stats.totalMemoryMB}
                workloadMB={workloadMB}
                systemAvailableMB={systemAvailableMB}
              />
              <ProjectBreakdown projects={stats.projects} projectStats={popoverData.projectStats} />
              <ProcessTable metrics={popoverData.processMetrics} />
              <HeapBar heapStats={popoverData.heapStats} />
              <DiagnosticsSection
                diagnosticsInfo={popoverData.diagnosticsInfo}
                trend={trend}
                trendSamples={samples}
              />
              <div className="pt-1 border-t border-divider space-y-0.5">
                {ageLabel && <div className="text-[9px] text-daintree-text/30">{ageLabel}</div>}
                <div className="text-[9px] text-daintree-text/25 leading-tight">
                  Figures sum working-set memory and count shared pages once per process
                </div>
              </div>
            </>
          ) : (
            <Skeleton label="Loading resource details" className="space-y-3">
              <div className="space-y-1.5">
                <SkeletonBone className="h-3 w-16" />
                <SkeletonBone className="h-3 w-full" />
                <SkeletonBone className="h-3 w-5/6" />
                <SkeletonBone className="h-3 w-3/4" />
              </div>
              <SkeletonBone className="h-1.5 w-full rounded-full" />
            </Skeleton>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
