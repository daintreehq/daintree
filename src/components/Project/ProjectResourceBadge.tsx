import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { ChevronDown, ChevronRight, Coffee, TriangleAlert } from "lucide-react";
import { projectClient, systemClient } from "@/clients";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { logError } from "@/utils/logger";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import type { ProcessMetricEntry, HeapStats, DiagnosticsInfo } from "@shared/types/ipc/system";
import type { BulkProjectStatsEntry } from "@shared/types/ipc/project";
import type {
  CompositeMemorySnapshot,
  TerminalWorkloadSlice,
} from "@shared/types/memoryAccounting";
import type { Project } from "@shared/types";
import {
  type TrendDirection,
  type MemoryThresholds,
  FALLBACK_THRESHOLDS,
  computeThresholds,
  getMemoryState,
  getTrendDirection,
  formatMemory,
  formatProcessLabel,
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

/**
 * The footer mark, in the app's existing activity vocabulary: filled means work
 * in flight, a hollow ring means idle. `ActivityLight` established that pairing
 * so state survives WCAG 1.4.1 on shape alone, and reusing it here means the two
 * activity marks in the product agree instead of each inventing a language.
 *
 * `text-text-secondary` rather than a percentage of the body colour: the old
 * `bg-daintree-text/25` measured 2.02:1 against the footer in Daintree and
 * 1.66:1 in Bondi, under the 3:1 floor a graphical state indicator owes. This
 * token is the theme's own answer to "muted but readable" and is defined in all
 * fifteen.
 */
const WORKING_DOT_CLASS = "bg-text-secondary";
const IDLE_DOT_CLASS = "border border-text-secondary bg-transparent";

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
        : "bg-daintree-text/40";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-3xs">
        <span className="text-text-secondary">V8 Heap</span>
        <span className="font-mono text-text-secondary">
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
        <div className="text-4xs text-text-placeholder font-mono">
          External: {heapStats.externalMB.toFixed(0)}MB
        </div>
      )}
    </div>
  );
}

function MemoryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-3xs">
      <span className="text-text-secondary leading-tight">{label}</span>
      <span className="font-mono tabular-nums text-text-secondary shrink-0">{value}</span>
    </div>
  );
}

function MemorySummary({
  appMemoryMB,
  workloads,
  lastGoodWorkloads,
  systemAvailableMB,
}: {
  appMemoryMB: number;
  /** Current terminal-workload slice, or null when no snapshot has arrived. */
  workloads: TerminalWorkloadSlice | null;
  /** Most recent slice that was actually measured, kept across unavailable reads. */
  lastGoodWorkloads: TerminalWorkloadSlice | null;
  systemAvailableMB: number | null;
}) {
  // Prefer the live measurement. On an unavailable read fall back to the
  // retained values the pty-host kept from its last successful sweep (present
  // even on the first open after a ps failure), then to the last slice this
  // renderer saw measured — never a fake 0, never a silently-dropped row.
  const measured = workloads?.available ? workloads : null;
  const retained =
    measured === null &&
    workloads !== null &&
    workloads.sampledAt > 0 &&
    (workloads.totalMemoryMb > 0 || workloads.processCount > 0)
      ? workloads
      : null;
  const shown = measured ?? retained ?? lastGoodWorkloads;
  const workloadNote = measured?.stale
    ? `Last sampled ${Math.max(1, Math.round((measured.ageMs ?? 0) / 1000))}s ago`
    : measured === null && shown !== null
      ? "Process table unavailable — showing last reading"
      : workloads !== null && !workloads.available
        ? "Process table unavailable"
        : null;

  return (
    <div className="space-y-1">
      <MemoryRow
        label="Working set (sums shared pages per process)"
        value={formatMemory(appMemoryMB)}
      />
      {(workloads !== null || shown !== null) && (
        <MemoryRow
          label="Terminal workloads"
          value={shown !== null ? formatMemory(shown.totalMemoryMb) : "Unavailable"}
        />
      )}
      {workloadNote !== null && (
        <div className="text-4xs text-status-warning leading-tight">{workloadNote}</div>
      )}
      {systemAvailableMB !== null && (
        <MemoryRow label="System available" value={formatMemory(systemAvailableMB)} />
      )}
      {shown !== null && (
        <div className="text-4xs text-text-placeholder leading-tight">
          Workloads = dev servers, agents, and tools your terminals launched
        </div>
      )}
    </div>
  );
}

