import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { SCROLLBACK_MIN } from "../../../shared/config/scrollback";
import type {
  PtyHostEvent,
  TerminalReliabilityMetricPayload,
} from "../../../shared/types/pty-host";
import type {
  PauseToken,
  PtyPauseCoordinator,
} from "../../../electron/pty-host/PtyPauseCoordinator";
import type { PortQueueManager } from "../../../electron/pty-host/portQueue";
import type { IpcQueueManager } from "../../../electron/pty-host/ipcQueue";
import type { PortBatcher } from "../../../electron/pty-host/portBatcher";
import type { BackpressureManager } from "../../../electron/pty-host/backpressure";
import type {
  ResourceGovernor,
  TerminalActivityInfo,
} from "../../../electron/pty-host/ResourceGovernor";
import type { WorkerMemoryAccounting } from "../../../electron/services/pty/analysis/AnalysisWorkerPool";

/**
 * The REAL pty-host flow-control plane for PERF-063 and PERF-370..373, in a
 * plain Node process.
 *
 * This is the hottest path Daintree has: it runs once per PTY output chunk per
 * terminal per window, and it is what decides which terminal gets paused when a
 * fleet of agents floods the host at once. Nothing measured it. PERF-045
 * measures the fork-channel volume and says so; PERF-092/094 measure idle
 * pollers. The decision plane between them — `PortBatcher` → `PortQueueManager`
 * / `IpcQueueManager` → `PtyPauseCoordinator`, with `ResourceGovernor` sweeping
 * above all of it — had no coverage at all.
 *
 * WHAT IS REAL
 *   - `electron/pty-host/portBatcher.ts` unmodified: the real per-terminal
 *     (idle → latency → throughput) cadence machine, the real 64 KiB
 *     `PORT_BATCH_THRESHOLD_BYTES` synchronous flush, the real focused-terminal
 *     flush ordering, and the real `mergeChunks` with its `owned` zero-copy
 *     fast path and its allocate-and-copy fallback.
 *   - `electron/pty-host/portQueue.ts` and `ipcQueue.ts` unmodified: the real
 *     per-terminal 67% high watermark over the real 3 MiB `IPC_MAX_QUEUE_BYTES`,
 *     the real 16 MiB window aggregate watermark, the real focused-terminal
 *     exemption (port path only — see PERF-371), the real 33% / 8 MiB resume
 *     watermarks, and the real `sweepAggregateResume` fan-out.
 *   - `electron/pty-host/backpressure.ts`'s real `BackpressureManager`, wired
 *     exactly as `pty-host.ts` wires it: every queue manager's and the
 *     governor's `emitTerminalStatus` routes through it, so the real
 *     previous-status dedup decides which transitions reach the wire.
 *   - `electron/pty-host/PtyPauseCoordinator.ts` unmodified: the real
 *     multi-token hold set, so "paused" here means the raw PTY handle really
 *     had `pause()` called on it exactly once.
 *   - `electron/pty-host/ResourceGovernor.ts` unmodified: the real EMA, the
 *     real warmup gate, the real critical bypass, the real trim-before-pause
 *     one-shot, the real idle-first/agent-last pause and resume ordering, the
 *     real FD sweep, and the real gauge emissions.
 *   - Every byte budget and watermark comes from the shipped
 *     `electron/services/pty/types.ts`, never from a number this file chose.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No Electron, no MessagePort, no renderer.** `postMessage` is a counting
 *     sink in this process. The real path transfers an `ArrayBuffer` across a
 *     `MessagePortMain` into a renderer that parses it; none of that is here.
 *     So these durations are **flow-control decision cost, not delivery
 *     latency**, and the sink never applies backpressure of its own — ack
 *     pacing is scripted by the scenario.
 *   - **No node-pty.** The raw handle behind each `PtyPauseCoordinator` is a
 *     counting stub, so `pause()` is free here where in production it suspends
 *     a read on a file descriptor. The COUNT of pause calls is real; the cost
 *     of a pause is not.
 *   - **No analysis workers.** `getWorkerMemoryAccounting` is scripted, which
 *     is the only way to drive the governor's utilization signal to a chosen
 *     value without allocating hundreds of megabytes. The governor's arithmetic
 *     over that signal is entirely real.
 *   - **The governor's 2s interval is not used.** `start()` would make one tick
 *     cost two seconds of wall clock, so the tick body is invoked directly
 *     through the same entry point the interval callback uses. Two consequences:
 *     `FORCE_RESUME_MS` (10 s, the bounded-pause guarantee) and
 *     `REENGAGE_COOLDOWN_MS` (30 s) are wall-clock gates that back-to-back ticks
 *     never trip, so both are **out of frame** here.
 *   - **`DAINTREE_TERMINAL_METRICS` is forced on** (below), so the governor
 *     sweep cost includes all five gated gauges. Production leaves them off by
 *     default, so the reported sweep duration is an upper bound;
 *     `gaugeEventCount` says how much of it is gauge work.
 */

// --- Environment, set before the subject graph is imported -------------------

/**
 * Both of these are read ONCE, at module evaluation of the subject: `metrics.ts`
 * caches `DAINTREE_TERMINAL_METRICS` in a module constant, and
 * `ResourceGovernor.ts` resolves `DAINTREE_PTY_HEAP_BUDGET_MB` into
 * `HEAP_BUDGET_MB` at import. They are therefore set here at fixture module
 * scope, before the dynamic `import()` inside `loadFlowControlModules` runs.
 *
 * `??=` so an explicitly configured environment wins; the mirrored arithmetic
 * below reads the same variable back rather than assuming this file's default.
 *
 * 2048 MiB is a shipped value, not an invented one: it is what `PtyHostLifecycle`
 * gives a RAM-scaled fabric shard. It is preferred over the 512 legacy default
 * so the scripted worker-memory term stays the binding constraint by a wide
 * margin at every rung of the utilization ladder — see `workerTermDominates`.
 */
process.env.DAINTREE_TERMINAL_METRICS ??= "1";
process.env.DAINTREE_PTY_HEAP_BUDGET_MB ??= "2048";

/**
 * A mirror of `ResourceGovernor.resolveHeapBudgetMb`, which is module-private
 * and cannot be imported. Mirrored rather than guessed so the predicted
 * utilization series is computed from the same rule the subject applies.
 */
function mirroredHeapBudgetMb(): number {
  const raw = Number(process.env.DAINTREE_PTY_HEAP_BUDGET_MB);
  if (Number.isFinite(raw) && raw >= 256 && raw <= 8192) return Math.floor(raw);
  return 512;
}

export const HEAP_BUDGET_MB = mirroredHeapBudgetMb();
/** Mirror of the governor's `EXTERNAL_HEADROOM_MB`. */
export const EXTERNAL_HEADROOM_MB = Math.max(256, Math.floor(HEAP_BUDGET_MB / 2));
export const TOTAL_PROCESS_BUDGET_MB = HEAP_BUDGET_MB + EXTERNAL_HEADROOM_MB;

// --- Module views ------------------------------------------------------------

type PortQueueModule = typeof import("../../../electron/pty-host/portQueue");
type IpcQueueModule = typeof import("../../../electron/pty-host/ipcQueue");
type PortBatcherModule = typeof import("../../../electron/pty-host/portBatcher");
type CoordinatorModule = typeof import("../../../electron/pty-host/PtyPauseCoordinator");
type BackpressureModule = typeof import("../../../electron/pty-host/backpressure");
type GovernorModule = typeof import("../../../electron/pty-host/ResourceGovernor");
type PtyTypesModule = typeof import("../../../electron/services/pty/types");

