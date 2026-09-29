import {
  PLUGIN_PERF_BUDGETS,
  type PluginPerfBudgetKey,
} from "../../../shared/config/pluginBudgets.js";
import type {
  PluginDurationStats,
  PluginPerfSnapshot,
  PluginRendererMetricsReport,
  PluginViewLoadSample,
} from "../../../shared/types/pluginMetrics.js";
import { getAppMetricsSnapshot } from "../../utils/appMetricsSnapshot.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { PLUGIN_INVOKE_TIMEOUT } from "./pluginInvokeDeadline.js";
import { PLUGIN_PAYLOAD_TOO_LARGE } from "./pluginPayloadLimits.js";

/**
 * Per-plugin cost observations, accumulated in main from every source the host
 * can see: activation, invokes, pushes, worker memory and the renderer's view
 * reports. Measurements are shown beside {@link PLUGIN_PERF_BUDGETS}; nothing
 * here throttles, blocks or ranks a plugin.
 *
 * Every `record*` is O(1) (a renderer report is O(its bounded length)) and
 * allocation-light; percentiles, rates and budget checks are computed only when
 * a snapshot is read.
 */

/** Durations kept per stream for p50/p95. Older samples roll off. */
export const DURATION_WINDOW = 256;
/** View loads remembered per plugin. */
export const MAX_VIEW_LOADS = 20;
/** Plugins tracked at once; past this the least recently recorded is dropped. */
export const MAX_TRACKED_PLUGINS = 256;
const PUSH_BUCKET_MS = 1_000;
/** Sliding window the push rates cover: `PUSH_BUCKETS` one-second buckets. */
export const PUSH_BUCKETS = 10;
/** `onDidChange` fires at most once per this interval. */
export const CHANGE_COALESCE_MS = 1_000;
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
/** How long one CLI poll keeps worker memory sampling alive. */
export const SAMPLING_LEASE_MS = 15_000;

export type InvokeOutcome = "ok" | "error" | "timeout" | "oversized";

export interface PluginMetricsHost {
  /** Only plugins the host has loaded are recorded; anything else is dropped. */
  isKnownPlugin(pluginId: string): boolean;
  isolationOf(pluginId: string): PluginPerfSnapshot["isolation"];
  /**
   * Whether `generation` names the load currently live under `pluginId`: the
   * `plugin://` authority its views were served from. A renderer report tagged
   * with any other generation belongs to a load that has since been replaced.
   */
  isCurrentGeneration(pluginId: string, generation: string): boolean;
  /** Live worker processes, by plugin id. */
  workerPids(): Iterable<readonly [pluginId: string, pid: number]>;
}