function ProcessTable({ metrics }: { metrics: ProcessMetricEntry[] }) {
  return (
    <div className="space-y-1">
      <div className="text-3xs text-text-secondary font-medium">Daintree processes</div>
      <div className="space-y-px">
        {metrics.map((proc) => {
          const label = formatProcessLabel(proc);
          return (
            <div
              key={proc.pid}
              className="flex items-center justify-between text-3xs font-mono py-0.5"
            >
              <span
                className="text-text-secondary truncate max-w-[140px]"
                title={`${label} (${proc.pid})`}
              >
                {label} <span className="text-text-placeholder">({proc.pid})</span>
              </span>
              <div className="flex gap-2 text-text-secondary shrink-0">
                <span>{proc.memoryMB}MB</span>
                <span className="w-10 text-right">{proc.cpuPercent}%</span>
              </div>
            </div>
          );
        })}
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

  const hasEstimates = entries.some((entry) => entry.stats!.terminalMemoryMB === undefined);

  return (
    <div className="space-y-1">
      <div className="text-3xs text-text-secondary font-medium">Projects</div>
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
              className="flex items-center justify-between text-3xs font-mono py-0.5 gap-2"
            >
              <span className="text-text-secondary truncate min-w-0">
                {entry.name}
                {s.topProcess && (
                  <span className="text-text-placeholder"> · {s.topProcess.name}</span>
                )}
              </span>
              <div className="flex gap-2 text-text-secondary shrink-0">
                <span>{s.terminalCount} terms</span>
                <span className="tabular-nums">{memLabel}</span>
              </div>
            </div>
          );
        })}
      </div>
      {hasEstimates && (
        <div className="text-4xs text-text-placeholder leading-tight">
          ~ estimated from terminal count, not measured
        </div>
      )}
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
        className="text-3xs text-text-secondary font-medium hover:text-text-primary transition-colors flex items-center gap-1"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        Diagnostics
      </button>
      {expanded && (
        <div className="space-y-1 text-3xs font-mono text-text-secondary pl-2">
          <div>{trendText}</div>
          <div>Uptime: {formatUptime(diagnosticsInfo.uptimeSeconds)}</div>
          {diagnosticsInfo.eventLoopP99Ms > 50 && (
            <div className="text-status-warning">
              Event loop P99: {diagnosticsInfo.eventLoopP99Ms}ms
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ProjectResourceBadgeProps {
  /**
   * Whether Daintree is currently holding the machine awake. Drives the
   * popover's explanation only — never the mark.
   *
   * It looked like the right source for "is Daintree working", since main
   * raises the blocker while agents work. It is not: `isAllowedByPolicy` is
   * `enabled && (!onBatteryPower || config.onBattery)`, and `onBattery`
   * defaults to false — so on an unplugged laptop the hold is released while
   * agents keep working, and the mark would have read idle through an entire
   * session. The hold is the FSM's verdict *plus* a power policy; the mark
   * wants the verdict alone.
   */
  holdingWakeLock?: boolean;
}

export function ProjectResourceBadge({ holdingWakeLock = false }: ProjectResourceBadgeProps = {}) {
  const [stats, setStats] = useState<AggregateStats>({
    runningProjects: 0,
    totalMemoryMB: 0,
    projects: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [popoverData, setPopoverData] = useState<PopoverData | null>(null);
  const [memorySnapshot, setMemorySnapshot] = useState<CompositeMemorySnapshot | null>(null);
  // Last workload slice that was actually measured — survives unavailable
  // reads so the popover degrades to "showing last reading" instead of
  // dropping to a fake 0 or hiding a previously-shown row.
  const [lastGoodWorkloads, setLastGoodWorkloads] = useState<TerminalWorkloadSlice | null>(null);
  const [popoverSampledAt, setPopoverSampledAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [thresholds, setThresholds] = useState<MemoryThresholds>(FALLBACK_THRESHOLDS);
  const samplesRef = useRef<number[]>([]);
  // Mirror into state so JSX doesn't read the ref during render (React Compiler).
  const [samples, setSamples] = useState<number[]>([]);

  /**
   * How many agents the FSM currently calls working, across every project.
   *
   * Read straight off the store rather than through `fetchStats`: the stats
   * push arrives on its own channel, so the mark turns over as soon as an agent
   * starts or settles instead of trailing the badge's 10s poll. It costs no
   * extra IPC — `ProjectStatusMap` already carries this for every project.
   *
   * This is the same passive PTY heuristic the keep-awake service runs on, so
   * it is no less trustworthy than the hold it replaced, and it has neither the
   * battery policy nor the enabled flag sitting in front of it.
   */
  const activeAgents = useProjectStatsStore((state) => {
    let total = 0;
    for (const entry of Object.values(state.stats)) total += entry.activeAgentCount ?? 0;
    return total;
  });

  const memoryState = getMemoryState(stats.totalMemoryMB, thresholds);
  const trend = getTrendDirection(samples, SAMPLES_PER_MIN);
  const projectIdsKey = useMemo(() => stats.projects.map((p) => p.id).join(","), [stats.projects]);

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
    let interval: ReturnType<typeof setInterval> | null = null;
    // Suppression starts a new epoch. A request in flight across one is stale by
    // an unbounded amount, so it must neither be applied on the other side nor
    // coalesce against the resume refresh.
    let generation = 0;
    let inFlightGen: number | null = null;

    // Two independent suppressions, AND'd. `document.hidden` catches a
    // minimized/occluded window; it cannot catch a cached project view, which
    // keeps reporting "visible" because caching is `removeChildView` +
    // `setVisible(false)` and Chromium tracks occlusion per BrowserWindow
    // (#11212). Polling a cached view charges main a full process-table walk
    // per interval for a readout nobody can see.
    const shouldPoll = () => !document.hidden && !isProjectViewCached();

    const runFetch = async () => {
      // Re-checked here, not just where the interval is cleared: this runs from
      // the resume paths too, and clearing an interval can't retract a callback
      // the event loop has already picked up.
      if (cancelled || !shouldPoll()) return;
      // Skip if a poll from this epoch is still in flight so a slow IPC
      // round-trip can't stack overlapping calls or write results out of order.
      // Scoped to the epoch: a request stranded by a pause must not hold the
      // resume's immediate refresh hostage for a whole interval.
      if (inFlightGen === generation) return;
      const gen = generation;
      inFlightGen = gen;
      try {
        const result = await fetchStats();
        // A result that lands after its epoch closed carries a pre-pause
        // reading, and the resume already cleared the trend window it would
        // seed — dropping it is the other half of that discard.
        if (cancelled || gen !== generation || !result) return;
        samplesRef.current = result.nextSamples;
        setSamples(result.nextSamples);
        setStats({
          runningProjects: result.runningProjects,
          totalMemoryMB: result.totalMemoryMB,
          projects: result.projects,
        });
        setIsLoading(false);
      } finally {
        if (inFlightGen === gen) inFlightGen = null;
      }
    };

    const stopInterval = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
      generation++;
    };

    // Single entry point for both gates so a repeated signal — visible while
    // already visible, `revealed` right after `active` — can't stack intervals
    // or double-fetch. The interval handle is the polling-state sentinel.
    const syncPolling = () => {
      if (!shouldPoll()) {
        stopInterval();
        return;
      }
      if (interval !== null) return;

      // The poll pauses while suppressed, so pre-pause samples are arbitrarily
      // old relative to the resumed cadence — drop them so the trend slope
      // isn't computed across the gap.
      if (samplesRef.current.length > 0) {
        samplesRef.current = [];
        setSamples([]);
      }
      // Arm the sentinel before the immediate fetch so a signal arriving during
      // that round-trip sees polling as already started.
      interval = setInterval(() => void runFetch(), BADGE_POLL_MS);
      void runFetch();
    };

    const handleVisibility = () => syncPolling();
    // Resume on any non-cached phase, not just `revealed`: a switch superseded
    // mid-flight only ever reaches `active`, and keying resume on `revealed`
    // would leave a reactivated view demoted forever.
    const offViewLifecycle = subscribeProjectViewLifecycle(() => syncPolling());

    document.addEventListener("visibilitychange", handleVisibility);
    // Not an early return when already cached — that would skip the
    // subscription above and strand the badge. `syncPolling` declines instead.
    syncPolling();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      offViewLifecycle();
      stopInterval();
    };
  }, [fetchStats]);

  // The popover's own 4s poll and 1s freshness tick are gated on `open` alone,
  // and caching a view is `removeChildView` + `setVisible(false)` — no
  // interaction inside this document, so Radix never sees a dismiss. Left open,
  // it would out-poll the badge loop gated above in a view nobody can see.
  // Closing is also what the switch implies: the user left this project.
  useEffect(
    () =>
      subscribeProjectViewLifecycle((phase) => {
        if (phase === "cached") setOpen(false);
      }),
    []
  );

  // Stale-while-revalidate: keep the last snapshot across closes so reopening
  // shows data instantly; the poll below refreshes it silently.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const fetchPopoverData = async () => {
      // Guarded in the body, not only by the `open` teardown: closing on the
      // cached phase costs a render pass, so a tick already queued when the
      // view cached would still fire, and a hidden window suppresses nothing
      // here at all — Radix keeps the popover open across both.
      if (document.hidden || isProjectViewCached()) return;
      try {
        const [processMetrics, heapStats, diagnosticsInfo, snapshot] = await Promise.all([
          systemClient.getProcessMetrics(),
          systemClient.getHeapStats(),
          systemClient.getDiagnosticsInfo(),
          // Isolate a snapshot failure: the rest of the popover still updates,
          // and the memory rows degrade to their last-good/unavailable states.
          systemClient.getMemorySnapshot().catch(() => null),
        ]);

        const projectIds = projectIdsKey ? projectIdsKey.split(",") : [];
        const projectStats =
          projectIds.length > 0 ? await projectClient.getBulkStats(projectIds) : {};

        if (!cancelled) {
          setPopoverData({ processMetrics, heapStats, diagnosticsInfo, projectStats });
          // A failed snapshot poll clears the live slice so old readings can't
          // masquerade as current; last-good values still render via
          // lastGoodWorkloads with their "showing last reading" note.
          setMemorySnapshot(snapshot);
          if (snapshot?.terminalWorkloads.available) {
            setLastGoodWorkloads(snapshot.terminalWorkloads);
          }
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

  const isWorking = activeAgents > 0;

  // The row used to vanish whenever nothing was running, which made "idle" and
  // "this strip isn't here" the same picture — and idle is half of the question
  // the footer exists to answer. It now stays put once the first read lands and
  // says so.
  const showReadout = !isLoading;

  // The Popover root outlives its trigger, and Radix's anchor ref never clears
  // on unmount — so an open popover would stay anchored to a detached node with
  // nowhere to return focus. Close it ourselves when the readout goes away.
  useEffect(() => {
    if (!showReadout) setOpen(false);
  }, [showReadout]);

  if (!showReadout) {
    return null;
  }

  // The count is a separate fact from the activity state and stays in words;
  // the mark carries working versus idle. With nothing running at all there is
  // no count worth printing, so the state becomes the label.
  const readoutLabel =
    stats.runningProjects > 0
      ? `${stats.runningProjects} project${stats.runningProjects !== 1 ? "s" : ""} active`
      : "Idle";

  // What assistive technology gets. The mark is the only thing that shows the
  // working state visually, so without spelling it out here a session that goes
  // from working to idle with its project count unchanged announces nothing.
  const announcement =
    stats.runningProjects > 0 ? `${isWorking ? "Working" : "Idle"}, ${readoutLabel}` : readoutLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        data-sidebar-status-bar=""
        className="border-t border-divider surface-chrome flex items-center shrink-0 w-full min-h-7"
      >
        <PopoverTrigger asChild>
          <button
            data-status-readout=""
            aria-label={`${announcement} — open resource breakdown`}
            className="px-4 py-1.5 flex items-center flex-1 min-w-0 self-stretch hover:bg-overlay-soft transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {/* Decorative: the working/idle state it encodes is carried in
                  words by the label and the live region, so announcing the mark
                  as well would say everything twice. */}
              <span
                key={`${isWorking}-${memoryState}`}
                aria-hidden="true"
                data-working={isWorking ? "true" : "false"}
                className={`status-mark inline-flex h-2 w-2 rounded-full shrink-0 ${
                  isWorking ? WORKING_DOT_CLASS : IDLE_DOT_CLASS
                } animate-diagnostics-flash`}
              />
              <span className="text-2xs tabular-nums text-text-secondary font-medium truncate">
                {readoutLabel}
              </span>
            </div>
          </button>
        </PopoverTrigger>
        {/* The live region is a sibling of the trigger, not its child and not
            its ancestor. Wrapping the button would re-announce the whole strip
            on every press; nesting the region inside it puts a live region in a
            control's own subtree. Visually redundant with the label above, so
            it is screen-reader only.

            It announces the working state in words, not just the count: the
            mark is the only thing that carries it visually, and a run whose
            project count never changes would otherwise go from working to idle
            in complete silence. */}
        <span role="status" className="sr-only">
          {announcement}
        </span>
        {memoryState === "critical" && (
          <span
            data-testid="sidebar-status-items"
            className="ml-auto flex items-center gap-1 pr-3 shrink-0 text-2xs font-medium text-text-primary"
          >
            {/* The triangle carries the severity colour; the words stay neutral.
                Status-coloured body text misses 4.5:1 on most of the fifteen
                themes — there is no status *text* ramp — and "High memory" has
                to be readable on all of them. */}
            <TriangleAlert className="h-3 w-3 shrink-0 text-status-warning" aria-hidden="true" />
            High memory
          </span>
        )}
      </div>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-3">
        <div className="space-y-3">
          {/* The keep-awake hold used to be a coffee cup pinned to the strip,
              where it cost a permanent unlabelled glyph to say what the mark
              now says. The explanation and its settings route survive here.

              Mounted unconditionally, with only its wording changing: the hold
              ends on main's schedule, so a row that appeared only while holding
              could vanish under a keyboard user mid-popover — the same
              focus-dropping problem the cup's own `useLayoutEffect` existed to
              patch. The shared close-time restoration does not cover a child
              disappearing while the popover stays open. */}
          <button
            type="button"
            onClick={() =>
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "general", subtab: "overview", sectionId: "general-keep-awake" },
                { source: "user" }
              )
            }
            className="flex w-full items-start gap-2 rounded-[var(--radius-sm)] p-1 text-left hover:bg-overlay-soft transition-colors"
          >
            <Coffee
              className="h-3.5 w-3.5 shrink-0 mt-0.5 text-text-secondary"
              aria-hidden="true"
            />
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-2xs font-medium text-text-primary">
                {holdingWakeLock ? "Keeping this machine awake" : "Not holding sleep off"}
              </span>
              <span className="text-3xs text-text-secondary leading-tight">
                {holdingWakeLock
                  ? "Idle sleep is held off while an agent is working. The display can still turn off."
                  : "Idle sleep is allowed right now. Change when Daintree holds it off in settings."}
              </span>
            </span>
          </button>
          {popoverData ? (
            <>
              <MemorySummary
                appMemoryMB={
                  memorySnapshot?.electron.available
                    ? memorySnapshot.electron.totalWorkingSetMb
                    : stats.totalMemoryMB
                }
                workloads={memorySnapshot?.terminalWorkloads ?? null}
                lastGoodWorkloads={lastGoodWorkloads}
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
                {ageLabel && <div className="text-4xs text-text-placeholder">{ageLabel}</div>}
                <div className="text-4xs text-text-placeholder leading-tight">
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