export interface FlowControlModules {
  portQueue: PortQueueModule;
  ipcQueue: IpcQueueModule;
  portBatcher: PortBatcherModule;
  coordinator: CoordinatorModule;
  backpressure: BackpressureModule;
  governor: GovernorModule;
  constants: PtyTypesModule;
  /** What the subject's own cached gate resolved to, not what we asked for. */
  metricsEnabled: boolean;
}

let modulesPromise: Promise<FlowControlModules> | null = null;

async function importModules(): Promise<FlowControlModules> {
  const [
    portQueue,
    ipcQueue,
    portBatcher,
    coordinator,
    backpressure,
    governor,
    constants,
    metrics,
  ] = await Promise.all([
    import("../../../electron/pty-host/portQueue"),
    import("../../../electron/pty-host/ipcQueue"),
    import("../../../electron/pty-host/portBatcher"),
    import("../../../electron/pty-host/PtyPauseCoordinator"),
    import("../../../electron/pty-host/backpressure"),
    import("../../../electron/pty-host/ResourceGovernor"),
    import("../../../electron/services/pty/types"),
    import("../../../electron/pty-host/metrics"),
  ]);
  return {
    portQueue,
    ipcQueue,
    portBatcher,
    coordinator,
    backpressure,
    governor,
    constants,
    metricsEnabled: metrics.metricsEnabled(),
  };
}

/** Load the real pty-host flow-control graph. Once per process. */
export function loadFlowControlModules(): Promise<FlowControlModules> {
  modulesPromise ??= importModules();
  return modulesPromise;
}

// --- Recorded observations ---------------------------------------------------

/**
 * One thing the subject did, stamped with what THIS fixture's own ledger said
 * at that instant.
 *
 * The stamp is what makes the resume oracle independent: a resume is correct
 * only if the queue really was below its watermark when it fired, and the
 * fixture knows that from the bytes it wrote and acked, not from asking the
 * manager to confirm its own decision.
 */
export interface FlowObservation {
  terminalId: string;
  label: string;
  /** The fixture's own running total across the fleet at emit time. */
  ledgerTotalBytes: number;
  /** The fixture's own running total for this terminal at emit time. */
  ledgerOwnBytes: number;
  /** Monotonic emission index, so ordering questions are answerable. */
  sequence: number;
}

export interface RawPtyCounts {
  pauseCalls: number;
  resumeCalls: number;
}

// --- Fleet -------------------------------------------------------------------

export interface FleetTerminalSpec {
  id: string;
  /** Drives the governor's engage/resume triage ordering. */
  agentActive: boolean;
  /** Distinct per terminal so the triage sort is a total order, not a tie. */
  lastOutputTime: number;
  /** Configured scrollback cap, for the governor's targeted-trim ranking. */
  scrollbackLines: number;
  cols: number;
}

export interface FleetSpec {
  terminals: readonly FleetTerminalSpec[];
  focusedId: string | null;
  /**
   * How many window batchers receive every chunk. Production sets
   * `owned = targets.length === 1`, so a two-window fleet loses the zero-copy
   * flush path for every chunk — the contrast PERF-063 prices.
   */
  windowCount?: number;
  /** Construct a real `ResourceGovernor` (spawns one `sysctl` on macOS). */
  withGovernor?: boolean;
}

/** The private tick body the governor's own 2s interval callback invokes. */
interface GovernorTickable {
  checkResources: () => void;
}

export class FlowControlFleet {
  readonly ids: string[];
  /** `terminal-status` events that survived the real dedup and reached the wire. */
  readonly statusEvents: FlowObservation[] = [];
  readonly metricEvents: FlowObservation[] = [];
  readonly hostEvents: PtyHostEvent[] = [];

  /** Bytes delivered downstream, tallied inside the `postMessage` sink. */
  deliveredBytes = 0;
  /** Byte counts the batcher REPORTED alongside each delivery. */
  reportedBytes = 0;
  deliveredChunkCount = 0;
  /** Deliveries whose payload was the exact object written (zero-copy taken). */
  zeroCopyDeliveryCount = 0;
  /** Deliveries whose payload was a fresh buffer (allocate-and-copy taken). */
  copiedDeliveryCount = 0;
  /** Deliveries carrying bytes that are not this terminal's own marker. */
  corruptDeliveryCount = 0;

  /** Ticks on which the governor asked how many terminals exist (FD sweep). */
  governorTerminalCountCalls = 0;
  /** Ticks on which the governor drained the data-loss counter (ungated). */
  governorDropSnapshotCalls = 0;
  /** Targeted pre-pause trims, in the order the governor asked for them. */
  readonly trimRequests: string[][] = [];
  /** Uniform-flatten fallback trims. */
  uniformTrimCount = 0;
  /** Pause tallies the governor reported to the host. */
  governorReportedPauseCount = 0;

  /**
   * One per window, exactly as `pty-host.ts` builds them: each renderer window
   * owns its own queue manager, its own aggregate watermark and its own pause
   * token. A single shared manager would double-count a two-window fleet's
   * bytes and trip watermarks production never trips.
   */
  readonly portQueues: PortQueueManager[];
  readonly portQueueTokens: PauseToken[];
  readonly ipcQueue: IpcQueueManager;
  readonly backpressure: BackpressureManager;
  readonly batchers: PortBatcher[];
  readonly governor: ResourceGovernor | null;

  private readonly spec: FleetSpec;
  private readonly coordinators = new Map<string, PtyPauseCoordinator>();
  private readonly rawCounts = new Map<string, RawPtyCounts>();
  private readonly ledgerById = new Map<string, number>();
  private readonly lastChunkById = new Map<string, Uint8Array>();
  private readonly governorTick: GovernorTickable | null;
  private ledgerTotalBytes = 0;
  private sequence = 0;
  private focusedId: string | null;
  private workerHeapMb = 0;
  private disposed = false;