export interface ProcessMemorySample {
  pid: number;
  rssBytes: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PluginMetricsServiceOptions {
  host?: PluginMetricsHost;
  now?: () => number;
  sampleProcessMemory?: () => readonly ProcessMemorySample[];
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

class DurationWindow {
  private readonly ring = new Float64Array(DURATION_WINDOW);
  private cursor = 0;
  private filled = 0;
  count = 0;
  maxMs = 0;
  lastMs = 0;

  record(ms: number): void {
    this.sample(ms);
    this.count++;
  }

  /** Add to the percentile window without counting; for sampled streams with their own count. */
  sample(ms: number): void {
    this.ring[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % DURATION_WINDOW;
    if (this.filled < DURATION_WINDOW) this.filled++;
    if (ms > this.maxMs) this.maxMs = ms;
    this.lastMs = ms;
  }

  stats(): PluginDurationStats | null {
    if (this.filled === 0) return null;
    const sorted = this.ring.slice(0, this.filled).sort();
    return {
      count: this.count,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: this.maxMs,
      lastMs: this.lastMs,
    };
  }
}

function percentile(sorted: Float64Array, p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/** Messages and bytes in one-second buckets over a sliding window. */
class RateWindow {
  private readonly messages = new Float64Array(PUSH_BUCKETS);
  private readonly bytes = new Float64Array(PUSH_BUCKETS);
  /** Absolute bucket index (`floor(now / PUSH_BUCKET_MS)`) of the newest bucket. */
  private head = -1;
  firstAt: number | null = null;
  private lastAt = 0;

  record(now: number, messages: number, bytes: number): void {
    // After a full idle window the old span means nothing: a fresh burst is
    // divided by its own duration, not by the silence before it.
    if (this.firstAt !== null && now - this.lastAt >= PUSH_BUCKETS * PUSH_BUCKET_MS) {
      this.firstAt = null;
    }
    this.lastAt = now;
    this.advance(now);
    const slot = this.head % PUSH_BUCKETS;
    this.messages[slot] = this.messages[slot]! + messages;
    this.bytes[slot] = this.bytes[slot]! + bytes;
    this.firstAt ??= now;
  }

  rates(now: number): { perSecond: number; bytesPerSecond: number } {
    if (this.firstAt === null) return { perSecond: 0, bytesPerSecond: 0 };
    this.advance(now);
    let messages = 0;
    let bytes = 0;
    for (let i = 0; i < PUSH_BUCKETS; i++) {
      messages += this.messages[i]!;
      bytes += this.bytes[i]!;
    }
    // A plugin that started pushing three seconds ago is divided by three, not
    // by the full window, so a fresh burst is not understated.
    const spanMs = Math.min(
      PUSH_BUCKETS * PUSH_BUCKET_MS,
      Math.max(PUSH_BUCKET_MS, now - this.firstAt)
    );
    const seconds = spanMs / 1_000;
    return { perSecond: messages / seconds, bytesPerSecond: bytes / seconds };
  }

  private advance(now: number): void {
    const index = Math.floor(now / PUSH_BUCKET_MS);
    if (this.head === -1) {
      this.head = index;
      return;
    }
    if (index <= this.head) return;
    const steps = Math.min(PUSH_BUCKETS, index - this.head);
    for (let i = 1; i <= steps; i++) {
      const slot = (this.head + i) % PUSH_BUCKETS;
      this.messages[slot] = 0;
      this.bytes[slot] = 0;
    }
    this.head = index;
  }
}

interface Entry {
  since: number;
  activation: PluginPerfSnapshot["activation"];
  invokes: DurationWindow;
  invokeErrors: number;
  invokeTimeouts: number;
  invokeOversized: number;
  pushMessages: number;
  pushBytes: number;
  pushOversized: number;
  pushRate: RateWindow;
  viewLoads: PluginViewLoadSample[];
  commits: DurationWindow;
  longFrameCount: number;
  longFrameBlockingMs: number;
  longFrameLastAt: number | null;
  workerMemory: PluginPerfSnapshot["workerMemory"];
}

function createEntry(since: number): Entry {
  return {
    since,
    activation: null,
    invokes: new DurationWindow(),
    invokeErrors: 0,
    invokeTimeouts: 0,
    invokeOversized: 0,
    pushMessages: 0,
    pushBytes: 0,
    pushOversized: 0,
    pushRate: new RateWindow(),
    viewLoads: [],
    commits: new DurationWindow(),
    longFrameCount: 0,
    longFrameBlockingMs: 0,
    longFrameLastAt: null,
    workerMemory: null,
  };
}

/**
 * Open → view imported and styles prepared, rebuilt from the sample's phases.
 * Activation runs first; the import and the style preparation then overlap, so
 * the longer of the two is what the view waited on.
 */
export function viewLoadMsOf(sample: PluginViewLoadSample): number {
  return sample.activateMs + Math.max(sample.importMs, sample.stylesMs);
}

/** The measurement each budget is compared against, or undefined when none exists yet. */
export function measurementsOf(
  snapshot: Omit<PluginPerfSnapshot, "overBudget">
): Partial<Record<PluginPerfBudgetKey, number>> {
  const latestLoad = snapshot.viewLoads[snapshot.viewLoads.length - 1];
  const out: Partial<Record<PluginPerfBudgetKey, number>> = {};
  if (snapshot.activation) out.activationMs = snapshot.activation.lastMs;
  if (latestLoad) {
    out.viewLoadMs = viewLoadMsOf(latestLoad);
    out.viewFirstPaintMs = latestLoad.firstPaintMs;
  }
  if (snapshot.viewCommits) out.viewCommitP95Ms = snapshot.viewCommits.p95Ms;
  if (snapshot.invokes.count > 0) out.invokeP95Ms = snapshot.invokes.p95Ms;
  if (snapshot.pushes.messages > 0) {
    out.pushesPerSecond = snapshot.pushes.perSecond;
    out.pushBytesPerSecond = snapshot.pushes.bytesPerSecond;
  }
  if (snapshot.workerMemory) out.workerRssBytes = snapshot.workerMemory.rssBytes;
  return out;
}

const BUDGET_KEYS = Object.keys(PLUGIN_PERF_BUDGETS) as PluginPerfBudgetKey[];

function defaultSampleProcessMemory(): ProcessMemorySample[] {
  // `workingSetSize` is in kilobytes; it is the resident set on every platform.
  return getAppMetricsSnapshot().map((metric) => ({
    pid: metric.pid,
    rssBytes: (metric.memory?.workingSetSize ?? 0) * 1024,
  }));
}

export class PluginMetricsService {
  private readonly entries = new Map<string, Entry>();
  private host: PluginMetricsHost | null;
  private readonly now: () => number;
  private readonly sampleProcessMemory: () => readonly ProcessMemorySample[];
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  private readonly listeners = new Set<(pluginIds: string[]) => void>();
  private readonly changed = new Set<string>();
  private changeTimer: TimerHandle | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;

  private samplingHolds = 0;
  private samplingLeaseUntil = 0;
  private samplingTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: PluginMetricsServiceOptions = {}) {
    this.host = options.host ?? null;
    this.now = options.now ?? (() => Date.now());
    this.sampleProcessMemory = options.sampleProcessMemory ?? defaultSampleProcessMemory;
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  }

  attachHost(host: PluginMetricsHost): void {
    this.host = host;
  }

  recordActivation(pluginId: string, durationMs: number): void {
    const entry = this.entryFor(pluginId);
    if (!entry) return;
    entry.activation = {
      lastMs: durationMs,
      count: (entry.activation?.count ?? 0) + 1,
      at: this.now(),
    };
    this.markChanged(pluginId);
  }

  /**
   * One invoke round trip. `errors` counts every failure; timeouts and oversize
   * payloads are also counted on their own, as subsets of it.
   */
  recordInvoke(pluginId: string, durationMs: number, outcome: InvokeOutcome): void {
    const entry = this.entryFor(pluginId);
    if (!entry) return;
    entry.invokes.record(durationMs);
    if (outcome !== "ok") entry.invokeErrors++;
    if (outcome === "timeout") entry.invokeTimeouts++;
    else if (outcome === "oversized") entry.invokeOversized++;
    this.markChanged(pluginId);
  }

  /** One push-batcher flush: `messages` deliveries totalling `bytes`. */
  recordPushes(pluginId: string, messages: number, bytes: number): void {
    const entry = this.entryFor(pluginId);
    if (!entry) return;
    entry.pushMessages += messages;
    entry.pushBytes += bytes;
    entry.pushRate.record(this.now(), messages, bytes);
    this.markChanged(pluginId);
  }

  recordPushOversized(pluginId: string): void {
    const entry = this.entryFor(pluginId);
    if (!entry) return;
    entry.pushOversized++;
    this.markChanged(pluginId);
  }

  /**
   * A renderer's report, already validated and clamped at the IPC boundary.
   * Dropped unless `generation` is the plugin's live load: the renderer
   * buffers for seconds, so a fast unload and reload would otherwise land the
   * old load's views in the new load's freshly evicted numbers.
   */
  recordRendererReport(report: PluginRendererMetricsReport, generation: string): boolean {
    if (this.disposed || !this.host?.isCurrentGeneration(report.pluginId, generation)) return false;
    const entry = this.entryFor(report.pluginId);
    if (!entry) return false;
    for (const load of report.viewLoads) {
      entry.viewLoads.push(load);
    }
    if (entry.viewLoads.length > MAX_VIEW_LOADS) {
      entry.viewLoads.splice(0, entry.viewLoads.length - MAX_VIEW_LOADS);
    }
    for (const ms of report.commitDurationsMs) entry.commits.sample(ms);
    entry.commits.count += Math.max(report.commitCount, report.commitDurationsMs.length);
    for (const frame of report.longFrames) {
      entry.longFrameCount++;
      entry.longFrameBlockingMs += frame.blockingMs;
      if (entry.longFrameLastAt === null || frame.at > entry.longFrameLastAt) {
        entry.longFrameLastAt = frame.at;
      }
    }
    entry.longFrameCount += report.longFramesDropped.count;
    entry.longFrameBlockingMs += report.longFramesDropped.blockingMs;
    this.markChanged(report.pluginId);
    return true;
  }

  /** Forget a plugin, e.g. on unload; a reload starts from fresh numbers. */
  evict(pluginId: string): void {
    if (!this.entries.delete(pluginId)) return;
    this.changed.delete(pluginId);
    if (this.listeners.size > 0) {
      this.changed.add(pluginId);
      this.scheduleEmit();
    }
  }

  getSnapshot(pluginId: string): PluginPerfSnapshot | null {
    const entry = this.entries.get(pluginId);
    if (entry) return this.snapshotOf(pluginId, entry);
    // A loaded plugin with nothing recorded yet reads as empty rather than absent.
    if (!this.host?.isKnownPlugin(pluginId)) return null;
    return this.snapshotOf(pluginId, createEntry(this.now()));
  }

  getAll(): PluginPerfSnapshot[] {
    const out: PluginPerfSnapshot[] = [];
    for (const [pluginId, entry] of this.entries) out.push(this.snapshotOf(pluginId, entry));
    return out;
  }

  /**
   * Coalesced change notifications: at most one call per
   * {@link CHANGE_COALESCE_MS}, carrying every plugin id that changed (or was
   * evicted) since the last one. Nothing is scheduled while no one listens.
   */
  onDidChange(listener: (pluginIds: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.changed.clear();
        if (this.changeTimer !== null) {
          this.clearTimer(this.changeTimer);
          this.changeTimer = null;
        }
      }
    };
  }

  /** Keep worker memory sampled while the returned release has not been called. */
  acquireSampling(): () => void {
    this.samplingHolds++;
    this.ensureSampling();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.samplingHolds--;
    };
  }

  /** Keep worker memory sampled for `ms` more; each poll from a CLI renews it. */
  leaseSampling(ms: number = SAMPLING_LEASE_MS): void {
    this.samplingLeaseUntil = Math.max(this.samplingLeaseUntil, this.now() + ms);
    this.ensureSampling();
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeTimer !== null) this.clearTimer(this.changeTimer);
    if (this.samplingTimer !== null) this.clearTimer(this.samplingTimer);
    this.changeTimer = null;
    this.samplingTimer = null;
    this.listeners.clear();
    this.changed.clear();
    this.entries.clear();
  }

