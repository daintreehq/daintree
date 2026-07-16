// eager-import-allow: reads process memory stats via sync fs
import os from "os";
import v8 from "node:v8";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import { refreshAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { getWritesSuppressed } from "./diskPressureState.js";
import { getIsE2EFaultMode } from "../setup/runtimeFlags.js";
import { getSystemMemoryThresholds, readAvailableSystemMemoryMb } from "../utils/systemMemory.js";

const POLL_INTERVAL_MS = 30_000;
const SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000;

// Per-process-type warn thresholds as fractions of total device RAM. Calibrated
// against the previous absolute ceilings (Browser 300 / Tab 768 / Utility 500)
// on an 8 GB baseline — fraction × 8192 MB reproduces the legacy value exactly,
// so behavior on a typical low-end machine is unchanged.
const BROWSER_MEMORY_FRACTION = 300 / 8192;
const TAB_MEMORY_FRACTION = 768 / 8192;
const UTILITY_MEMORY_FRACTION = 500 / 8192;

// Combined working-set ceiling across all monitored processes. Working-set
// sums double-count shared library pages on macOS, so this is intentionally
// generous — it is a pressure heuristic, not a precise private-footprint
// budget. 25% of total RAM is enough headroom that the per-process thresholds
// trip first under typical leak shapes while still catching fan-out cases
// where several processes individually stay below their own limits.
const AGGREGATE_MEMORY_FRACTION = 0.25;

const SNAPSHOT_THRESHOLD_MB = 600;

const MONITORED_TYPES = new Set(["Browser", "Tab", "Utility"]);

const BUCKET_TICKS = 2;
const BUCKET_WINDOW = 30;
const EMA_ALPHA = 2 / (BUCKET_WINDOW + 1);
const STARTUP_SUPPRESSION_MS = 15 * 60 * 1000;
const TREND_WARN_MB_PER_HOUR = 5;

export const WARMUP_INTERVALS = 5;
export const PRESSURE_COUNT_TIER2 = 3;
export const MITIGATION_COOLDOWN_MS = 10 * 60 * 1000;
export const TIER1_MITIGATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Settle window between applying a tier 1 mitigation step and re-sampling
 * footprint via `app.getAppMetrics()`. Chromium PartitionAlloc returns freed
 * pages to the OS via background `MemoryReclaimer` (`MADV_FREE` on
 * macOS/Linux, Windows background trim), so privateBytes lags reclamation by
 * a few seconds. 3s sits within the 2–5s window confirmed reliable on all
 * three platforms while staying well under {@link POLL_INTERVAL_MS}.
 */
export const RECLAIM_SETTLE_MS = 3_000;

/**
 * Below this MB delta, tier 1 is considered to have reclaimed effectively
 * nothing — if pressure also persists after the settle window, the ladder
 * escalates to tier 2. Above this threshold tier 1 is judged to have worked
 * (the pressure that prompted us may have legitimately re-arrived, but
 * that's a different cycle and should not chain into immediate escalation).
 */
export const MIN_RECLAIMED_MB = 50;

interface PidTrendState {
  startedAt: number;
  tickInBucket: number;
  bucketMin: number;
  ema: number;
  emaHistory: number[];
}

/**
 * Per-pid memory trend state, promoted to module scope so diagnostics can read
 * a bounded snapshot of the EMA history the monitor already maintains. Cleared
 * at the top of {@link startAppMetricsMonitor} (so repeated starts in tests
 * don't bleed stale pids) and on system suspend.
 */
const trendState = new Map<number, PidTrendState>();

export interface MainProcessTrendSample {
  /** OS process id. Join to app.getAppMetrics() by pid, not webContentsId. */
  pid: number;
  /** Epoch ms when this pid was first sampled in the current monitor lifetime. */
  startedAt: number;
  /** Latest exponential moving average of working-set footprint, in MB. */
  emaMb: number;
  /** Bounded rolling EMA history (≤ BUCKET_WINDOW entries), in MB, oldest→newest. */
  emaHistoryMb: number[];
}

/**
 * Bounded snapshot of the per-pid memory trend buffers for diagnostics export.
 * Returns deep copies — never the live history arrays — so a diagnostics read
 * can't race the 30s poll that mutates them. All values derive from
 * workingSetSize (the only cross-platform memory field; #8646).
 */
export function getTrendSnapshot(): MainProcessTrendSample[] {
  const out: MainProcessTrendSample[] = [];
  for (const [pid, state] of trendState) {
    out.push({
      pid,
      startedAt: state.startedAt,
      emaMb: Math.round(state.ema),
      emaHistoryMb: state.emaHistory.map((v) => Math.round(v)),
    });
  }
  return out;
}

export interface BlinkMemorySample {
  /**
   * process.getBlinkMemoryInfo().allocated — kilobytes currently in use by
   * Blink. Note: the Electron API reports KB, not bytes (electron.d.ts:
   * BlinkMemoryInfo).
   */
  allocated: number;
  /** Reserved for future Electron versions; not populated on Electron 41. */
  marked?: number;
  /**
   * process.getBlinkMemoryInfo().total — total reserved kilobytes (allocated
   * + free) when the renderer reports it.
   */
  total?: number;
  /** Reserved for future Electron versions; not populated on Electron 41. */
  partitionAlloc?: number;
  /** Wall-clock time the sample was recorded. */
  timestamp: number;
}

const blinkSamples = new Map<number, BlinkMemorySample>();

/**
 * Called by the IPC handler when a renderer reports its Blink memory snapshot.
 * Keyed by webContents id; cleared on view eviction via `forgetBlinkSample`.
 * Logs at debug level — issue #6272 is about visibility, not alerting.
 */
export function recordBlinkSample(
  webContentsId: number,
  sample: Omit<BlinkMemorySample, "timestamp">
): void {
  const stored: BlinkMemorySample = { ...sample, timestamp: Date.now() };
  blinkSamples.set(webContentsId, stored);
  logDebug("blink-memory-sample", {
    webContentsId,
    // sample.allocated/total are in kilobytes per Electron's BlinkMemoryInfo.
    allocatedMb: Math.round(sample.allocated / 1024),
    totalMb: typeof sample.total === "number" ? Math.round(sample.total / 1024) : undefined,
  });
}

/** Drop a renderer's last Blink sample (call from ProjectViewManager onViewEvicted). */
export function forgetBlinkSample(webContentsId: number): void {
  blinkSamples.delete(webContentsId);
}

/** Read-only view for diagnostics / tests. */
export function getBlinkSamples(): ReadonlyMap<number, BlinkMemorySample> {
  return blinkSamples;
}

/** Ratio (blocking / sample window) considered "saturated" for a single sample. */
export const RENDERER_ELU_HIGH_RATIO = 0.85;

/**
 * Number of consecutive saturated samples required before logging a
 * sustained-high warning. POLL_INTERVAL_MS is 30s, so 6 samples = 3 minutes
 * of continuous saturation. A single sub-threshold sample resets the streak.
 */
export const RENDERER_ELU_HIGH_SAMPLE_COUNT = 6;

export interface RendererEluSample {
  /** Total LoAF blockingDuration accumulated by the preload over the window, in ms. */
  blockingDurationMs: number;
  /** Wall-clock width of the sample window the preload measured against, in ms. */
  sampleWindowMs: number;
  /** Derived ratio = blockingDurationMs / sampleWindowMs, clamped to [0, 1]. */
  ratio: number;
  /** Wall-clock time the sample was recorded. */
  timestamp: number;
}

const eluSamples = new Map<number, RendererEluSample>();
const eluHighStreak = new Map<number, number>();

/**
 * Called by the IPC handler when a renderer reports its accumulated long-
 * animation-frame blocking time. Keyed by webContents id; cleared on view
 * eviction via `forgetEluSample`. Logs at debug level for every sample;
 * emits exactly one `renderer-elu-sustained-high` warn when the per-view
 * streak first hits {@link RENDERER_ELU_HIGH_SAMPLE_COUNT}. The streak
 * continues incrementing past the threshold, but only the boundary crossing
 * is logged to avoid flooding.
 */
export function recordEluSample(
  webContentsId: number,
  payload: { blockingDurationMs: number; sampleWindowMs: number }
): void {
  const { blockingDurationMs, sampleWindowMs } = payload;
  if (sampleWindowMs <= 0) return;
  const rawRatio = blockingDurationMs / sampleWindowMs;
  const ratio = rawRatio < 0 ? 0 : rawRatio > 1 ? 1 : rawRatio;
  const stored: RendererEluSample = {
    blockingDurationMs,
    sampleWindowMs,
    ratio,
    timestamp: Date.now(),
  };
  eluSamples.set(webContentsId, stored);
  logDebug("renderer-elu-sample", {
    webContentsId,
    ratio: Math.round(ratio * 100) / 100,
    blockingDurationMs: Math.round(blockingDurationMs),
    sampleWindowMs,
  });

  if (ratio >= RENDERER_ELU_HIGH_RATIO) {
    const next = (eluHighStreak.get(webContentsId) ?? 0) + 1;
    eluHighStreak.set(webContentsId, next);
    if (next === RENDERER_ELU_HIGH_SAMPLE_COUNT) {
      logWarn("renderer-elu-sustained-high", {
        webContentsId,
        ratio: Math.round(ratio * 100) / 100,
        consecutiveSamples: next,
        windowMs: sampleWindowMs * next,
      });
    }
  } else {
    eluHighStreak.delete(webContentsId);
  }
}

/** Drop a renderer's last ELU sample and streak (call from view eviction). */
export function forgetEluSample(webContentsId: number): void {
  eluSamples.delete(webContentsId);
  eluHighStreak.delete(webContentsId);
}

/**
 * A streak whose latest sample is older than this many poll periods is stale
 * — the view was evicted mid-streak, its window closed, or sampling paused
 * across a suspend — and must not keep the pressure signal latched.
 */
const RENDERER_ELU_STALE_POLL_PERIODS = 2;

/**
 * True while any view's consecutive-saturation streak has reached
 * {@link RENDERER_ELU_HIGH_SAMPLE_COUNT} and its latest sample is fresh.
 * Consumed by ResourceProfileService as a pressure input — the data is
 * already collected on the 30s poll cadence, so reading it adds no
 * measurement cost.
 */
export function hasSustainedRendererSaturation(now = Date.now()): boolean {
  const staleMs = currentAppMetricsPollIntervalMs * RENDERER_ELU_STALE_POLL_PERIODS;
  for (const [webContentsId, streak] of eluHighStreak) {
    if (streak < RENDERER_ELU_HIGH_SAMPLE_COUNT) continue;
    const sample = eluSamples.get(webContentsId);
    if (!sample) continue;
    if (now - sample.timestamp > staleMs) continue;
    return true;
  }
  return false;
}

/** Read-only view for diagnostics / tests. */
export function getEluSamples(): ReadonlyMap<number, RendererEluSample> {
  return eluSamples;
}

/** Read-only view of per-view consecutive saturated-sample counts (tests). */
export function getEluHighStreaks(): ReadonlyMap<number, number> {
  return eluHighStreak;
}

export interface MemoryPressureActions {
  /**
   * Returns the number of hidden portal tabs actually destroyed. The
   * `window:destroy-hidden-webviews` push that rides along is fire-and-forget,
   * so its effect is deliberately NOT counted here — a count is only reported
   * where the caller can observe the outcome.
   */
  destroyHiddenWebviews: (tier: 1 | 2) => Promise<number>;
  hibernateIdleProjects: () => Promise<void>;
  /** Returns the number of cached project views evicted. */
  evictCachedProjectViews?: () => Promise<number> | number;
  trimPtyHostState?: () => void;
  /**
   * Optional Blink memory sampler. If wired, called once per poll BEFORE
   * pressure evaluation so renderer samples land alongside the metrics
   * snapshot. Implementations should fan a `window:sample-blink-memory`
   * push event out to live renderers; renderers reply via the
   * `system:report-blink-memory` IPC channel which calls `recordBlinkSample`.
   */
  sampleBlinkMemory?: () => void;
  /**
   * Optional renderer event-loop utilization sampler. If wired, fans a
   * `window:sample-renderer-elu` push event to every active renderer (cached
   * views are skipped — JS timer throttling makes their samples meaningless).
   * Renderers reply via `system:report-renderer-elu` which calls
   * `recordEluSample`. Failures are non-critical observability.
   */
  sampleRendererElu?: () => void;
}

// workingSetSize is the only memory field Electron guarantees on all three
// platforms: privateBytes is Windows-only and reported as 0 (not undefined)
// on macOS/Linux, which silently defeated the previous `privateBytes ??
// workingSetSize` fallback.
function getProcessMemoryMb(proc: Electron.ProcessMetric): number {
  return proc.memory.workingSetSize / 1024;
}

/**
 * Read system-wide available memory in MB. On macOS, "available" = free +
 * purgeable, because Darwin holds reclaimable pages as purgeable rather than
 * free — using `free` alone would fire false positives on every healthy mac.
 * On Windows/Linux, `free` alone is accurate. Returns null when the Chromium
 * API is unavailable (e.g., under test mocks). Mirrors the pattern in
 * ProjectViewManager.getAvailableMemoryMb so the two memory floors stay in
 * sync.
 */
const e2ePollIntervalMs = getIsE2EFaultMode()
  ? Number(process.env.DAINTREE_E2E_APP_METRICS_POLL_INTERVAL_MS)
  : Number.NaN;
let currentAppMetricsPollIntervalMs =
  Number.isFinite(e2ePollIntervalMs) && e2ePollIntervalMs >= 250
    ? e2ePollIntervalMs
    : POLL_INTERVAL_MS;
let rearmAppMetricsTimer: (() => void) | null = null;
let appMetricsPollFn: (() => void) | null = null;

export function setAppMetricsMonitorPollInterval(ms: number): void {
  if (ms === currentAppMetricsPollIntervalMs) return;
  currentAppMetricsPollIntervalMs = ms;
  rearmAppMetricsTimer?.();
}

export function refreshAppMetricsMonitor(): void {
  appMetricsPollFn?.();
}

export function startAppMetricsMonitor(actions?: MemoryPressureActions): () => void {
  // Scale thresholds to device RAM once per monitor lifetime. os.totalmem() is
  // stable for the process lifetime; mirroring ResourceProfileService's
  // constructor pattern keeps the spy-on-totalmem pattern working in tests.
  const totalMemMb = os.totalmem() / 1024 / 1024;
  const warnThresholdsMb: Record<string, number> = {
    Browser: totalMemMb * BROWSER_MEMORY_FRACTION,
    Tab: totalMemMb * TAB_MEMORY_FRACTION,
    Utility: totalMemMb * UTILITY_MEMORY_FRACTION,
  };
  const aggregateWarnThresholdMb = totalMemMb * AGGREGATE_MEMORY_FRACTION;
  const systemLowMemoryThresholdMb = getSystemMemoryThresholds(totalMemMb).criticalMb;

  const snapshotCooldowns = new Map<number, number>();
  // trendState is module-level (see getTrendSnapshot) so diagnostics can read
  // it. Reset on each (re)start so a previous monitor lifetime's pids don't
  // bleed into a fresh one — tests call startAppMetricsMonitor repeatedly.
  trendState.clear();
  let removeSuspendListener: (() => void) | null = null;
  let removeWakeListener: (() => void) | null = null;
  let pollCount = 0;
  let consecutivePressureCount = 0;
  let lastTier1At = 0;
  let lastTier1ReclaimMb = 0;
  let lastTier2At = 0;
  let mitigationInFlight = false;
  const thresholdExceededPids = new Set<number>();
  const trendWarnedPids = new Set<number>();

  const poll = () => {
    try {
      pollCount++;
      try {
        actions?.sampleBlinkMemory?.();
      } catch {
        /* non-critical */
      }
      try {
        actions?.sampleRendererElu?.();
      } catch {
        /* non-critical */
      }
      // Force-refresh (never read stale): this poll is the canonical sweep on
      // the aligned 30s tick and primes the shared snapshot for read-through
      // consumers (ResourceProfileService's eval on the same tick).
      const metrics = refreshAppMetricsSnapshot();
      const activePids = new Set<number>();
      let hasPressure = false;
      let aggregateMb = 0;

      for (const proc of metrics) {
        if (!MONITORED_TYPES.has(proc.type)) continue;

        activePids.add(proc.pid);
        const mb = getProcessMemoryMb(proc);
        aggregateMb += mb;
        logDebug("process-memory-sample", { pid: proc.pid, type: proc.type, mb: Math.round(mb) });

        const threshold = warnThresholdsMb[proc.type];
        if (threshold !== undefined && mb > threshold) {
          hasPressure = true;
          if (!thresholdExceededPids.has(proc.pid)) {
            thresholdExceededPids.add(proc.pid);
            logWarn("process-memory-threshold-exceeded", {
              pid: proc.pid,
              type: proc.type,
              mb: Math.round(mb),
              thresholdMb: Math.round(threshold),
            });
          }
        } else if (threshold !== undefined) {
          thresholdExceededPids.delete(proc.pid);
        }

        let state = trendState.get(proc.pid);
        if (!state) {
          state = {
            startedAt: Date.now(),
            tickInBucket: 0,
            bucketMin: mb,
            ema: mb,
            emaHistory: [],
          };
          trendState.set(proc.pid, state);
        }

        state.bucketMin = Math.min(state.bucketMin, mb);
        state.tickInBucket++;

        if (state.tickInBucket === BUCKET_TICKS) {
          state.ema = EMA_ALPHA * state.bucketMin + (1 - EMA_ALPHA) * state.ema;
          state.emaHistory.push(state.ema);
          if (state.emaHistory.length > BUCKET_WINDOW) {
            state.emaHistory.shift();
          }

          if (
            Date.now() - state.startedAt >= STARTUP_SUPPRESSION_MS &&
            state.emaHistory.length === BUCKET_WINDOW
          ) {
            const oldest = state.emaHistory[0]!;
            const newest = state.emaHistory[BUCKET_WINDOW - 1]!;
            const windowHours = ((BUCKET_WINDOW - 1) * 60) / 3600;
            const growthMbPerHour = (newest - oldest) / windowHours;
            if (growthMbPerHour > TREND_WARN_MB_PER_HOUR) {
              if (!trendWarnedPids.has(proc.pid)) {
                trendWarnedPids.add(proc.pid);
                logWarn("process-memory-trend-warning", {
                  pid: proc.pid,
                  type: proc.type,
                  growthMbPerHour: Math.round(growthMbPerHour),
                });
              }
            } else if (growthMbPerHour <= 0) {
              trendWarnedPids.delete(proc.pid);
            }
          }

          state.tickInBucket = 0;
          state.bucketMin = Infinity;
        }

        if (proc.type === "Browser" && mb > SNAPSHOT_THRESHOLD_MB && !app.isPackaged) {
          const now = Date.now();
          const last = snapshotCooldowns.get(proc.pid) ?? 0;
          if (now - last > SNAPSHOT_COOLDOWN_MS) {
            try {
              if (getWritesSuppressed()) {
                logDebug("heap-snapshot-suppressed", {
                  pid: proc.pid,
                  reason: "disk-pressure-write-gate",
                });
              } else {
                const dir = app.getPath("logs");
                mkdirSync(dir, { recursive: true });
                const file = path.join(dir, `heap-${proc.pid}-${now}.heapsnapshot`);
                const written = v8.writeHeapSnapshot(file);
                snapshotCooldowns.set(proc.pid, now);
                logWarn("heap-snapshot-written", { path: written });
              }
            } catch (err) {
              logWarn("heap-snapshot-failed", { error: String(err) });
            }
          }
        }
      }

      // Aggregate working-set check: fans-out of small processes can collectively
      // exceed a safe footprint without any single one tripping its per-type
      // threshold. Feeds the same hasPressure signal so the existing tiered
      // mitigation pipeline handles the response — no separate log emission to
      // avoid noisy parallel warnings alongside per-process notices.
      if (aggregateMb > aggregateWarnThresholdMb) {
        hasPressure = true;
      }

      // System-wide signal uses a RAM-relative floor capped at 1 GB. The cap
      // avoids treating the large natural file-cache footprint of 64–128 GB
      // macOS machines as critical pressure while retaining proportional
      // thresholds on constrained machines.
      const availableMb = readAvailableSystemMemoryMb();
      const systemPressureActive = availableMb !== null && availableMb < systemLowMemoryThresholdMb;
      if (systemPressureActive) {
        hasPressure = true;
      }

      for (const pid of trendState.keys()) {
        if (!activePids.has(pid)) trendState.delete(pid);
      }
      for (const pid of thresholdExceededPids) {
        if (!activePids.has(pid)) thresholdExceededPids.delete(pid);
      }
      for (const pid of trendWarnedPids) {
        if (!activePids.has(pid)) trendWarnedPids.delete(pid);
      }
      for (const pid of snapshotCooldowns.keys()) {
        if (!activePids.has(pid)) snapshotCooldowns.delete(pid);
      }

      if (pollCount <= WARMUP_INTERVALS || !actions) {
        consecutivePressureCount = 0;
        return;
      }

      if (hasPressure) {
        consecutivePressureCount++;
      } else {
        consecutivePressureCount = 0;
        lastTier1At = 0;
        lastTier1ReclaimMb = 0;
        return;
      }

      if (mitigationInFlight) return;

      const now = Date.now();
      const shouldRunTier1 = lastTier1At === 0 || now - lastTier1At >= TIER1_MITIGATION_COOLDOWN_MS;
      const shouldCheckTier2 =
        consecutivePressureCount >= PRESSURE_COUNT_TIER2 &&
        now - lastTier2At >= MITIGATION_COOLDOWN_MS;
      if (!shouldRunTier1 && !shouldCheckTier2) return;

      mitigationInFlight = true;
      void (async () => {
        try {
          // Force-refresh (never read stale): these samples bracket a reclaim
          // delta — a TTL-stale read would zero the delta and change tier-2
          // escalation behavior.
          const sumMonitoredMb = (): number => {
            let total = 0;
            for (const proc of refreshAppMetricsSnapshot()) {
              if (!MONITORED_TYPES.has(proc.type)) continue;
              total += getProcessMemoryMb(proc);
            }
            return total;
          };

          const measurePressure = (): {
            totalMb: number;
            pressureRemains: boolean;
            systemPressureRemains: boolean;
          } => {
            let totalMb = 0;
            let remains = false;
            let systemRemains = false;
            for (const proc of refreshAppMetricsSnapshot()) {
              if (!MONITORED_TYPES.has(proc.type)) continue;
              const mb = getProcessMemoryMb(proc);
              totalMb += mb;
              const threshold = warnThresholdsMb[proc.type];
              if (threshold !== undefined && mb > threshold) {
                remains = true;
              }
            }
            // Aggregate fan-out can hold the combined footprint above the safe
            // ceiling even when no single process trips its per-type threshold.
            // Mirror the main poll's aggregate gate here so aggregate-driven
            // pressure can still escalate to tier 2 when tier 1 under-reclaims —
            // without this, aggregate-only pressure triggers tier 1 forever but
            // can never reach tier 2.
            if (totalMb > aggregateWarnThresholdMb) {
              remains = true;
            }
            const availableMb = readAvailableSystemMemoryMb();
            if (availableMb !== null && availableMb < systemLowMemoryThresholdMb) {
              remains = true;
              systemRemains = true;
            }
            return { totalMb, pressureRemains: remains, systemPressureRemains: systemRemains };
          };

          let beforeMb = 0;
          try {
            beforeMb = sumMonitoredMb();
          } catch {
            // If pre-sample fails, beforeMb stays 0; delta will be 0 and we'll
            // err on the side of escalating if pressure persists.
          }

          let tier1TabsEvicted = 0;
          if (shouldRunTier1) {
            lastTier1At = Date.now();
            logInfo("memory-pressure-tier1-mitigation", {
              pollCount,
              consecutivePressureCount,
              beforeMb: Math.round(beforeMb),
            });

            tier1TabsEvicted = await actions.destroyHiddenWebviews(1);

            try {
              actions.trimPtyHostState?.();
            } catch {
              /* non-critical */
            }

            await new Promise<void>((resolve) => setTimeout(resolve, RECLAIM_SETTLE_MS));
          }

          let afterMb = 0;
          let pressureRemains = false;
          let systemPressureRemains = false;
          let resampleFailed = false;
          try {
            const measured = measurePressure();
            afterMb = measured.totalMb;
            pressureRemains = measured.pressureRemains;
            systemPressureRemains = measured.systemPressureRemains;
          } catch {
            // Re-sample failed — assume pressure persists and treat reclaim
            // as zero so the gate falls through to escalation. Without
            // forcing afterMb=beforeMb here, deltaMb would equal the full
            // beforeMb, satisfying `deltaMb >= MIN_RECLAIMED_MB` and
            // *suppressing* escalation, which is the opposite of the
            // safe-side intent.
            pressureRemains = true;
            systemPressureRemains = systemPressureActive;
            resampleFailed = true;
            afterMb = beforeMb;
          }

          const deltaMb = resampleFailed ? 0 : Math.max(0, beforeMb - afterMb);
          if (shouldRunTier1) {
            lastTier1ReclaimMb = deltaMb;
            logInfo("memory-pressure-tier1-reclaim", {
              beforeMb: Math.round(beforeMb),
              afterMb: Math.round(afterMb),
              deltaMb: Math.round(deltaMb),
              // A zero delta with zero evictions means tier 1 had nothing to
              // reclaim — not that reclaim failed. Without this the two are
              // indistinguishable in the logs.
              tabsEvicted: tier1TabsEvicted,
              pressureRemains,
              resampleFailed,
            });
          }

          if (
            shouldCheckTier2 &&
            pressureRemains &&
            (systemPressureRemains || lastTier1ReclaimMb < MIN_RECLAIMED_MB) &&
            Date.now() - lastTier2At >= MITIGATION_COOLDOWN_MS
          ) {
            // Stamp the cooldown BEFORE the tier-2 actions so a thrown
            // hibernateIdleProjects (after destroyHiddenWebviews succeeded)
            // doesn't leave the cooldown unconsumed and let the next poll
            // re-fire destroyHiddenWebviews(2).
            lastTier2At = Date.now();
            // The escalation inputs, not a reclaim delta: on the common path
            // tier 1 ran polls earlier and its cooldown blocks a re-run, so
            // nothing has acted between `beforeMb` and `afterMb` here. This
            // line previously logged that no-action delta as `deltaMb`, which
            // is ~0 by construction and read as "tier 2 reclaimed nothing".
            logInfo("memory-pressure-tier2-mitigation", {
              pollCount,
              consecutivePressureCount,
              tier1ReclaimMb: Math.round(lastTier1ReclaimMb),
              systemPressureRemains,
            });

            // `afterMb` is this tier's baseline: sampled after tier 1 settled
            // (or with no action taken at all) and before any tier-2 action.
            const tier2BeforeMb = afterMb;

            // Each action is isolated: one throwing must neither skip the
            // levers after it nor blind the reclaim measurement below, which
            // is this tier's whole point. Previously a thrown
            // destroyHiddenWebviews(2) skipped both remaining levers.
            let tier2TabsEvicted = 0;
            try {
              tier2TabsEvicted = await actions.destroyHiddenWebviews(2);
            } catch (err) {
              logWarn("memory-pressure-tier2-action-failed", {
                action: "destroyHiddenWebviews",
                error: String(err),
              });
            }
            let tier2ViewsEvicted = 0;
            try {
              tier2ViewsEvicted = (await actions.evictCachedProjectViews?.()) ?? 0;
            } catch (err) {
              logWarn("memory-pressure-tier2-action-failed", {
                action: "evictCachedProjectViews",
                error: String(err),
              });
            }
            try {
              await actions.hibernateIdleProjects();
            } catch (err) {
              logWarn("memory-pressure-tier2-action-failed", {
                action: "hibernateIdleProjects",
                error: String(err),
              });
            }

            await new Promise<void>((resolve) => setTimeout(resolve, RECLAIM_SETTLE_MS));

            let tier2AfterMb = tier2BeforeMb;
            let tier2PressureRemains = true;
            let tier2ResampleFailed = false;
            try {
              const measured = measurePressure();
              tier2AfterMb = measured.totalMb;
              tier2PressureRemains = measured.pressureRemains;
            } catch {
              tier2ResampleFailed = true;
            }

            logInfo("memory-pressure-tier2-reclaim", {
              beforeMb: Math.round(tier2BeforeMb),
              afterMb: Math.round(tier2AfterMb),
              deltaMb: tier2ResampleFailed
                ? 0
                : Math.round(Math.max(0, tier2BeforeMb - tier2AfterMb)),
              tabsEvicted: tier2TabsEvicted,
              viewsEvicted: tier2ViewsEvicted,
              pressureRemains: tier2PressureRemains,
              resampleFailed: tier2ResampleFailed,
            });
          }
        } catch (err) {
          logWarn("memory-pressure-mitigation-failed", { error: String(err) });
        } finally {
          mitigationInFlight = false;
        }
      })();
    } catch (err) {
      logWarn("process-memory-poll-failed", { error: String(err) });
    }
  };

  appMetricsPollFn = poll;

  let clearAlignedInterval: (() => void) | null = null;
  const armTimer = () => {
    clearAlignedInterval?.();
    clearAlignedInterval = setAlignedInterval(poll, currentAppMetricsPollIntervalMs);
  };
  rearmAppMetricsTimer = armTimer;

  armTimer();

  try {
    removeSuspendListener = getSystemSleepService().onSuspend(() => {
      clearAlignedInterval?.();
      clearAlignedInterval = null;
      trendState.clear();
      thresholdExceededPids.clear();
      trendWarnedPids.clear();
      consecutivePressureCount = 0;
      lastTier1At = 0;
      lastTier1ReclaimMb = 0;
      lastTier2At = 0;
      mitigationInFlight = false;
    });
    removeWakeListener = getSystemSleepService().onWake(() => {
      if (clearAlignedInterval !== null) return;
      poll();
      armTimer();
    });
  } catch {
    // SystemSleepService may not be initialized yet at early startup.
  }

  return () => {
    clearAlignedInterval?.();
    clearAlignedInterval = null;
    appMetricsPollFn = null;
    rearmAppMetricsTimer = null;
    removeSuspendListener?.();
    removeWakeListener?.();
  };
}
