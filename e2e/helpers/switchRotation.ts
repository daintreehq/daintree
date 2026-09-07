/**
 * Pure analysis for the project-switch rotation benchmark
 * (`e2e/full/resilience/project-switch-rotation-perf.spec.ts`).
 *
 * Nothing here touches Playwright or Electron: the spec feeds it the NDJSON
 * perf-mark file and gets back per-sample timings and aggregates, so the
 * joining rules that decide what a number means are unit-tested rather than
 * buried in a 30-minute E2E run.
 */

export type CacheClass = "warm" | "cold";
export type EntryPoint = "mru" | "palette-keyboard" | "palette-mouse" | "toolbar";

export interface MarkRecord {
  mark: string;
  timestamp: number;
  elapsedMs: number;
  meta?: Record<string, unknown> | null;
}

export interface SwitchTraceStep {
  index: number;
  depth: number;
  fromProjectId: string;
  targetProjectId: string;
  expectedCache: CacheClass;
  entryPoint: EntryPoint;
}

export interface StackDistanceTraceOptions {
  projectIds: readonly string[];
  samplesPerDepth: number;
  /** Cached-view limit the app runs with; depth `cap - 1` is the deepest warm target. */
  cap: number;
  maxDepth?: number;
  seed?: number;
  /** Entry point for a base sample at a given depth. Depth 1 is the MRU toggle by default. */
  entryPointForDepth?: (depth: number) => EntryPoint;
  /** Extra strata appended after the shuffled base samples, continuing the same MRU stack. */
  extraSteps?: ReadonlyArray<{ depth: number; entryPoint: EntryPoint }>;
}

/** Deterministic 32-bit PRNG so a trace can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function expectedCacheForDepth(depth: number, cap: number): CacheClass {
  return depth <= cap - 1 ? "warm" : "cold";
}

/**
 * Simulate an MRU stack (head = current project) and emit switches at the
 * requested stack distances. Choosing depth `d` moves `stack[d]` to the head,
 * which is exactly what the LRU view cache does, so `expectedCache` is a
 * prediction the spec can hold the app to.
 */
export function generateStackDistanceTrace(options: StackDistanceTraceOptions): SwitchTraceStep[] {
  const {
    projectIds,
    samplesPerDepth,
    cap,
    maxDepth = 4,
    seed = 1,
    entryPointForDepth = (depth) => (depth === 1 ? "mru" : "palette-keyboard"),
    extraSteps = [],
  } = options;
  if (projectIds.length < maxDepth + 1) {
    throw new Error(
      `need at least ${maxDepth + 1} projects for depth ${maxDepth}, got ${projectIds.length}`
    );
  }
  if (!Number.isInteger(samplesPerDepth) || samplesPerDepth < 0) {
    throw new Error(`samplesPerDepth must be a non-negative integer, got ${samplesPerDepth}`);
  }

  const plan: Array<{ depth: number; entryPoint: EntryPoint }> = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    for (let i = 0; i < samplesPerDepth; i++) {
      plan.push({ depth, entryPoint: entryPointForDepth(depth) });
    }
  }
  const rand = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = plan[i]!;
    plan[i] = plan[j]!;
    plan[j] = tmp;
  }
  for (const step of extraSteps) {
    if (step.depth < 1 || step.depth > projectIds.length - 1) {
      throw new Error(`extra step depth ${step.depth} is outside 1..${projectIds.length - 1}`);
    }
    plan.push({ depth: step.depth, entryPoint: step.entryPoint });
  }

  const stack = [...projectIds];
  return plan.map((step, index) => {
    const fromProjectId = stack[0]!;
    const [targetProjectId] = stack.splice(step.depth, 1) as [string];
    stack.unshift(targetProjectId);
    return {
      index,
      depth: step.depth,
      fromProjectId,
      targetProjectId,
      expectedCache: expectedCacheForDepth(step.depth, cap),
      entryPoint: step.entryPoint,
    };
  });
}

