import { create } from "zustand";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type PerfMode = "smoke" | "ci" | "nightly" | "soak";

const PERF_MODES: readonly PerfMode[] = ["smoke", "ci", "nightly", "soak"];

export interface PerfSummaryRow {
  scenarioId: string;
  name: string;
  mode: PerfMode;
  p95Ms: number;
  outsideReference: boolean;
  referenceNotes?: string;
  generatedAt: string;
}

interface ScenarioAggregateJson {
  id: string;
  name: string;
  p95Ms: number;
  outsideReference: boolean;
  referenceNotes?: string;
}

interface PerfRunSummaryJson {
  generatedAt: string;
  mode: PerfMode;
  aggregates: ScenarioAggregateJson[];
}

interface PerfMetricsState {
  fps: number | null;
  lafCount30s: number;
  cls30s: number;
  isBackgrounded: boolean;
  summaryRows: PerfSummaryRow[];
  outsideReferenceCount: number;
  isLoadingSummaries: boolean;
  summaryLoadError: string | null;
  lastLoadedAt: number | null;
  setLiveMetrics: (next: { fps: number | null; lafCount30s: number; cls30s: number }) => void;
  setBackgrounded: (backgrounded: boolean) => void;
  refreshSummaries: (projectRoot: string) => Promise<void>;
  clearSummaries: () => void;
}

// Module-scope counters keep rAF state out of React closures (#5087).
let frameCount = 0;
let lastBucketTime = 0;
let rafHandle: number | null = null;
let lafObserver: PerformanceObserver | null = null;
let clsObserver: PerformanceObserver | null = null;
const lafTimestamps: number[] = [];
const clsEntries: Array<{ startTime: number; value: number }> = [];
let captureRefCount = 0;
let visibilityHandler: (() => void) | null = null;
let refreshRequestId = 0;

const WINDOW_MS = 30_000;
const FPS_BUCKET_MS = 1_000;

function pruneOldEntries(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (lafTimestamps.length > 0 && lafTimestamps[0]! < cutoff) {
    lafTimestamps.shift();
  }
  while (clsEntries.length > 0 && clsEntries[0]!.startTime < cutoff) {
    clsEntries.shift();
  }
}

function computeCls30s(): number {
  let sum = 0;
  for (const entry of clsEntries) sum += entry.value;
  return sum;
}

function publishMetrics(fps: number | null): void {
  const now = performance.now();
  pruneOldEntries(now);
  usePerfMetricsStore.getState().setLiveMetrics({
    fps,
    lafCount30s: lafTimestamps.length,
    cls30s: Number(computeCls30s().toFixed(4)),
  });
}