  private entryFor(pluginId: string): Entry | null {
    if (this.disposed) return null;
    const existing = this.entries.get(pluginId);
    if (existing) return existing;
    if (!this.host?.isKnownPlugin(pluginId)) return null;
    if (this.entries.size >= MAX_TRACKED_PLUGINS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry = createEntry(this.now());
    this.entries.set(pluginId, entry);
    return entry;
  }

  private snapshotOf(pluginId: string, entry: Entry): PluginPerfSnapshot {
    const invokeStats = entry.invokes.stats();
    const rates = entry.pushRate.rates(this.now());
    const base: Omit<PluginPerfSnapshot, "overBudget"> = {
      pluginId,
      isolation: this.host?.isolationOf(pluginId) ?? "worker",
      activation: entry.activation ? { ...entry.activation } : null,
      viewLoads: entry.viewLoads.map((load) => ({ ...load })),
      viewCommits: entry.commits.stats(),
      invokes: {
        ...(invokeStats ?? { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, lastMs: 0 }),
        errors: entry.invokeErrors,
        timeouts: entry.invokeTimeouts,
        oversized: entry.invokeOversized,
      },
      pushes: {
        messages: entry.pushMessages,
        bytes: entry.pushBytes,
        perSecond: rates.perSecond,
        bytesPerSecond: rates.bytesPerSecond,
        oversized: entry.pushOversized,
      },
      longFrames: {
        count: entry.longFrameCount,
        totalBlockingMs: entry.longFrameBlockingMs,
        lastAt: entry.longFrameLastAt,
      },
      workerMemory: entry.workerMemory ? { ...entry.workerMemory } : null,
      since: entry.since,
    };
    const measured = measurementsOf(base);
    const overBudget = BUDGET_KEYS.filter((key) => {
      const value = measured[key];
      return value !== undefined && value > PLUGIN_PERF_BUDGETS[key];
    });
    return { ...base, overBudget };
  }

  private markChanged(pluginId: string): void {
    if (this.listeners.size === 0) return;
    this.changed.add(pluginId);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.changeTimer !== null || this.disposed) return;
    const delay = Math.max(0, this.lastEmitAt + CHANGE_COALESCE_MS - this.now());
    this.changeTimer = this.setTimer(() => this.emitChanges(), delay);
    unrefTimer(this.changeTimer);
  }