/** Nearest-rank percentile; `p` in 0..100. Returns NaN for an empty input. */
export function pct(values: readonly number[], p: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NaN;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function mean(values: readonly number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NaN;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

/**
 * Quantile of a weighted sample: the smallest value at which the cumulative
 * normalised weight reaches `q` (0..1). Non-finite values and non-positive
 * weights are dropped together.
 */
export function weightedQuantile(
  values: readonly number[],
  weights: readonly number[],
  q: number
): number {
  if (values.length !== weights.length) {
    throw new Error(`values (${values.length}) and weights (${weights.length}) differ in length`);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const w = weights[i]!;
    if (Number.isFinite(v) && Number.isFinite(w) && w > 0) pairs.push([v, w]);
  }
  if (pairs.length === 0) return NaN;
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  const threshold = Math.min(1, Math.max(0, q)) * total;
  let cumulative = 0;
  for (const [v, w] of pairs) {
    cumulative += w;
    if (cumulative >= threshold - 1e-12) return v;
  }
  return pairs[pairs.length - 1]![0];
}

export function parseNdjson(text: string): MarkRecord[] {
  const records: MarkRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A partial trailing line while the app is still writing is expected.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Partial<MarkRecord>;
    if (typeof record.mark !== "string" || typeof record.elapsedMs !== "number") continue;
    records.push({
      mark: record.mark,
      timestamp: typeof record.timestamp === "number" ? record.timestamp : NaN,
      elapsedMs: record.elapsedMs,
      meta: record.meta && typeof record.meta === "object" ? record.meta : null,
    });
  }
  return records;
}

export const SWITCH_MARK = {
  KEYDOWN: "project_switch.keydown",
  INTENT: "project_switch.intent",
  BUSY_PAINTED: "project_switch.busy_painted",
  PERSIST_IDLE: "project_switch.persist_idle",
  SNAPSHOT_BUILT: "project_switch.snapshot_built",
  IPC_SENT: "project_switch.ipc_sent",
  MAIN_RECEIVED: "project_switch.main_received",
  MAIN_LOOP_PROBE: "project_switch.main_loop_probe",
  PENDING_PERSIST_DONE: "project_switch.pending_persist_done",
  CHAIN_ENTERED: "project_switch.chain_entered",
  VIEW_ATTACHED: "project_switch.view_attached",
  LOAD_FINISHED: "project_switch.load_finished",
  GATE_RESOLVED: "project_switch.gate_resolved",
  REVEALED: "project_switch.revealed",
  SWAP_DONE: "project_switch.swap_done",
  PTY_PORT_SENT: "project_switch.pty_port_sent",
  WORKTREES_LOADED: "project_switch.worktrees_loaded",
  SETTLED: "project_switch.settled",
  FIRST_INTERACTIVE: "project_switch.first_interactive",
  ON_SWITCH_RECEIVED: "project_switch.on_switch_received",
  WARM_ACTIVATED_RECEIVED: "project_switch.warm_activated_received",
  FOCUSED_PANE_WOKEN: "project_switch.focused_pane_woken",
  ALL_PANES_WOKEN: "project_switch.all_panes_woken",
  WARM_PAINT_SIGNALLED: "project_switch.warm_paint_signalled",
  REVEALED_RECEIVED: "project_switch.revealed_received",
  REVEAL_REPAINT_DONE: "project_switch.reveal_repaint_done",
  PTY_PORT_READY: "project_switch.pty_port_ready",
  NONCE_PAINTED: "project_switch.nonce_painted",
  NONCE_FRAME: "project_switch.nonce_frame",
  HYDRATE_START: "hydrate_start",
  HYDRATE_COMPLETE: "hydrate_complete",
  RENDERER_FIRST_INTERACTIVE: "renderer_first_interactive",
  APP_HYDRATE_PREFETCH: "app_hydrate_prefetch",
  EVENT_LOOP_LAG: "event_loop_lag",
  RENDERER_LOAF: "renderer_long_animation_frame",
} as const;

/** Renderer marks that carry no switchId and are joined to a switch by view + time window. */
const JOINABLE_RENDERER_MARKS: ReadonlySet<string> = new Set([
  SWITCH_MARK.HYDRATE_START,
  SWITCH_MARK.HYDRATE_COMPLETE,
  SWITCH_MARK.RENDERER_FIRST_INTERACTIVE,
  SWITCH_MARK.RENDERER_LOAF,
]);

/** Tail after `settled` in which incoming-renderer marks still belong to the switch. */
export const JOIN_TAIL_MS = 5_000;

export interface SwitchMarkGroup {
  switchId: string;
  /** Marks that named this switchId in their meta. */
  marks: MarkRecord[];
  /** Renderer marks joined by webContentsId + time window. */
  joined: MarkRecord[];
  /** Main-process `event_loop_lag` samples inside the switch window. */
  lagSamples: MarkRecord[];
  /** `app_hydrate_prefetch` inside the window for the target project, when one was emitted. */
  prefetch: MarkRecord | null;
  windowStartMs: number;
  windowEndMs: number;
  targetWebContentsId: number | null;
}

export interface GroupedMarks {
  bySwitch: Map<string, SwitchMarkGroup>;
  byNonce: Map<string, MarkRecord[]>;
}

function metaString(record: MarkRecord, key: string): string | null {
  const value = record.meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metaNumber(record: MarkRecord, key: string): number | null {
  const value = record.meta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function findMark(marks: readonly MarkRecord[], mark: string): MarkRecord | undefined {
  return marks.find((record) => record.mark === mark);
}

export function groupMarksBySwitch(records: readonly MarkRecord[]): GroupedMarks {
  const bySwitch = new Map<string, SwitchMarkGroup>();
  const byNonce = new Map<string, MarkRecord[]>();

  for (const record of records) {
    const nonce = metaString(record, "nonce");
    if (
      nonce &&
      (record.mark === SWITCH_MARK.NONCE_PAINTED || record.mark === SWITCH_MARK.NONCE_FRAME)
    ) {
      const list = byNonce.get(nonce) ?? [];
      list.push(record);
      byNonce.set(nonce, list);
      continue;
    }
    const switchId = metaString(record, "switchId");
    if (!switchId) continue;
    let group = bySwitch.get(switchId);
    if (!group) {
      group = {
        switchId,
        marks: [],
        joined: [],
        lagSamples: [],
        prefetch: null,
        windowStartMs: NaN,
        windowEndMs: NaN,
        targetWebContentsId: null,
      };
      bySwitch.set(switchId, group);
    }
    group.marks.push(record);
  }

  for (const group of bySwitch.values()) {
    group.marks.sort((a, b) => a.elapsedMs - b.elapsedMs);
    const mainReceived = findMark(group.marks, SWITCH_MARK.MAIN_RECEIVED);
    const settled = findMark(group.marks, SWITCH_MARK.SETTLED);
    const viewAttached = findMark(group.marks, SWITCH_MARK.VIEW_ATTACHED);
    const first = group.marks[0]!;
    const last = group.marks[group.marks.length - 1]!;
    group.windowStartMs = (mainReceived ?? first).elapsedMs;
    group.windowEndMs = (settled ?? last).elapsedMs + JOIN_TAIL_MS;
    group.targetWebContentsId = viewAttached ? metaNumber(viewAttached, "webContentsId") : null;
  }

  const groups = [...bySwitch.values()];
  for (const record of records) {
    if (metaString(record, "switchId")) continue;
    if (record.mark === SWITCH_MARK.EVENT_LOOP_LAG) {
      for (const group of groups) {
        if (record.elapsedMs >= group.windowStartMs && record.elapsedMs <= group.windowEndMs) {
          group.lagSamples.push(record);
        }
      }
      continue;
    }
    if (record.mark === SWITCH_MARK.APP_HYDRATE_PREFETCH) {
      const projectId = metaString(record, "projectId");
      for (const group of groups) {
        if (record.elapsedMs < group.windowStartMs || record.elapsedMs > group.windowEndMs) {
          continue;
        }
        const mainReceived = findMark(group.marks, SWITCH_MARK.MAIN_RECEIVED);
        const target = mainReceived ? metaString(mainReceived, "targetProjectId") : null;
        if (projectId && target && projectId !== target) continue;
        // The earliest prefetch mark inside the window is the one this switch's hydrate consumed.
        if (!group.prefetch || record.elapsedMs < group.prefetch.elapsedMs) group.prefetch = record;
      }
      continue;
    }
    if (!JOINABLE_RENDERER_MARKS.has(record.mark)) continue;
    const webContentsId = metaNumber(record, "webContentsId");
    if (webContentsId === null) continue;
    for (const group of groups) {
      if (group.targetWebContentsId !== webContentsId) continue;
      if (record.elapsedMs < group.windowStartMs || record.elapsedMs > group.windowEndMs) continue;
      group.joined.push(record);
    }
  }
  for (const group of groups) group.joined.sort((a, b) => a.elapsedMs - b.elapsedMs);

  return { bySwitch, byNonce };
}

export const TIMING_KEYS = [
  "keydownToIntentMs",
  "intentToBusyPaintedMs",
  "intentToIpcSentMs",
  "intentToMainReceivedMs",
  "intentToChainEnteredMs",
  "intentToViewAttachedMs",
  "intentToGateResolvedMs",
  "intentToRevealedMs",
  "intentToFocusReadyMs",
  "intentToNoncePaintedMs",
  "intentToWarmActivatedReceivedMs",
  "intentToFocusedPaneWokenMs",
  "intentToAllPanesWokenMs",
  "intentToWarmPaintSignalledMs",
  "intentToPtyPortReadyMs",
  "intentToHydrateCompleteMs",
  "intentToFirstInteractiveMs",
  "intentToSettledMs",
  "revealToRepaintDoneMs",
] as const;

export type TimingKey = (typeof TIMING_KEYS)[number];
export type SampleTimings = Record<TimingKey, number>;

export interface SampleLag {
  mainLoopLagMs: number;
  eventLoopLagOverlapMs: number;
  rendererLoafCount: number;
  rendererLoafTotalMs: number;
}

export interface SampleSummary {
  timings: SampleTimings;
  lag: SampleLag;
  actualCache: CacheClass | null;
  gateOutcome: string | null;
  releaseChannel: string | null;
  prefetchHit: boolean | null;
  entryPointReported: string | null;
  /** `main_received` elapsedMs — the anchor when the outgoing renderer emitted no intent. */
  anchorMs: number;
  anchorMark: string;
  /** Ordering-invariant violations, empty when every present mark is in order. */
  orderingViolations: string[];
}

const NAN_TIMINGS: SampleTimings = Object.fromEntries(
  TIMING_KEYS.map((key) => [key, NaN])
) as SampleTimings;

/**
 * Turn one switch's marks into the timings the report carries. Every timing is
 * measured from `intent` (the outgoing renderer deciding to switch); when the
 * switch was driven without a keyboard/palette intent the anchor falls back to
 * `main_received` and the summary says so.
 */
export function summarizeSample(
  group: SwitchMarkGroup,
  nonceMarks: readonly MarkRecord[] = [],
  focusReadyMs: number = NaN
): SampleSummary {
  const all = [...group.marks, ...group.joined];
  const at = (mark: string, source: readonly MarkRecord[] = all): number => {
    const record = findMark(source, mark);
    return record ? record.elapsedMs : NaN;
  };

  const keydown = at(SWITCH_MARK.KEYDOWN);
  const intentRaw = at(SWITCH_MARK.INTENT);
  const mainReceived = at(SWITCH_MARK.MAIN_RECEIVED);
  const anchorMark = Number.isFinite(intentRaw)
    ? SWITCH_MARK.INTENT
    : Number.isFinite(keydown)
      ? SWITCH_MARK.KEYDOWN
      : SWITCH_MARK.MAIN_RECEIVED;
  const intent = Number.isFinite(intentRaw)
    ? intentRaw
    : Number.isFinite(keydown)
      ? keydown
      : mainReceived;

  const revealed = at(SWITCH_MARK.REVEALED);
  const noncePainted = at(SWITCH_MARK.NONCE_PAINTED, nonceMarks);
  const hydrateComplete = at(SWITCH_MARK.HYDRATE_COMPLETE, group.joined);
  const firstInteractiveMain = at(SWITCH_MARK.FIRST_INTERACTIVE, group.marks);
  const firstInteractive = Number.isFinite(firstInteractiveMain)
    ? firstInteractiveMain
    : at(SWITCH_MARK.RENDERER_FIRST_INTERACTIVE, group.joined);
  const repaintDone = group.marks.find(
    (record) =>
      record.mark === SWITCH_MARK.REVEAL_REPAINT_DONE && metaString(record, "pass") === "initial"
  );

  const timings: SampleTimings = {
    ...NAN_TIMINGS,
    keydownToIntentMs: intentRaw - keydown,
    intentToBusyPaintedMs: at(SWITCH_MARK.BUSY_PAINTED) - intent,
    intentToIpcSentMs: at(SWITCH_MARK.IPC_SENT) - intent,
    intentToMainReceivedMs: mainReceived - intent,
    intentToChainEnteredMs: at(SWITCH_MARK.CHAIN_ENTERED) - intent,
    intentToViewAttachedMs: at(SWITCH_MARK.VIEW_ATTACHED) - intent,
    intentToGateResolvedMs: at(SWITCH_MARK.GATE_RESOLVED) - intent,
    intentToRevealedMs: revealed - intent,
    intentToFocusReadyMs: focusReadyMs,
    intentToNoncePaintedMs: noncePainted - intent,
    intentToWarmActivatedReceivedMs: at(SWITCH_MARK.WARM_ACTIVATED_RECEIVED) - intent,
    intentToFocusedPaneWokenMs: at(SWITCH_MARK.FOCUSED_PANE_WOKEN) - intent,
    intentToAllPanesWokenMs: at(SWITCH_MARK.ALL_PANES_WOKEN) - intent,
    intentToWarmPaintSignalledMs: at(SWITCH_MARK.WARM_PAINT_SIGNALLED) - intent,
    intentToPtyPortReadyMs: at(SWITCH_MARK.PTY_PORT_READY) - intent,
    intentToHydrateCompleteMs: hydrateComplete - intent,
    intentToFirstInteractiveMs: firstInteractive - intent,
    intentToSettledMs: at(SWITCH_MARK.SETTLED) - intent,
    revealToRepaintDoneMs: repaintDone ? repaintDone.elapsedMs - revealed : NaN,
  };

  const mainReceivedRecord = findMark(group.marks, SWITCH_MARK.MAIN_RECEIVED);
  const probe = findMark(group.marks, SWITCH_MARK.MAIN_LOOP_PROBE);
  const mainLoopLagMs =
    (probe ? metaNumber(probe, "lagMs") : null) ??
    (mainReceivedRecord ? metaNumber(mainReceivedRecord, "mainLoopLagMs") : null) ??
    NaN;
  const settledMs = at(SWITCH_MARK.SETTLED);
  const lagWindowEnd = Number.isFinite(settledMs) ? settledMs : group.windowEndMs;
  const eventLoopLagOverlapMs = group.lagSamples
    .filter((record) => record.elapsedMs <= lagWindowEnd)
    .reduce((sum, record) => sum + (metaNumber(record, "lagMs") ?? 0), 0);
  const loafs = group.joined.filter(
    (record) => record.mark === SWITCH_MARK.RENDERER_LOAF && record.elapsedMs <= lagWindowEnd
  );
  const rendererLoafTotalMs = loafs.reduce(
    (sum, record) =>
      sum + (metaNumber(record, "durationMs") ?? metaNumber(record, "duration") ?? 0),
    0
  );

  const gate = findMark(group.marks, SWITCH_MARK.GATE_RESOLVED);
  const cacheState = mainReceivedRecord ? metaString(mainReceivedRecord, "cacheState") : null;
  const prefetchHitRaw = group.prefetch?.meta?.hit;

  const orderingViolations: string[] = [];
  // Renderer marks are rebased onto main's clock; the two clocks disagree by a
  // few hundred microseconds, which a switch that completes in single-digit
  // milliseconds would otherwise report as a causality violation.
  const CLOCK_SKEW_MS = 2;
  const check = (label: string, earlier: number, later: number, strict: boolean): void => {
    if (!Number.isFinite(earlier) || !Number.isFinite(later)) return;
    if (strict ? later + CLOCK_SKEW_MS <= earlier : later + CLOCK_SKEW_MS < earlier) {
      orderingViolations.push(`${label} (${earlier} vs ${later})`);
    }
  };
  check("keydown ≤ intent", keydown, intentRaw, false);
  check("intent < main_received", intentRaw, mainReceived, true);
  check("main_received ≤ chain_entered", mainReceived, at(SWITCH_MARK.CHAIN_ENTERED), false);
  check(
    "chain_entered < view_attached",
    at(SWITCH_MARK.CHAIN_ENTERED),
    at(SWITCH_MARK.VIEW_ATTACHED),
    true
  );
  check(
    "view_attached ≤ gate_resolved",
    at(SWITCH_MARK.VIEW_ATTACHED),
    at(SWITCH_MARK.GATE_RESOLVED),
    false
  );
  check("gate_resolved ≤ revealed", at(SWITCH_MARK.GATE_RESOLVED), revealed, false);
  check("revealed ≤ settled", revealed, settledMs, false);
  check("revealed < nonce_painted", revealed, noncePainted, true);

  return {
    timings,
    lag: {
      mainLoopLagMs,
      eventLoopLagOverlapMs,
      rendererLoafCount: loafs.length,
      rendererLoafTotalMs,
    },
    actualCache: cacheState === "warm" || cacheState === "cold" ? cacheState : null,
    gateOutcome: gate ? metaString(gate, "gateOutcome") : null,
    releaseChannel: gate ? metaString(gate, "releaseChannel") : null,
    prefetchHit: typeof prefetchHitRaw === "boolean" ? prefetchHitRaw : null,
    entryPointReported: mainReceivedRecord ? metaString(mainReceivedRecord, "entryPoint") : null,
    anchorMs: intent,
    anchorMark,
    orderingViolations,
  };
}

export interface MetricStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export type StatsByTiming = Partial<Record<TimingKey, MetricStats>>;

export interface AggregateBucket {
  n: number;
  timings: StatsByTiming;
}

export interface WeightedAggregate {
  weights: Record<number, number>;
  /** Weight actually applied per depth after dropping depths with no valid samples. */
  effectiveWeights: Record<number, number>;
  timings: Partial<Record<TimingKey, { p50: number; p95: number }>>;
}

export interface AggregateInput {
  depth: number;
  actualCache: CacheClass | null;
  expectedCache: CacheClass;
  entryPoint: string;
  timings: SampleTimings;
}

export interface Aggregate {
  byDepth: Record<number, AggregateBucket>;
  byCache: Record<CacheClass, AggregateBucket>;
  byEntryPoint: Record<string, AggregateBucket>;
  weighted: WeightedAggregate;
}

export const DEFAULT_DEPTH_WEIGHTS: Record<number, number> = { 1: 0.55, 2: 0.25, 3: 0.12, 4: 0.08 };

function statsFor(values: readonly number[]): MetricStats | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return {
    n: finite.length,
    p50: pct(finite, 50),
    p95: pct(finite, 95),
    max: Math.max(...finite),
    mean: mean(finite),
  };
}

function bucketFor(samples: readonly AggregateInput[]): AggregateBucket {
  const timings: StatsByTiming = {};
  for (const key of TIMING_KEYS) {
    const stats = statsFor(samples.map((sample) => sample.timings[key]));
    if (stats) timings[key] = stats;
  }
  return { n: samples.length, timings };
}

/**
 * Per-depth, per-cache-class and per-entry-point stats, plus a weighted
 * quantile that answers "what does a typical switch cost" given how often each
 * stack distance is used. Each depth's weight is split evenly across its valid
 * samples, so an over-sampled depth does not out-vote the weights.
 */
export function aggregate(
  samples: readonly AggregateInput[],
  weights: Record<number, number> = DEFAULT_DEPTH_WEIGHTS
): Aggregate {
  const byDepth: Record<number, AggregateBucket> = {};
  const byEntryPoint: Record<string, AggregateBucket> = {};
  const depthGroups = new Map<number, AggregateInput[]>();
  const cacheGroups: Record<CacheClass, AggregateInput[]> = { warm: [], cold: [] };
  const entryGroups = new Map<string, AggregateInput[]>();
  for (const sample of samples) {
    depthGroups.set(sample.depth, [...(depthGroups.get(sample.depth) ?? []), sample]);
    const cache = sample.actualCache ?? sample.expectedCache;
    cacheGroups[cache].push(sample);
    entryGroups.set(sample.entryPoint, [...(entryGroups.get(sample.entryPoint) ?? []), sample]);
  }
  for (const [depth, group] of [...depthGroups.entries()].sort((a, b) => a[0] - b[0])) {
    byDepth[depth] = bucketFor(group);
  }
  const byCache: Record<CacheClass, AggregateBucket> = {
    warm: bucketFor(cacheGroups.warm),
    cold: bucketFor(cacheGroups.cold),
  };
  for (const [entryPoint, group] of [...entryGroups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    byEntryPoint[entryPoint] = bucketFor(group);
  }

  const weightedDepths = [...depthGroups.keys()].filter((depth) => (weights[depth] ?? 0) > 0);
  const totalWeight = weightedDepths.reduce((sum, depth) => sum + (weights[depth] ?? 0), 0);
  const effectiveWeights: Record<number, number> = {};
  for (const depth of weightedDepths) {
    effectiveWeights[depth] = totalWeight > 0 ? (weights[depth] ?? 0) / totalWeight : 0;
  }
  const weighted: WeightedAggregate = { weights, effectiveWeights, timings: {} };
  for (const key of TIMING_KEYS) {
    const values: number[] = [];
    const sampleWeights: number[] = [];
    for (const depth of weightedDepths) {
      const valid = (depthGroups.get(depth) ?? []).filter((sample) =>
        Number.isFinite(sample.timings[key])
      );
      if (valid.length === 0) continue;
      for (const sample of valid) {
        values.push(sample.timings[key]);
        sampleWeights.push(effectiveWeights[depth]! / valid.length);
      }
    }
    if (values.length === 0) continue;
    weighted.timings[key] = {
      p50: weightedQuantile(values, sampleWeights, 0.5),
      p95: weightedQuantile(values, sampleWeights, 0.95),
    };
  }

  return { byDepth, byCache, byEntryPoint, weighted };
}

// ── Result file shape (shared with scripts/perf/project-switch-rotation-compare.ts) ──

export interface RotationConfig {
  cap: number;
  projects: number;
  worktreesPerProject: number;
  agentsPerProject: number;
  filesPerRepo: number;
  samplesPerDepth: number;
  seed: number;
  weights: Record<number, number>;
  entryPoints: string[];
  rapidBursts: number;
}

export interface RotationApparatus {
  rendererGone: number;
  hardTimeouts: number;
  cacheMisclassified: number;
  nonceLost: number;
  nonceDuplicated: number;
  crossPtyLeaks: number;
  uncheckedEvictedViews: number;
  samplesInvalid: number;
  settleTimeouts: number;
}

export interface MemoryViewSample {
  projectId: string | null;
  state: string | null;
  webContentsId: number | null;
  pid: number | null;
  workingSetKb: number;
  guestPids: number[];
}

export interface MemorySample {
  at: string;
  phase: string;
  sampleIndex: number | null;
  totalKb: number;
  browserKb: number;
  gpuKb: number;
  rendererTotalKb: number;
  unattributedRendererKb: number;
  utilityByNameKb: Record<string, number>;
  ptyDescendantsKb: number;
  views: MemoryViewSample[];
}

export interface RotationSample {
  index: number;
  phase: "isolated" | "rapid";
  switchId: string | null;
  entryPoint: string;
  entryPointFallback: boolean;
  depth: number;
  fromProjectId: string;
  targetProjectId: string;
  expectedCache: CacheClass;
  actualCache: CacheClass | null;
  gateOutcome: string | null;
  releaseChannel: string | null;
  prefetchHit: boolean | null;
  probeArmedAfterSwitch: boolean;
  focusRescued: boolean;
  nonce: string | null;
  nonceHits: number | null;
  anchorMark: string | null;
  orderingViolations: string[];
  settleTimedOut: boolean;
  timings: SampleTimings;
  lag: SampleLag;
  memory?: MemorySample;
}

export interface RotationRapidBurst {
  burst: number;
  switchIds: string[];
  queueDelaysMs: number[];
  settleMs: number[];
  gateOutcomes: Record<string, number>;
  attachedMatchedTarget: boolean;
}

export interface RotationResult {
  label: string;
  platform: string;
  arch: string;
  createdAt: string;
  commit: string;
  config: RotationConfig;
  apparatus: RotationApparatus;
  samples: RotationSample[];
  byDepth: Aggregate["byDepth"];
  byCache: Aggregate["byCache"];
  byEntryPoint: Aggregate["byEntryPoint"];
  weighted: WeightedAggregate;
  rapid: {
    bursts: RotationRapidBurst[];
    maxQueueDelayMs: number;
    maxSettleMs: number;
    gateOutcomes: Record<string, number>;
  };
  memory: {
    checkpoints: { hot: MemorySample | null; postPurge: MemorySample | null };
    samples: MemorySample[];
  };
  markRecords?: MarkRecord[];
}