function tick(): void {
  frameCount += 1;
  const now = performance.now();
  const elapsed = now - lastBucketTime;
  if (elapsed >= FPS_BUCKET_MS) {
    const fps =
      document.visibilityState === "hidden" ? null : Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastBucketTime = now;
    publishMetrics(fps);
  }
  rafHandle = requestAnimationFrame(tick);
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

function isLayoutShiftEntry(entry: PerformanceEntry): entry is LayoutShiftEntry {
  return (
    "value" in entry &&
    typeof (entry as { value: unknown }).value === "number" &&
    "hadRecentInput" in entry &&
    typeof (entry as { hadRecentInput: unknown }).hadRecentInput === "boolean"
  );
}

function startObservers(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    lafObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lafTimestamps.push(entry.startTime);
      }
    });
    lafObserver.observe({ type: "long-animation-frame", durationThreshold: 50 });
  } catch {
    lafObserver?.disconnect();
    lafObserver = null;
  }

  try {
    clsObserver = new PerformanceObserver((list) => {
      const now = performance.now();
      const cutoff = now - WINDOW_MS;
      for (const entry of list.getEntries()) {
        if (!isLayoutShiftEntry(entry)) continue;
        if (entry.hadRecentInput) continue;
        if (entry.startTime < cutoff) continue;
        clsEntries.push({ startTime: entry.startTime, value: entry.value });
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  } catch {
    clsObserver?.disconnect();
    clsObserver = null;
  }
}

function stopObservers(): void {
  lafObserver?.disconnect();
  clsObserver?.disconnect();
  lafObserver = null;
  clsObserver = null;
  lafTimestamps.length = 0;
  clsEntries.length = 0;
}

function handleVisibilityChange(): void {
  const hidden = document.visibilityState === "hidden";
  usePerfMetricsStore.getState().setBackgrounded(hidden);
  if (hidden) {
    publishMetrics(null);
  }
}

// Lazy ref-counted lifecycle so the rAF loop only runs while the Perf tab is
// mounted. Idempotent under React 19 StrictMode double-invoke.
export function startLivePerfCapture(): void {
  if (typeof window === "undefined") return;
  captureRefCount += 1;
  if (captureRefCount > 1) return;

  frameCount = 0;
  lastBucketTime = performance.now();
  startObservers();

  visibilityHandler = handleVisibilityChange;
  document.addEventListener("visibilitychange", visibilityHandler);
  usePerfMetricsStore.getState().setBackgrounded(document.visibilityState === "hidden");

  rafHandle = requestAnimationFrame(tick);
}

export function stopLivePerfCapture(): void {
  if (captureRefCount === 0) return;
  captureRefCount -= 1;
  if (captureRefCount > 0) return;

  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  stopObservers();
  usePerfMetricsStore.getState().setLiveMetrics({
    fps: null,
    lafCount30s: 0,
    cls30s: 0,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPerfMode(value: unknown): value is PerfMode {
  return value === "smoke" || value === "ci" || value === "nightly" || value === "soak";
}

/**
 * Validate and normalise one aggregate in a single pass.
 *
 * Summary files written before the harness stopped gating carry `failedBudget` /
 * `budgetReason`. They live in `.tmp/perf-results`, which survives a branch
 * switch, so a stale file would otherwise fail validation and blank the Perf tab
 * with no explanation. Both spellings are read; only the new one is written.
 *
 * Validation and normalisation are one function rather than a type guard plus
 * casts: a guard asserting `is ScenarioAggregateJson` over an object that only
 * carries the legacy key would be lying, and the casts needed to paper over that
 * are exactly what the `no-unsafe-type-assertion` rule is for.
 */
function normalizeAggregate(value: unknown): ScenarioAggregateJson | null {
  if (!isRecord(value)) return null;
  const { id, name, p95Ms } = value;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof p95Ms !== "number" || !Number.isFinite(p95Ms)) return null;

  // A file carrying BOTH spellings is ambiguous, not merely redundant — it means
  // two writers disagreed. Reject rather than silently picking a winner.
  const hasNew = value.outsideReference !== undefined;
  const hasLegacy = value.failedBudget !== undefined;
  if (hasNew && hasLegacy) return null;
  const outsideReference = hasNew ? value.outsideReference : value.failedBudget;
  if (typeof outsideReference !== "boolean") return null;

  const hasNewNotes = value.referenceNotes !== undefined;
  const hasLegacyNotes = value.budgetReason !== undefined;
  if (hasNewNotes && hasLegacyNotes) return null;
  const referenceNotes = hasNewNotes ? value.referenceNotes : value.budgetReason;
  if (referenceNotes !== undefined && typeof referenceNotes !== "string") return null;

  return { id, name, p95Ms, outsideReference, referenceNotes };
}

function parseSummary(value: unknown): PerfRunSummaryJson | null {
  if (!isRecord(value)) return null;
  const { generatedAt, mode, aggregates } = value;
  if (typeof generatedAt !== "string") return null;
  if (!isPerfMode(mode)) return null;
  if (!Array.isArray(aggregates)) return null;
  const validated: ScenarioAggregateJson[] = [];
  for (const candidate of aggregates) {
    const normalized = normalizeAggregate(candidate);
    if (normalized === null) return null;
    validated.push(normalized);
  }
  return { generatedAt, mode, aggregates: validated };
}

async function readModeSummary(
  mode: PerfMode,
  projectRoot: string
): Promise<PerfRunSummaryJson | null> {
  const path = `${projectRoot}/.tmp/perf-results/latest-${mode}.summary.json`;
  try {
    const { content } = await filesClient.read({ path, rootPath: projectRoot });
    const parsed = parseSummary(JSON.parse(content));
    return parsed;
  } catch (error) {
    if (isClientAppError(error) && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

// Use the requested `mode` (from filename) rather than `summary.mode` from
// file content so a misplaced summary file can't cause duplicate React keys
// or mislabel rows. The filename is the authoritative bucket.
function toRows(summary: PerfRunSummaryJson, mode: PerfMode): PerfSummaryRow[] {
  return summary.aggregates.map((agg) => ({
    scenarioId: agg.id,
    name: agg.name,
    mode,
    p95Ms: agg.p95Ms,
    outsideReference: agg.outsideReference,
    referenceNotes: agg.referenceNotes,
    generatedAt: summary.generatedAt,
  }));
}

export const usePerfMetricsStore = create<PerfMetricsState>((set) => ({
  fps: null,
  lafCount30s: 0,
  cls30s: 0,
  isBackgrounded: false,
  summaryRows: [],
  outsideReferenceCount: 0,
  isLoadingSummaries: false,
  summaryLoadError: null,
  lastLoadedAt: null,

  setLiveMetrics: ({ fps, lafCount30s, cls30s }) => set({ fps, lafCount30s, cls30s }),

  setBackgrounded: (backgrounded) => set({ isBackgrounded: backgrounded }),

  refreshSummaries: async (projectRoot) => {
    if (!projectRoot) {
      set({
        summaryRows: [],
        outsideReferenceCount: 0,
        isLoadingSummaries: false,
        summaryLoadError: null,
        lastLoadedAt: Date.now(),
      });
      return;
    }
    const requestId = ++refreshRequestId;
    set({ isLoadingSummaries: true, summaryLoadError: null });
    try {
      const results = await Promise.all(
        PERF_MODES.map(async (mode) => {
          const summary = await readModeSummary(mode, projectRoot);
          return summary ? { summary, mode } : null;
        })
      );
      if (requestId !== refreshRequestId) return;

      const rows: PerfSummaryRow[] = [];
      for (const result of results) {
        if (result) rows.push(...toRows(result.summary, result.mode));
      }
      const outsideReferenceCount = rows.reduce((n, r) => n + (r.outsideReference ? 1 : 0), 0);
      set({
        summaryRows: rows,
        outsideReferenceCount,
        isLoadingSummaries: false,
        summaryLoadError: null,
        lastLoadedAt: Date.now(),
      });
    } catch (error) {
      if (requestId !== refreshRequestId) return;
      logError("Failed to read perf summary files", error);
      set({
        isLoadingSummaries: false,
        summaryLoadError: formatErrorMessage(error, "Failed to read perf results"),
        lastLoadedAt: Date.now(),
      });
    }
  },

  clearSummaries: () => {
    // Invalidate any in-flight refresh so its result can't overwrite the
    // cleared state, and unstick the loading flag if a refresh is in progress.
    refreshRequestId++;
    set({
      summaryRows: [],
      outsideReferenceCount: 0,
      summaryLoadError: null,
      isLoadingSummaries: false,
      lastLoadedAt: null,
    });
  },
}));

// Test-only reset that drains module-scope state and the rAF loop.
export function resetPerfMetricsForTests(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  stopObservers();
  frameCount = 0;
  lastBucketTime = 0;
  captureRefCount = 0;
  refreshRequestId = 0;
  usePerfMetricsStore.setState({
    fps: null,
    lafCount30s: 0,
    cls30s: 0,
    isBackgrounded: false,
    summaryRows: [],
    outsideReferenceCount: 0,
    isLoadingSummaries: false,
    summaryLoadError: null,
    lastLoadedAt: null,
  });
}