  constructor(modules: FlowControlModules, spec: FleetSpec) {
    this.spec = spec;
    this.ids = spec.terminals.map((terminal) => terminal.id);
    this.focusedId = spec.focusedId;

    for (const terminal of spec.terminals) {
      const counts: RawPtyCounts = { pauseCalls: 0, resumeCalls: 0 };
      this.rawCounts.set(terminal.id, counts);
      // Counted at the raw handle, which is the only place that can prove the
      // coordinator really suspended the PTY rather than only bookkeeping a
      // token. A manager that "pauses" without reaching here scores.
      const raw = {
        pause: (): void => {
          counts.pauseCalls += 1;
        },
        resume: (): void => {
          counts.resumeCalls += 1;
        },
      };
      this.coordinators.set(terminal.id, new modules.coordinator.PtyPauseCoordinator(raw));
    }

    const getPauseCoordinator = (id: string): PtyPauseCoordinator | undefined =>
      this.coordinators.get(id);
    const getTerminal = (
      id: string
    ): { ptyProcess?: { pause: () => void; resume: () => void } } | undefined =>
      this.coordinators.has(id) ? {} : undefined;
    const sendEvent = (event: PtyHostEvent): void => this.recordHostEvent(event);
    const metricsEnabled = (): boolean => modules.metricsEnabled;
    const emitReliabilityMetric = (payload: TerminalReliabilityMetricPayload): void =>
      this.recordMetric(payload);

    // Wired the way `pty-host.ts` wires it: this is the single status funnel
    // every other component below emits through, so the real previous-status
    // dedup — not a recorder of this fixture's own — decides what reaches the
    // wire.
    this.backpressure = new modules.backpressure.BackpressureManager({
      getTerminal,
      getPauseCoordinator,
      sendEvent,
      metricsEnabled,
      emitReliabilityMetric,
    });
    const emitTerminalStatus: BackpressureManager["emitTerminalStatus"] = (...args) =>
      this.backpressure.emitTerminalStatus(...args);

    const windowCount = spec.windowCount ?? 1;
    this.portQueues = [];
    this.portQueueTokens = [];
    for (let index = 0; index < windowCount; index += 1) {
      const token: PauseToken = index === 0 ? "port-queue" : `port-queue-${index}`;
      this.portQueueTokens.push(token);
      this.portQueues.push(
        new modules.portQueue.PortQueueManager({
          getTerminal,
          getPauseCoordinator,
          sendEvent,
          metricsEnabled,
          emitTerminalStatus,
          emitReliabilityMetric,
          pauseToken: token,
          getFocusedTerminalId: () => this.focusedId,
        })
      );
    }

    // Deliberately WITHOUT a focused-terminal dep: `IpcQueueDeps` has no such
    // member. The asymmetry is the product's, and PERF-371 grades it.
    this.ipcQueue = new modules.ipcQueue.IpcQueueManager({
      getTerminal,
      getPauseCoordinator,
      sendEvent,
      metricsEnabled,
      emitTerminalStatus,
      emitReliabilityMetric,
    });

    this.batchers = [];
    for (let index = 0; index < windowCount; index += 1) {
      this.batchers.push(
        new modules.portBatcher.PortBatcher({
          portQueueManager: this.portQueues[index] as PortQueueManager,
          postMessage: (id, data, bytes) => this.sink(id, data, bytes),
          onError: (error) => {
            throw error instanceof Error ? error : new Error(String(error));
          },
          getFocusedTerminalId: () => this.focusedId,
        })
      );
    }

    if (spec.withGovernor === true) {
      this.governor = new modules.governor.ResourceGovernor({
        getTerminalIds: () => [...this.ids],
        getPauseCoordinator,
        getTerminalCount: () => {
          this.governorTerminalCountCalls += 1;
          return this.ids.length;
        },
        incrementPauseCount: (count) => {
          this.governorReportedPauseCount += count;
        },
        sendEvent,
        emitTerminalStatus,
        getTerminalActivity: () => this.terminalActivity(),
        trimBuffers: () => {
          this.uniformTrimCount += 1;
        },
        trimBuffersTargeted: (targets) => {
          this.trimRequests.push([...targets.keys()]);
        },
        getTerminalBufferSizes: () =>
          spec.terminals.map((terminal) => ({
            id: terminal.id,
            scrollbackLines: terminal.scrollbackLines,
            cols: terminal.cols,
          })),
        getWorkerMemoryAccounting: () => this.workerAccounting(),
        getPendingBytesSnapshot: () => this.portQueue.getQueueSnapshot(),
        getThroughputSnapshot: () => ({
          timestamp: Date.now(),
          totalBytes: this.ledgerTotalBytes,
          totalPackets: this.deliveredChunkCount,
          perTerminal: this.ids.map((id) => ({
            terminalId: id,
            byteCount: this.ledgerById.get(id) ?? 0,
            packetCount: 1,
          })),
          pauseCount: this.totalRawPauseCalls(),
        }),
        getPausedDurationsSnapshot: () =>
          this.ids
            .filter((id) => this.coordinators.get(id)?.isPaused === true)
            .map((id) => ({ terminalId: id, heldDurationMs: 1 })),
        getQueueDepthSnapshot: () =>
          this.portQueue
            .getQueueSnapshot()
            .perTerminal.map((entry) => ({ ...entry, layer: "port" as const })),
        getDropSnapshot: () => {
          this.governorDropSnapshotCalls += 1;
          return { droppedBytesDelta: 0, dataLossCountDelta: 0 };
        },
      });
      this.governorTick = this.governor as unknown as GovernorTickable;
    } else {
      this.governor = null;
      this.governorTick = null;
    }
  }

  // --- Fixture ledger --------------------------------------------------------

  /**
   * The fixture's own byte arithmetic. Every expectation in this family is
   * derived from these two numbers, never from asking a queue manager what it
   * thinks its own depth is.
   */
  recordWrite(id: string, bytes: number): void {
    this.ledgerById.set(id, (this.ledgerById.get(id) ?? 0) + bytes);
    this.ledgerTotalBytes += bytes;
  }

  unrecordWrite(id: string, bytes: number): void {
    this.ledgerById.set(id, Math.max(0, (this.ledgerById.get(id) ?? 0) - bytes));
    this.ledgerTotalBytes = Math.max(0, this.ledgerTotalBytes - bytes);
  }

  recordAck(id: string, bytes: number): void {
    this.unrecordWrite(id, bytes);
  }

  ledgerBytes(id: string): number {
    return this.ledgerById.get(id) ?? 0;
  }

  get ledgerTotal(): number {
    return this.ledgerTotalBytes;
  }

  /** Window 0's queue manager — the only one the single-window scenarios use. */
  get portQueue(): PortQueueManager {
    return this.portQueues[0] as PortQueueManager;
  }

  // --- Recorders -------------------------------------------------------------

  private recordMetric(payload: TerminalReliabilityMetricPayload): void {
    this.sequence += 1;
    this.metricEvents.push({
      terminalId: payload.terminalId,
      label: payload.metricType,
      ledgerTotalBytes: this.ledgerTotalBytes,
      ledgerOwnBytes: this.ledgerBytes(payload.terminalId),
      sequence: this.sequence,
    });
  }

  private recordHostEvent(event: PtyHostEvent): void {
    this.hostEvents.push(event);
    if (event.type === "terminal-status") {
      this.sequence += 1;
      this.statusEvents.push({
        terminalId: event.id,
        label: event.status,
        ledgerTotalBytes: this.ledgerTotalBytes,
        ledgerOwnBytes: this.ledgerBytes(event.id),
        sequence: this.sequence,
      });
    } else if (event.type === "terminal-reliability-metric") {
      this.recordMetric(event.payload);
    }
  }

  /**
   * The downstream sink. Everything the flush path produced is tallied HERE,
   * at the delivery call site, so a flush that never happened cannot be
   * reconstructed from anything the batcher reports about itself.
   *
   * `lastChunkById` holds one reference per terminal — the most recent chunk
   * written for it. `mergeChunks` returns `chunks[0]` only on the single-chunk
   * owned path, and a single-chunk entry's `chunks[0]` IS that most recent
   * write, so identity here is an exact test of which merge branch ran in both
   * directions: a batcher that always copies never matches, and one that
   * transfers a multi-chunk or shared buffer (the PR #4639 slab-alias defect)
   * matches when it must not.
   */
  private sink(id: string, data: Uint8Array, bytes: number): void {
    this.deliveredChunkCount += 1;
    this.deliveredBytes += data.byteLength;
    this.reportedBytes += bytes;
    if (this.lastChunkById.get(id) === data) {
      this.zeroCopyDeliveryCount += 1;
    } else {
      this.copiedDeliveryCount += 1;
    }
    // Payload integrity, not just payload size: the merge path writes each
    // chunk at an offset and an off-by-one there delivers the right number of
    // wrong bytes. Every chunk is filled with its terminal's own marker byte,
    // so checking the ends is O(1) and catches a merge that lost or shifted a
    // chunk.
    if (data.byteLength > 0) {
      const marker = markerFor(id);
      if (data[0] !== marker || data[data.byteLength - 1] !== marker) {
        this.corruptDeliveryCount += 1;
      }
    }
  }