  private emitChanges(): void {
    this.changeTimer = null;
    if (this.changed.size === 0 || this.listeners.size === 0) return;
    const ids = [...this.changed];
    this.changed.clear();
    const now = this.now();
    this.lastEmitAt = now;
    for (const listener of [...this.listeners]) {
      try {
        listener(ids);
      } catch {
        // One broken listener must not starve the others.
      }
    }
    // A push rate decays without any new record, so keep re-announcing a
    // plugin until its window has drained, or listeners would hold a stale rate.
    for (const [pluginId, entry] of this.entries) {
      if (entry.pushRate.rates(now).perSecond > 0) this.changed.add(pluginId);
    }
    if (this.changed.size > 0) this.scheduleEmit();
  }

  private samplingWanted(): boolean {
    return this.samplingHolds > 0 || this.samplingLeaseUntil > this.now();
  }

  private ensureSampling(): void {
    if (this.samplingTimer !== null || this.disposed) return;
    this.sampleWorkerMemory();
    this.scheduleSample();
  }

  private scheduleSample(): void {
    this.samplingTimer = this.setTimer(() => {
      this.samplingTimer = null;
      if (this.disposed || !this.samplingWanted()) return;
      this.sampleWorkerMemory();
      this.scheduleSample();
    }, MEMORY_SAMPLE_INTERVAL_MS);
    unrefTimer(this.samplingTimer);
  }

  private sampleWorkerMemory(): void {
    const host = this.host;
    if (!host) return;
    const pidToPlugin = new Map<number, string>();
    try {
      for (const [pluginId, pid] of host.workerPids()) pidToPlugin.set(pid, pluginId);
    } catch {
      return;
    }
    const seen = new Set<string>();
    // Skip the process-table sweep entirely when no worker is running.
    if (pidToPlugin.size > 0) {
      let samples: readonly ProcessMemorySample[];
      try {
        samples = this.sampleProcessMemory();
      } catch {
        return;
      }
      const at = this.now();
      for (const sample of samples) {
        const pluginId = pidToPlugin.get(sample.pid);
        if (pluginId === undefined || !(sample.rssBytes > 0)) continue;
        const entry = this.entryFor(pluginId);
        if (!entry) continue;
        seen.add(pluginId);
        entry.workerMemory = { rssBytes: sample.rssBytes, at };
        this.markChanged(pluginId);
      }
    }
    // A worker that has exited (or was idle-disposed) has no memory to report.
    for (const [pluginId, entry] of this.entries) {
      if (entry.workerMemory && !seen.has(pluginId)) {
        entry.workerMemory = null;
        this.markChanged(pluginId);
      }
    }
  }
}

function unrefTimer(handle: TimerHandle): void {
  (handle as { unref?: () => void }).unref?.();
}

/** Classify a failed invoke by the prefixed codes the transport throws with. */
export function classifyInvokeFailure(error: unknown): Exclude<InvokeOutcome, "ok"> {
  const code = (error as { code?: unknown } | null)?.code;
  const message = formatErrorMessage(error, "");
  if (code === PLUGIN_INVOKE_TIMEOUT || message.startsWith(`${PLUGIN_INVOKE_TIMEOUT}:`)) {
    return "timeout";
  }
  if (code === PLUGIN_PAYLOAD_TOO_LARGE || message.startsWith(`${PLUGIN_PAYLOAD_TOO_LARGE}:`)) {
    return "oversized";
  }
  return "error";
}