  // --- Governor inputs -------------------------------------------------------

  private terminalActivity(): TerminalActivityInfo[] {
    return this.spec.terminals.map((terminal) => ({
      id: terminal.id,
      lastOutputTime: terminal.lastOutputTime,
      lastInputTime: terminal.lastOutputTime,
      agentState: terminal.agentActive ? "working" : "idle",
    }));
  }

  private workerAccounting(): WorkerMemoryAccounting[] {
    return [
      {
        slotIndex: 0,
        alive: true,
        ageMs: 0,
        heapUsedBytes: this.workerHeapMb * 1024 * 1024,
        externalBytes: 0,
        sessionCount: this.ids.length,
        sessions: this.spec.terminals.map((terminal) => ({
          terminalId: terminal.id,
          bufferLines: terminal.scrollbackLines,
          cols: terminal.cols,
          rows: 40,
          replayInFlight: false,
        })),
      },
    ];
  }

  setWorkerHeapMb(mb: number): void {
    this.workerHeapMb = mb;
  }

  /**
   * Whether the scripted worker term is the governor's binding constraint.
   *
   * The governor takes `max(combined/total, heap/heapBudget, maxWorker/heapBudget)`.
   * With `workerExternal = 0` the worker term wins the first comparison exactly
   * when `worker × EXTERNAL_HEADROOM_MB ≥ HEAP_BUDGET_MB × (heap + external)`,
   * and wins the second whenever it is at least the host heap. Checked per tick
   * rather than assumed: if this process's own footprint ever grew enough to
   * take over, the predicted utilization series would silently stop describing
   * what the governor saw.
   */
  workerTermDominates(): boolean {
    const memory = process.memoryUsage();
    const hostMb = (memory.heapUsed + (memory.external ?? 0)) / 1024 / 1024;
    return (
      this.workerHeapMb >= hostMb &&
      this.workerHeapMb * EXTERNAL_HEADROOM_MB >= HEAP_BUDGET_MB * hostMb
    );
  }

  /** Run one governor sweep — the body the 2s interval callback invokes. */
  tickGovernor(): void {
    this.governorTick?.checkResources();
  }

  // --- Read-back -------------------------------------------------------------

  coordinator(id: string): PtyPauseCoordinator | undefined {
    return this.coordinators.get(id);
  }

  rawCountsFor(id: string): RawPtyCounts {
    return this.rawCounts.get(id) ?? { pauseCalls: 0, resumeCalls: 0 };
  }

  totalRawPauseCalls(): number {
    let total = 0;
    for (const counts of this.rawCounts.values()) total += counts.pauseCalls;
    return total;
  }

  setFocusedId(id: string | null): void {
    this.focusedId = id;
  }

  get focused(): string | null {
    return this.focusedId;
  }

  noteChunk(id: string, chunk: Uint8Array): void {
    this.lastChunkById.set(id, chunk);
  }

  flushAll(): void {
    for (const batcher of this.batchers) batcher.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Order matters: the batchers hold `setImmediate`/`setTimeout` handles and
    // each queue manager holds a 10s `IPC_MAX_PAUSE_MS` safety timeout per
    // paused terminal. A run that skipped this would keep the event loop alive
    // for ten seconds after the last iteration.
    for (const batcher of this.batchers) batcher.dispose();
    for (const queue of this.portQueues) queue.dispose();
    this.ipcQueue.dispose();
    this.backpressure.dispose();
    this.governor?.dispose();
    for (const coordinator of this.coordinators.values()) coordinator.forceReleaseAll();
  }
}

export async function createFleet(spec: FleetSpec): Promise<FlowControlFleet> {
  const modules = await loadFlowControlModules();
  return new FlowControlFleet(modules, spec);
}

/** A per-terminal byte marker, so a delivered payload can be attributed. */
function markerFor(id: string): number {
  let hash = 7;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) & 0xff;
  }
  // 0 would be indistinguishable from an uninitialised buffer.
  return hash === 0 ? 1 : hash;
}

/**
 * A standalone chunk: byteOffset 0, occupying its whole ArrayBuffer — the shape
 * `pty-host.ts` produces with `new Uint8Array(data)` at its ingestion site, and
 * the only shape `mergeChunks` will hand on without copying.
 */
export function makeChunk(id: string, bytes: number): Uint8Array {
  const chunk = new Uint8Array(bytes);
  chunk.fill(markerFor(id));
  return chunk;
}

// --- Fleet builders ----------------------------------------------------------

export const FLOODER_ID = "term-flood";
export const FOCUSED_ID = "term-focus";

/**
 * One flooder, one focused quiet terminal, and `count - 2` background
 * terminals. `lastOutputTime` is distinct per terminal so the governor's
 * activity sort is a total order and its output is a single expected sequence
 * rather than one of many valid permutations.
 */
export function buildFleetSpec(count: number, options?: Partial<FleetSpec>): FleetSpec {
  const terminals: FleetTerminalSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = index === 0 ? FLOODER_ID : index === 1 ? FOCUSED_ID : `term-${index}`;
    terminals.push({
      id,
      // Every fourth background terminal carries a working agent, so the
      // governor's active-last triage has both classes to order.
      agentActive: index >= 2 && index % 4 === 0,
      lastOutputTime: 1_700_000_000_000 + index * 1000,
      // A spread of scrollback caps, half of them at the floor, so the targeted
      // trim has terminals it must SKIP as well as terminals it must trim.
      scrollbackLines: index % 2 === 0 ? SCROLLBACK_MIN : 1000 + index * 100,
      cols: 80 + (index % 5) * 20,
    });
  }
  return { terminals, focusedId: FOCUSED_ID, ...options };
}

// --- Flood driver ------------------------------------------------------------

export interface FloodPlan {
  /** Chunks to write, per terminal id. */
  chunksById: ReadonlyMap<string, number>;
  chunkBytes: number;
  /** Production sets this from `targets.length === 1`. */
  owned: boolean;
  /**
   * Allocate a fresh chunk for every write, as the pty-host ingestion site
   * does. PERF-063 needs this (allocation pressure is its subject); the
   * decision-cost scenarios reuse a pooled chunk so the ingestion allocation is
   * not charged to the flow controller.
   */
  freshChunks: boolean;
  /** Flush every batcher after each write, for a deterministic settle phase. */
  flushEveryWrite?: boolean;
}

export interface FloodResult {
  /**
   * SUBJECT time only: the sum of the `PortBatcher.write` calls and the closing
   * `flush`, with this fixture's own chunk allocation, ledger arithmetic and
   * counters excluded. This is the number every scenario reports.
   */
  ms: number;
  /**
   * Wall clock of the whole drive loop, bookkeeping included. Reported
   * alongside `ms` so the size of the fixture's own overhead stays visible
   * rather than being silently folded into the headline.
   */
  wallMs: number;
  writeCount: number;
  acceptedWriteCount: number;
  rejectedWriteCount: number;
  chunkBytes: number;
  /**
   * `performance.now()` samples taken to isolate the subject.
   *
   * Two per bracketed region. Each region's reading carries roughly one call's
   * worth of clock-read overhead, so at these per-chunk magnitudes the residual
   * is worth knowing: `timerSampleCount / 2 × ` {@link measureTimerOverheadNs}
   * is its upper bound, and the scenarios report both.
   */
  timerSampleCount: number;
}

/**
 * What one `performance.now()` costs on this machine, in nanoseconds.
 *
 * The bracketing that keeps fixture bookkeeping out of the flood readings pays
 * for itself in clock reads, and at ~0.2 µs per chunk that is not negligible.
 * Measured rather than assumed, and reported beside the sample count so the
 * residual in a per-chunk figure is auditable instead of hidden.
 */
export function measureTimerOverheadNs(samples = 20_000): number {
  for (let index = 0; index < 1_000; index += 1) performance.now();
  const started = performance.now();
  for (let index = 0; index < samples; index += 1) performance.now();
  return ((performance.now() - started) * 1e6) / samples;
}

/**
 * Round-robin the fleet, one chunk per terminal per round, the way a fleet of
 * agents actually interleaves at the host.
 *
 * The ledger entry is recorded BEFORE `write()` and rolled back on rejection,
 * because `write()` can flush synchronously and the pause emission that flush
 * triggers must be stamped with a ledger that already includes the chunk in
 * flight. That ordering is not negotiable — but the ledger write is this
 * FIXTURE'S work, not the subject's, so the clock is opened and closed around
 * the `write()` calls themselves and the bookkeeping sits between brackets.
 * Two `performance.now()` calls per write is the same per-operation bracketing
 * {@link runDrain} uses, and it is what keeps chunk allocation, `noteChunk`,
 * the ledger `Map` updates and the accept/reject counters out of a number
 * reported as per-chunk decision cost.
 */
export function runFlood(fleet: FlowControlFleet, plan: FloodPlan): FloodResult {
  const ids = [...plan.chunksById.keys()];
  const pool = new Map<string, Uint8Array>();
  if (!plan.freshChunks) {
    for (const id of ids) pool.set(id, makeChunk(id, plan.chunkBytes));
  }
  let maxRounds = 0;
  for (const count of plan.chunksById.values()) maxRounds = Math.max(maxRounds, count);

  let writeCount = 0;
  let acceptedWriteCount = 0;
  let rejectedWriteCount = 0;
  let subjectMs = 0;
  let timerSampleCount = 0;

  const wallStart = performance.now();
  for (let round = 0; round < maxRounds; round += 1) {
    for (const id of ids) {
      if ((plan.chunksById.get(id) ?? 0) <= round) continue;
      const pooled = pool.get(id);
      const chunk =
        plan.freshChunks || pooled === undefined ? makeChunk(id, plan.chunkBytes) : pooled;
      fleet.noteChunk(id, chunk);
      fleet.recordWrite(id, plan.chunkBytes);
      writeCount += 1;
      let accepted = true;
      const at = performance.now();
      for (const batcher of fleet.batchers) {
        if (!batcher.write(id, chunk, plan.chunkBytes, plan.owned)) accepted = false;
      }
      subjectMs += performance.now() - at;
      timerSampleCount += 2;
      if (accepted) {
        acceptedWriteCount += 1;
      } else {
        rejectedWriteCount += 1;
        fleet.unrecordWrite(id, plan.chunkBytes);
      }
      if (plan.flushEveryWrite === true) {
        const flushAt = performance.now();
        fleet.flushAll();
        subjectMs += performance.now() - flushAt;
        timerSampleCount += 2;
      }
    }
  }
  const finalFlushAt = performance.now();
  fleet.flushAll();
  subjectMs += performance.now() - finalFlushAt;
  timerSampleCount += 2;
  const wallMs = performance.now() - wallStart;

  return {
    ms: subjectMs,
    wallMs,
    writeCount,
    acceptedWriteCount,
    rejectedWriteCount,
    chunkBytes: plan.chunkBytes,
    timerSampleCount,
  };
}

// --- Flush cadence oracle ----------------------------------------------------

/**
 * The per-terminal `(idle → latency → throughput)` cadence machine, graded.
 *
 * Every `runFlood` write runs it — `write()` arms a `setImmediate` on a
 * terminal's first pending chunk and swaps it for a `setTimeout` on the second
 * — and NOTHING ELSE IN THIS FAMILY CAN SEE IT. The synchronous drive loops
 * always end in a threshold flush or a forced `flushAll()`, so deleting the
 * scheduling outright leaves delivery, the victim sets, the queue accounting
 * and every other declared term exactly as they were: the timers are armed,
 * cancelled at the next flush, and never fire. That is the shape this whole
 * family exists to catch, so the cadence gets a term of its own.
 *
 * Two probe fleets rather than one, because `flush()` drains the WHOLE pending
 * map: one terminal's immediate firing would deliver the other's entry too, and
 * the two transitions would not be separable.
 *
 *   fleet I — ONE sub-threshold write. `entry.mode` goes `idle → latency`, so a
 *             `setImmediate` is armed. Nothing may be delivered before the
 *             event loop turns; exactly one delivery must arrive when it does.
 *   fleet T — TWO sub-threshold writes in one tick. The second takes
 *             `latency → throughput`, which CANCELS the immediate and arms a
 *             `PORT_BATCH_THROUGHPUT_DELAY_MS` timeout. So nothing may be
 *             delivered on the immediate turn, and exactly one merged delivery
 *             must arrive after the delay.
 *
 * Both directions are inside each term. A batcher that schedules nothing never
 * delivers and scores; one that flushes synchronously on every write delivers
 * too early and scores; one that kept the immediate but lost the throughput
 * swap delivers fleet T a turn too soon and scores.
 *
 * The waiting is real wall clock and is reported separately — it is never added
 * to a scenario's `durationMs`, which is decision cost.
 */
export interface CadenceGrade {
  immediateFlushMisses: number;
  throughputFlushMisses: number;
  /** Corpus validity: the probe writes really did stay under the sync threshold. */
  cadenceShortfallCount: number;
  immediateDeliveryCount: number;
  throughputDeliveryCount: number;
  /** Wall clock spent waiting for the two scheduled turns. */
  waitedMs: number;
}

export function emptyCadenceGrade(): CadenceGrade {
  return {
    immediateFlushMisses: 0,
    throughputFlushMisses: 0,
    cadenceShortfallCount: 0,
    immediateDeliveryCount: 0,
    throughputDeliveryCount: 0,
    waitedMs: 0,
  };
}

export function addCadenceGrade(into: CadenceGrade, from: CadenceGrade): CadenceGrade {
  into.immediateFlushMisses += from.immediateFlushMisses;
  into.throughputFlushMisses += from.throughputFlushMisses;
  into.cadenceShortfallCount += from.cadenceShortfallCount;
  into.immediateDeliveryCount += from.immediateDeliveryCount;
  into.throughputDeliveryCount += from.throughputDeliveryCount;
  into.waitedMs += from.waitedMs;
  return into;
}

/** One single-terminal fleet, for a cadence probe that owns its own batcher. */
function cadenceFleet(modules: FlowControlModules, id: string): FlowControlFleet {
  return new FlowControlFleet(modules, {
    terminals: [
      {
        id,
        agentActive: false,
        lastOutputTime: 1_700_000_000_000,
        scrollbackLines: SCROLLBACK_MIN,
        cols: 80,
      },
    ],
    focusedId: null,
  });
}

/** Yield past whatever the batcher armed with `setImmediate`. */
async function nextImmediateTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export async function gradeFlushCadence(
  modules: FlowControlModules,
  chunkBytes = 2048
): Promise<CadenceGrade> {
  const grade = emptyCadenceGrade();
  const threshold = modules.constants.PORT_BATCH_THRESHOLD_BYTES;
  const delayMs = modules.constants.PORT_BATCH_THROUGHPUT_DELAY_MS;

  const immediateId = "cadence-immediate";
  const throughputId = "cadence-throughput";
  const immediateFleet = cadenceFleet(modules, immediateId);
  const throughputFleet = cadenceFleet(modules, throughputId);

  // One write on I, two on T, all sub-threshold on their own batcher — so the
  // only thing that can deliver either is the cadence machine.
  if (chunkBytes >= threshold) grade.cadenceShortfallCount += 1;
  if (chunkBytes * 2 >= threshold) grade.cadenceShortfallCount += 1;

  try {
    const startedAt = performance.now();

    const immediateChunk = makeChunk(immediateId, chunkBytes);
    immediateFleet.noteChunk(immediateId, immediateChunk);
    immediateFleet.recordWrite(immediateId, chunkBytes);
    immediateFleet.batchers[0]?.write(immediateId, immediateChunk, chunkBytes, true);

    for (let index = 0; index < 2; index += 1) {
      const chunk = makeChunk(throughputId, chunkBytes);
      throughputFleet.noteChunk(throughputId, chunk);
      throughputFleet.recordWrite(throughputId, chunkBytes);
      throughputFleet.batchers[0]?.write(throughputId, chunk, chunkBytes, true);
    }

    // Nothing may have crossed the sink yet: both entries are under the
    // synchronous threshold, so a delivery here is a batcher that ignored its
    // own cadence and flushed on write.
    if (immediateFleet.deliveredChunkCount !== 0) grade.immediateFlushMisses += 1;
    if (throughputFleet.deliveredChunkCount !== 0) grade.throughputFlushMisses += 1;

    await nextImmediateTurn();

    // The `idle → latency` immediate must have fired, delivering I exactly once
    // and all of its bytes.
    if (immediateFleet.deliveredChunkCount !== 1) grade.immediateFlushMisses += 1;
    if (immediateFleet.deliveredBytes !== chunkBytes) grade.immediateFlushMisses += 1;
    // T's immediate was CANCELLED by its second write, so T must still be
    // holding. A batcher that lost the latency → throughput swap delivers here.
    if (throughputFleet.deliveredChunkCount !== 0) grade.throughputFlushMisses += 1;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs * 2 + 8);
    });
    grade.waitedMs = performance.now() - startedAt;

    // The throughput timeout must have fired, delivering both chunks as one
    // merged entry — and I must not have been delivered a second time.
    if (throughputFleet.deliveredChunkCount !== 1) grade.throughputFlushMisses += 1;
    if (throughputFleet.deliveredBytes !== chunkBytes * 2) grade.throughputFlushMisses += 1;
    if (immediateFleet.deliveredChunkCount !== 1) grade.immediateFlushMisses += 1;

    grade.immediateDeliveryCount = immediateFleet.deliveredChunkCount;
    grade.throughputDeliveryCount = throughputFleet.deliveredChunkCount;
  } finally {
    immediateFleet.dispose();
    throughputFleet.dispose();
  }

  return grade;
}

/**
 * The IPC fallback's own drive shape.
 *
 * **This is a MIRROR of `electron/pty-host.ts`'s fallback block, not a call
 * into it.** `pty-host.ts` is a UtilityProcess entry point: it has zero
 * exports, and its module body throws at line 89 when `process.parentPort` is
 * absent, which it is in every plain Node process. There is no seam to import,
 * so the ordered call sequence below is reproduced here — the manager methods
 * are the real ones, but the ORDER they are called in is this fixture's copy of
 * the host's.
 *
 * What can therefore drift without any queue-manager change: the capacity gate
 * moving after `addBytes`, the utilization read being hoisted or dropped, an
 * `applyBackpressure` call being added or removed, or the drop branch growing a
 * step. {@link ipcFallbackSequenceMisses} reads that ordered sequence back out
 * of `pty-host.ts`'s own source and compares it to what this function does, so
 * the drift is graded rather than trusted — see PERF-371's
 * `ipcFallbackSequenceMisses`.
 *
 * There is no batcher on this path — the fallback writes chunk by chunk — and
 * `IpcQueueDeps` has no focused-terminal member, so this arm is where the focus
 * exemption's absence becomes observable.
 */
export function runIpcFlood(fleet: FlowControlFleet, plan: FloodPlan): FloodResult {
  const ids = [...plan.chunksById.keys()];
  let maxRounds = 0;
  for (const count of plan.chunksById.values()) maxRounds = Math.max(maxRounds, count);

  let writeCount = 0;
  let acceptedWriteCount = 0;
  let rejectedWriteCount = 0;
  let subjectMs = 0;
  let timerSampleCount = 0;

  const wallStart = performance.now();
  for (let round = 0; round < maxRounds; round += 1) {
    for (const id of ids) {
      if ((plan.chunksById.get(id) ?? 0) <= round) continue;
      writeCount += 1;
      const gateAt = performance.now();
      const atCapacity = fleet.ipcQueue.isAtCapacity(id, plan.chunkBytes);
      subjectMs += performance.now() - gateAt;
      timerSampleCount += 2;
      if (atCapacity) {
        rejectedWriteCount += 1;
        continue;
      }
      // Ledger first, and OUTSIDE the bracket: `applyBackpressure` can emit,
      // and an emission must be stamped with a ledger that already holds the
      // chunk in flight.
      fleet.recordWrite(id, plan.chunkBytes);
      acceptedWriteCount += 1;
      const at = performance.now();
      fleet.ipcQueue.addBytes(id, plan.chunkBytes);
      fleet.ipcQueue.applyBackpressure(id, fleet.ipcQueue.getUtilization(id));
      subjectMs += performance.now() - at;
      timerSampleCount += 2;
    }
  }
  const wallMs = performance.now() - wallStart;

  return {
    ms: subjectMs,
    wallMs,
    writeCount,
    acceptedWriteCount,
    rejectedWriteCount,
    chunkBytes: plan.chunkBytes,
    timerSampleCount,
  };
}

/**
 * The ordered `ipcQueueManager` calls `electron/pty-host.ts`'s IPC-fallback
 * block makes, as {@link runIpcFlood} mirrors them.
 *
 * Source order, including the drop branch's utilization read, which the arms
 * here never reach because nothing in them is at capacity:
 *
 *   isAtCapacity → getUtilization (drop) → addBytes → getUtilization → applyBackpressure
 */
export const IPC_FALLBACK_HOST_SEQUENCE: readonly string[] = [
  "isAtCapacity",
  "getUtilization",
  "addBytes",
  "getUtilization",
  "applyBackpressure",
];

const PTY_HOST_SOURCE_URL = new URL("../../../electron/pty-host.ts", import.meta.url);

/** The `if` that opens the IPC fallback block in `pty-host.ts`. */
const IPC_FALLBACK_BLOCK_MARKER = "if (!visualWritten && !isBackgrounded && !isSuspended) {";

/**
 * Whether the host sequence {@link runIpcFlood} mirrors is still the sequence
 * `pty-host.ts` performs. 0 = no drift.
 *
 * `pty-host.ts` exports nothing and refuses to evaluate outside a
 * UtilityProcess, so its fallback path cannot be imported and driven — the
 * mirror in {@link runIpcFlood} is unavoidable. What IS avoidable is trusting
 * it: this reads the ordered `ipcQueueManager.<method>` calls straight out of
 * the host's own source and compares them positionally against
 * {@link IPC_FALLBACK_HOST_SEQUENCE}. A gate that moves, a utilization read
 * that is dropped or hoisted, or an added step scores, and so does a block this
 * cannot find at all — the failure is reported, never resolved in the
 * convenient direction.
 */
export function ipcFallbackSequenceMisses(): number {
  let source: string;
  try {
    source = readFileSync(PTY_HOST_SOURCE_URL, "utf8");
  } catch {
    return IPC_FALLBACK_HOST_SEQUENCE.length;
  }
  return ipcFallbackSequenceMissesIn(source);
}

/**
 * {@link ipcFallbackSequenceMisses} over a supplied source, so the unit test can
 * drive the drift cases — a moved gate, a dropped read, an added step, a block
 * that cannot be found — without editing product code.
 */
export function ipcFallbackSequenceMissesIn(source: string): number {
  const calls = extractIpcFallbackSequence(source);
  if (calls === null) return IPC_FALLBACK_HOST_SEQUENCE.length;

  let misses = Math.abs(calls.length - IPC_FALLBACK_HOST_SEQUENCE.length);
  const shared = Math.min(calls.length, IPC_FALLBACK_HOST_SEQUENCE.length);
  for (let index = 0; index < shared; index += 1) {
    if (calls[index] !== IPC_FALLBACK_HOST_SEQUENCE[index]) misses += 1;
  }
  return misses;
}

/**
 * The ordered `ipcQueueManager.<method>` calls inside the host's IPC-fallback
 * block, or null when the block cannot be located or its braces do not balance.
 */
export function extractIpcFallbackSequence(source: string): string[] | null {
  const markerAt = source.indexOf(IPC_FALLBACK_BLOCK_MARKER);
  if (markerAt === -1) return null;

  let cursor = markerAt + IPC_FALLBACK_BLOCK_MARKER.length;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0) return null;

  const block = source.slice(markerAt, cursor);
  const calls: string[] = [];
  const pattern = /ipcQueueManager\.([A-Za-z0-9_]+)\s*\(/g;
  let match = pattern.exec(block);
  while (match !== null) {
    calls.push(match[1] as string);
    match = pattern.exec(block);
  }
  return calls;
}

/**
 * Ack every window's queue back to empty from the fixture's own ledger, so a
 * long flood can run without the queues ever reaching a watermark. The ack
 * amount comes from the ledger, never from asking a queue how deep it thinks
 * it is.
 */
export function ackAllQueues(fleet: FlowControlFleet): void {
  for (const id of fleet.ids) {
    const bytes = fleet.ledgerBytes(id);
    if (bytes <= 0) continue;
    for (const queue of fleet.portQueues) queue.removeBytes(id, bytes);
    fleet.recordAck(id, bytes);
  }
}

// --- Drain driver ------------------------------------------------------------

export interface DrainResult {
  ms: number;
  ackCount: number;
  /** The single ack that took the aggregate below its low watermark. */
  sweepAckMs: number;
  sweepAckCount: number;
  /** Cost of the acks that did NOT trigger a sweep — the control. */
  plainAckMs: number;
  plainAckCount: number;
  /** Acks where the manager's depth disagreed with the fixture's ledger. */
  accountingMisses: number;
}

/**
 * Ack the fleet's queues back to empty, round-robin, and isolate the one ack
 * that crosses the aggregate low watermark — that is the ack that pays for
 * `sweepAggregateResume`'s fan-out over every paused terminal, and the cost the
 * other acks never pay.
 *
 * The per-ack depth comparison is two map reads, the same O(1) bookkeeping
 * PERF-360 keeps inside its bracket; the sweep ack is timed on its own so the
 * scaling reading is not diluted by it.
 */
export function runDrain(
  fleet: FlowControlFleet,
  ids: readonly string[],
  ackBytes: number,
  totalLowWatermarkBytes: number
): DrainResult {
  let ackCount = 0;
  let sweepAckMs = 0;
  let sweepAckCount = 0;
  let plainAckMs = 0;
  let plainAckCount = 0;
  let accountingMisses = 0;

  const started = performance.now();
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const id of ids) {
      const owed = fleet.ledgerBytes(id);
      if (owed <= 0) continue;
      remaining = true;
      const bytes = Math.min(ackBytes, owed);
      const wasAbove = fleet.ledgerTotal >= totalLowWatermarkBytes;
      // The ledger moves first, so an emission raised inside removeBytes is
      // stamped with the depth the manager is acting on, not the one before it.
      fleet.recordAck(id, bytes);
      const crossesSweep = wasAbove && fleet.ledgerTotal < totalLowWatermarkBytes;
      const at = performance.now();
      fleet.portQueue.removeBytes(id, bytes);
      const cost = performance.now() - at;
      if (crossesSweep) {
        sweepAckMs += cost;
        sweepAckCount += 1;
      } else {
        plainAckMs += cost;
        plainAckCount += 1;
      }
      ackCount += 1;
      if (
        fleet.portQueue.getQueuedBytes(id) !== fleet.ledgerBytes(id) ||
        fleet.portQueue.getTotalQueuedBytes() !== fleet.ledgerTotal
      ) {
        accountingMisses += 1;
      }
    }
  }
  const ms = performance.now() - started;

  return { ms, ackCount, sweepAckMs, sweepAckCount, plainAckMs, plainAckCount, accountingMisses };
}

// --- Independent oracles -----------------------------------------------------

export interface WatermarkConstants {
  maxQueueBytes: number;
  highWatermarkBytes: number;
  lowWatermarkBytes: number;
  totalHighWatermarkBytes: number;
  totalLowWatermarkBytes: number;
}

/** The real constants, read off the shipped module rather than restated. */
export function watermarks(modules: FlowControlModules): WatermarkConstants {
  const constants = modules.constants;
  return {
    maxQueueBytes: constants.IPC_MAX_QUEUE_BYTES,
    highWatermarkBytes:
      (constants.IPC_MAX_QUEUE_BYTES * constants.IPC_HIGH_WATERMARK_PERCENT) / 100,
    lowWatermarkBytes: (constants.IPC_MAX_QUEUE_BYTES * constants.IPC_LOW_WATERMARK_PERCENT) / 100,
    totalHighWatermarkBytes: constants.IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
    totalLowWatermarkBytes: constants.IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES,
  };
}

/**
 * The set of terminals a queue manager MUST have paused, computed from the
 * fixture's own byte ledger and the shipped watermarks — never by asking the
 * manager.
 *
 * Two triggers, exactly as `PortQueueManager.applyBackpressure` states them: a
 * terminal over its own high watermark is paused regardless of focus, and a
 * terminal with any queued bytes is paused by the window aggregate unless it is
 * the focused one. `focusExempt` is false for the IPC path, which has no
 * focused-terminal dep at all.
 */
export function expectedVictimSet(params: {
  ids: readonly string[];
  ownBytes: (id: string) => number;
  totalBytes: number;
  focusedId: string | null;
  focusExempt: boolean;
  marks: WatermarkConstants;
}): Set<string> {
  const victims = new Set<string>();
  const aggregateEngaged = params.totalBytes >= params.marks.totalHighWatermarkBytes;
  for (const id of params.ids) {
    const own = params.ownBytes(id);
    if (own >= params.marks.highWatermarkBytes) {
      victims.add(id);
      continue;
    }
    const exempt = params.focusExempt && id === params.focusedId;
    if (aggregateEngaged && own > 0 && !exempt) victims.add(id);
  }
  return victims;
}

/** Symmetric difference size — over-pausing and under-pausing both score. */
export function setDifferenceCount(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>
): number {
  let misses = 0;
  for (const id of expected) if (!actual.has(id)) misses += 1;
  for (const id of actual) if (!expected.has(id)) misses += 1;
  return misses;
}

/** Terminals the manager currently holds, read back through the coordinator. */
export function heldByToken(fleet: FlowControlFleet, token: string): Set<string> {
  const held = new Set<string>();
  for (const id of fleet.ids) {
    const coordinator = fleet.coordinator(id);
    if (coordinator === undefined) continue;
    for (const candidate of coordinator.heldTokens) {
      if (candidate === token) held.add(id);
    }
  }
  return held;
}

// --- Governor schedule oracle ------------------------------------------------

/** Mirrors of the governor's private constants, restated for the prediction. */
export const GOVERNOR_EMA_ALPHA = 2 / 11;
export const GOVERNOR_WARMUP_TICKS = 5;
export const GOVERNOR_LIMIT_PERCENT = 85;
export const GOVERNOR_RESUME_PERCENT = 60;
export const GOVERNOR_CRITICAL_PERCENT = 95;
export const GOVERNOR_WARNING_PERCENT = 70;

export interface GovernorPrediction {
  /** The EMA the governor must have arrived at, per tick. */
  smoothed: number[];
  /** Whether the governor must be throttling AFTER each tick. */
  throttling: boolean[];
  /** Tick indices on which a pre-pause trim must have been requested. */
  trimTicks: number[];
  /** Tick indices on which the fleet-wide pause must have been engaged. */
  engageTicks: number[];
  /** Tick indices on which the pause must have been released. */
  disengageTicks: number[];
}

/**
 * Replay the governor's documented decision rules over a scripted utilization
 * ladder, using nothing but arithmetic.
 *
 * This is the oracle a no-op governor cannot satisfy and an eager one cannot
 * either: it names the exact tick on which the smoothed signal first clears the
 * threshold, the exact tick the one-shot trim must precede the pause by, and
 * the exact tick the pause must be released. A governor that pauses on the
 * first tick fails the warmup term; one that never pauses fails every engage
 * term; one that skips the EMA and thresholds the raw reading crosses several
 * ticks early and fails both.
 *
 * `FORCE_RESUME_MS` and `REENGAGE_COOLDOWN_MS` are wall-clock gates that ticks
 * driven back to back never trip, so this mirror models `cooledDown` as true
 * only before the first disengage — the same answer the real `Date.now()`
 * comparison gives in this harness.
 */
export function predictGovernorSchedule(
  utilizationPercents: readonly number[],
  hasTrimDeps: boolean
): GovernorPrediction {
  const smoothed: number[] = [];
  const throttling: boolean[] = [];
  const trimTicks: number[] = [];
  const engageTicks: number[] = [];
  const disengageTicks: number[] = [];

  let currentSmoothed: number | undefined;
  let isThrottling = false;
  let trimAttempted = false;
  let sampleCount = 0;
  let hasDisengaged = false;

  utilizationPercents.forEach((raw, tick) => {
    sampleCount += 1;
    currentSmoothed =
      currentSmoothed === undefined
        ? raw
        : GOVERNOR_EMA_ALPHA * raw + (1 - GOVERNOR_EMA_ALPHA) * currentSmoothed;
    smoothed.push(currentSmoothed);

    const isCritical = raw >= GOVERNOR_CRITICAL_PERCENT;
    if (!isThrottling) {
      const warmedUp = sampleCount >= GOVERNOR_WARMUP_TICKS;
      const cooledDown = !hasDisengaged;
      const aboveThreshold = currentSmoothed > GOVERNOR_LIMIT_PERCENT;
      if (isCritical || (aboveThreshold && warmedUp && cooledDown)) {
        if (!isCritical && !trimAttempted && hasTrimDeps) {
          trimTicks.push(tick);
          trimAttempted = true;
        } else {
          engageTicks.push(tick);
          isThrottling = true;
        }
      } else if (!aboveThreshold && trimAttempted) {
        trimAttempted = false;
      }
    } else if (raw < GOVERNOR_RESUME_PERCENT) {
      disengageTicks.push(tick);
      isThrottling = false;
      hasDisengaged = true;
      trimAttempted = false;
    }
    throttling.push(isThrottling);
  });

  return { smoothed, throttling, trimTicks, engageTicks, disengageTicks };
}

/**
 * The order the governor must pause the fleet in: idle terminals first, agent-
 * active terminals last, and within each class most-recently-active last.
 * Re-derived from the fixture's own activity table.
 */
export function expectedEngageOrder(spec: FleetSpec): string[] {
  return [...spec.terminals]
    .sort((a, b) => {
      if (a.agentActive !== b.agentActive) return a.agentActive ? 1 : -1;
      return b.lastOutputTime - a.lastOutputTime;
    })
    .map((terminal) => terminal.id);
}

/** The reverse triage: agent-active resumed last, least-recently-active first. */
export function expectedDisengageOrder(spec: FleetSpec): string[] {
  return [...spec.terminals]
    .sort((a, b) => {
      if (a.agentActive !== b.agentActive) return a.agentActive ? 1 : -1;
      return a.lastOutputTime - b.lastOutputTime;
    })
    .map((terminal) => terminal.id);
}

/**
 * The terminals the targeted pre-pause trim must ask for, heaviest first.
 *
 * Mirrors `performPrePauseTrim`: only terminals whose scrollback exceeds
 * `SCROLLBACK_MIN`, ranked by `bufferLines × cols × 12`. Half of every fleet
 * this fixture builds sits at the floor, so a trim that flattened everything is
 * caught by the same comparison that catches one that trimmed nothing.
 */
export function expectedTrimOrder(spec: FleetSpec): string[] {
  const bytesPerCell = 12;
  return spec.terminals
    .filter((terminal) => terminal.scrollbackLines > SCROLLBACK_MIN)
    .slice()
    .sort(
      (a, b) =>
        b.scrollbackLines * b.cols * bytesPerCell - a.scrollbackLines * a.cols * bytesPerCell
    )
    .map((terminal) => terminal.id);
}

/** Positional mismatches between two orderings, length differences included. */
export function orderMisses(expected: readonly string[], actual: readonly string[]): number {
  let misses = Math.abs(expected.length - actual.length);
  const shared = Math.min(expected.length, actual.length);
  for (let index = 0; index < shared; index += 1) {
    if (expected[index] !== actual[index]) misses += 1;
  }
  return misses;
}

// --- Console capture ---------------------------------------------------------

/**
 * The flow-control plane logs on every pause, every resume and every governor
 * decision. At 48 terminals that is hundreds of synchronous stderr writes
 * inside the measured bracket, which would price the terminal rather than the
 * subject. The sink counts what it swallowed and every scenario reports it.
 */
export function captureConsole(): () => number {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  let count = 0;
  const sink = (): void => {
    count += 1;
  };
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    return count;
  };
}
