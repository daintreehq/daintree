import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../../../shared/config/agentRegistry.js";
import {
  WorkerAnalysisBackend,
  type AnalysisPoolHost,
  type WorkerAnalysisDelegate,
  type WorkerBackendSpec,
} from "./WorkerAnalysisBackend.js";
import type {
  AnalysisRequestOp,
  AnalysisRequestResult,
  AnalysisWorkerMemorySample,
  HostToWorkerMessage,
  WorkerToHostMessage,
} from "../analysisWorkerProtocol.js";
import type { WorkerResourceSnapshot } from "../../../../shared/types/workerGovernance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// esbuild may emit this module into a shared chunk under
// `dist-electron/electron/chunks/` — step up to the electron root, then down
// to the worker's own bundled entry (registered in scripts/build-main.mjs).
// Mirrors resolveVadWorkerPath in OpenAITranscriptionProvider.
function resolveAnalysisWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "pty-host", "analysisWorker.js");
}

const REQUEST_TIMEOUT_MS = 15_000;
const RESPAWN_BACKOFF_MS = 500;
// KNOWN ELECTRON BUG (37+): repeated worker spawn/terminate crashes with
// `Assertion failed: !flush_tasks_`. Workers are therefore persistent — never
// terminated in normal operation — and each pool slot respawns at most once.
const MAX_RESPAWNS_PER_SLOT = 1;

export function defaultAnalysisPoolSize(): number {
  const override = Number.parseInt(process.env.DAINTREE_ANALYSIS_WORKERS ?? "", 10);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(16, override);
  }
  const parallelism =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const cpuDerived = Math.max(2, Math.min(6, Math.floor(parallelism / 4)));
  // Boot-time memory cap: worker isolates aren't free, so a full CPU-derived
  // pool is unjustified on low-RAM machines. Runtime resizing (e.g. via
  // ResourceProfileService) is a documented follow-up — downsizing can't
  // terminate workers under the Electron flush_tasks_ crash constraint.
  const GIB = 1024 * 1024 * 1024;
  const totalMem = os.totalmem();
  const memCap = totalMem < 8 * GIB ? 2 : totalMem < 16 * GIB ? 4 : Number.POSITIVE_INFINITY;
  return Math.min(cpuDerived, memCap);
}

export function analysisWorkersDisabled(): boolean {
  return process.env.DAINTREE_DISABLE_ANALYSIS_WORKERS === "1";
}

export interface WorkerLike {
  postMessage(msg: unknown): void;
  on(event: "message", cb: (msg: WorkerToHostMessage) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  unref(): void;
  /** worker_threads thread id — optional so test fakes stay minimal. */
  threadId?: number;
}

interface PoolSlot {
  index: number;
  worker: WorkerLike | null;
  terminals: Set<string>;
  respawnCount: number;
  alive: boolean;
  /**
   * Monotonic worker generation, bumped on every (re)spawn into this slot.
   * Stamped onto each request and echoed on its response so a reply produced
   * by a superseded worker instance can never settle a fresh request — the
   * request/response counterpart of the backend's data-path feed epoch.
   */
  generation: number;
  /** Epoch ms of the last message routed at this slot; drives idle reporting. */
  lastActivityAt: number;
  /**
   * Latest isolate-memory self-report from this slot's worker, stamped with
   * host receipt time. Cleared on exit/respawn so a fresh worker instance
   * never inherits its predecessor's numbers; the message listener fences by
   * worker instance identity so a late sample from a superseded instance
   * cannot repopulate it.
   */
  memorySample: (AnalysisWorkerMemorySample & { receivedAt: number }) | null;
}

/** Host-side view of one slot's memory self-report, for the ResourceGovernor. */
export interface WorkerMemoryAccounting {
  slotIndex: number;
  alive: boolean;
  /** ms since the sample was received; Infinity when a slot has never reported. */
  ageMs: number;
  heapUsedBytes: number;
  externalBytes: number;
  sessionCount: number;
  sessions: AnalysisWorkerMemorySample["sessions"];
}

interface PendingRequest {
  resolve: (result: AnalysisRequestResult) => void;
  timer: NodeJS.Timeout;
  slotIndex: number;
  op: AnalysisRequestOp;
  generation: number;
}

function emptyResult(op: AnalysisRequestOp): AnalysisRequestResult {
  return op === "final-snapshot" ? { snapshot: null, persistence: null } : null;
}

export class AnalysisWorkerPool implements AnalysisPoolHost {
  private readonly slots: PoolSlot[] = [];
  private readonly assignments = new Map<string, PoolSlot>();
  private readonly backends = new Map<string, WorkerAnalysisBackend>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private pluginAgentRegistry: Record<string, AgentConfig> | null = null;
  private disposed = false;

  constructor(
    private readonly size: number = defaultAnalysisPoolSize(),
    private readonly spawnWorker: () => WorkerLike = () => {
      // Young-generation cap only (maps to --max-semi-space-size): headless
      // xterm parsing churns short-lived strings, so an uncapped nursery
      // commits slack pages per worker isolate. No old-gen cap — exceeding a
      // resourceLimits old-gen budget terminates the worker.
      const worker = new Worker(resolveAnalysisWorkerPath(), {
        resourceLimits: { maxYoungGenerationSizeMb: 8 },
      });
      worker.unref();
      return worker;
    }
  ) {}

  createBackend(
    spec: WorkerBackendSpec,
    delegate: WorkerAnalysisDelegate
  ): WorkerAnalysisBackend | null {
    if (this.disposed) return null;
    const slot = this.assignSlot(spec.terminalId);
    if (!slot) return null;
    const backend = new WorkerAnalysisBackend(spec, delegate, this);
    this.backends.set(spec.terminalId, backend);
    backend.init();
    return backend;
  }

  post(terminalId: string, msg: HostToWorkerMessage): boolean {
    if (this.disposed) return false;
    const slot = this.assignments.get(terminalId);
    if (!slot?.alive || !slot.worker) return false;
    try {
      slot.worker.postMessage(msg);
      slot.lastActivityAt = Date.now();
      return true;
    } catch (error) {
      console.error(`[AnalysisWorkerPool] postMessage failed for ${terminalId}:`, error);
      return false;
    }
  }

  request(terminalId: string, op: AnalysisRequestOp): Promise<AnalysisRequestResult> {
    const slot = this.assignments.get(terminalId);
    if (this.disposed || !slot?.alive || !slot.worker) {
      return Promise.resolve(emptyResult(op));
    }
    return new Promise<AnalysisRequestResult>((resolve) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn(`[AnalysisWorkerPool] ${op} request timed out for ${terminalId}`);
        resolve(emptyResult(op));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      const generation = slot.generation;
      this.pending.set(requestId, { resolve, timer, slotIndex: slot.index, op, generation });
      try {
        slot.worker!.postMessage({ type: "request", requestId, terminalId, op, generation });
        slot.lastActivityAt = Date.now();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        console.error(`[AnalysisWorkerPool] request post failed for ${terminalId}:`, error);
        resolve(emptyResult(op));
      }
    });
  }

  unregister(terminalId: string): void {
    this.backends.delete(terminalId);
    const slot = this.assignments.get(terminalId);
    if (slot) {
      slot.terminals.delete(terminalId);
      this.assignments.delete(terminalId);
    }
  }

  setPluginAgentRegistry(registry: Record<string, AgentConfig>): void {
    this.pluginAgentRegistry = registry;
    for (const slot of this.slots) {
      if (slot.alive && slot.worker) {
        try {
          slot.worker.postMessage({ type: "plugin-agent-registry", registry });
        } catch {
          // Slot exit handling covers a dying worker.
        }
      }
    }
  }

  getStats(): { workers: number; aliveWorkers: number; terminals: number } {
    return {
      workers: this.slots.length,
      aliveWorkers: this.slots.filter((s) => s.alive).length,
      terminals: this.assignments.size,
    };
  }

  /**
   * Per-slot isolate-memory accounting for the ResourceGovernor. Raw samples
   * with receipt ages — the staleness policy (how old is too old) lives with
   * the governor's other policy constants, not here. Dead slots are included
   * with their liveness flag so the consumer can decide; a slot whose worker
   * has never reported carries `ageMs: Infinity`.
   */
  getMemoryAccounting(): WorkerMemoryAccounting[] {
    const now = Date.now();
    return this.slots.map((slot) => ({
      slotIndex: slot.index,
      alive: slot.alive,
      ageMs: slot.memorySample ? Math.max(0, now - slot.memorySample.receivedAt) : Infinity,
      heapUsedBytes: slot.memorySample?.heapUsedBytes ?? 0,
      externalBytes: slot.memorySample?.externalBytes ?? 0,
      sessionCount: slot.memorySample?.sessionCount ?? 0,
      sessions: slot.memorySample?.sessions ?? [],
    }));
  }

  /**
   * Per-slot governance snapshots. Analysis workers are trim-eligible (their
   * sessions' scrollback can shrink) but never dispose/restart-eligible —
   * persistent worker_threads must not be terminate/recreate cycled (Electron
   * `!flush_tasks_` crash), and a dead slot's recovery is the respawn path's.
   */
  getGovernanceSnapshots(): WorkerResourceSnapshot[] {
    const now = Date.now();
    return this.slots.map((slot) => {
      let queueDepth = 0;
      for (const req of this.pending.values()) {
        if (req.slotIndex === slot.index) queueDepth++;
      }
      return {
        kind: "analysis-pool" as const,
        id: `analysis-worker-${slot.index}`,
        pid: null,
        threadId: slot.worker?.threadId ?? null,
        alive: slot.alive,
        activeSessionCount: slot.terminals.size,
        queueDepth,
        lastActivityAt: slot.lastActivityAt,
        // Isolate self-report (worker threads have their own V8 isolates, so
        // per-thread heap/external IS attributable — only RSS is not).
        memory: slot.memorySample
          ? {
              rssBytes: null,
              heapUsedBytes: slot.memorySample.heapUsedBytes,
              externalBytes: slot.memorySample.externalBytes,
            }
          : null,
        eligibility: { trim: true, dispose: false, restart: false },
        state: slot.alive ? "running" : "dead",
        detail: {
          respawnCount: slot.respawnCount,
          generation: slot.generation,
          idleMs: Math.max(0, now - slot.lastActivityAt),
          memorySampleAgeMs: slot.memorySample
            ? Math.max(0, now - slot.memorySample.receivedAt)
            : null,
        },
      };
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.resolve(emptyResult(req.op));
    }
    this.pending.clear();
    // Workers are intentionally NOT terminated (Electron flush_tasks_ crash);
    // they are unref'd and torn down when the pty-host process exits.
  }

  private assignSlot(terminalId: string): PoolSlot | null {
    const existing = this.assignments.get(terminalId);
    if (existing?.alive) return existing;

    const alive = this.slots.filter((s) => s.alive);
    let slot: PoolSlot | null = null;
    if (this.slots.length < this.size) {
      slot = this.spawnSlot();
    }
    if (!slot) {
      slot = alive.reduce<PoolSlot | null>(
        (best, s) => (best === null || s.terminals.size < best.terminals.size ? s : best),
        null
      );
    }
    if (!slot) return null;
    slot.terminals.add(terminalId);
    this.assignments.set(terminalId, slot);
    return slot;
  }

  private spawnSlot(): PoolSlot | null {
    const slot: PoolSlot = {
      index: this.slots.length,
      worker: null,
      terminals: new Set(),
      respawnCount: 0,
      alive: false,
      generation: 0,
      lastActivityAt: Date.now(),
      memorySample: null,
    };
    if (!this.spawnIntoSlot(slot)) return null;
    this.slots.push(slot);
    return slot;
  }

  private spawnIntoSlot(slot: PoolSlot): boolean {
    let worker: WorkerLike;
    try {
      worker = this.spawnWorker();
    } catch (error) {
      console.error("[AnalysisWorkerPool] Failed to spawn analysis worker:", error);
      return false;
    }
    slot.worker = worker;
    slot.alive = true;
    slot.generation++;
    slot.lastActivityAt = Date.now();
    // A fresh worker instance must never inherit its predecessor's memory
    // numbers — it reports its own within one sample interval.
    slot.memorySample = null;
    worker.on("message", (msg) => this.onWorkerMessage(msg, slot, worker));
    worker.on("error", (err) => {
      console.error(`[AnalysisWorkerPool] Worker ${slot.index} error:`, err);
    });
    worker.on("exit", (code) => this.onWorkerExit(slot, code));
    if (this.pluginAgentRegistry) {
      try {
        worker.postMessage({
          type: "plugin-agent-registry",
          registry: this.pluginAgentRegistry,
        });
      } catch {
        // exit handler covers it
      }
    }
    return true;
  }

  private onWorkerMessage(msg: WorkerToHostMessage, slot: PoolSlot, worker: WorkerLike): void {
    if (msg.type === "memory-sample") {
      // Instance fence: a sample posted by a superseded worker instance (its
      // exit raced the respawn window) must not be attributed to the fresh
      // worker occupying the slot. A disposed pool stops caching — its
      // accounting is no longer consumed and must not keep mutating.
      if (this.disposed || slot.worker !== worker || !slot.alive) return;
      const { type: _type, ...sample } = msg;
      slot.memorySample = { ...sample, receivedAt: Date.now() };
      // Each session carries its mirror's live grid — the host's only view of
      // the geometry a worker mirror is really parsing at, and so the only way
      // a silent divergence can ever be noticed (#11719).
      for (const session of sample.sessions) {
        this.backends.get(session.terminalId)?.noteMirrorGeometry(session.cols, session.rows);
      }
      return;
    }
    if (msg.type === "response") {
      const req = this.pending.get(msg.requestId);
      if (req) {
        // Generation fence: a reply stamped with a superseded worker
        // generation (or arriving after the slot respawned) must not settle
        // the request with stale content — resolve empty instead. Exit
        // handling already flushes pending entries for a dead slot, so this
        // is the belt for replies that race the respawn window.
        const currentGeneration = this.slots[req.slotIndex]?.generation;
        const stale =
          (msg.generation !== undefined && msg.generation !== req.generation) ||
          currentGeneration !== req.generation;
        this.pending.delete(msg.requestId);
        clearTimeout(req.timer);
        if (stale) {
          console.warn(
            `[AnalysisWorkerPool] Discarding stale ${req.op} reply for ${msg.terminalId} ` +
              `(generation ${msg.generation ?? "unknown"} != ${req.generation})`
          );
          req.resolve(emptyResult(req.op));
          return;
        }
        req.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "ready") {
      return;
    }
    this.backends.get(msg.terminalId)?.handleWorkerEvent(msg);
  }

  private onWorkerExit(slot: PoolSlot, code: number): void {
    if (this.disposed || !slot.alive) return;
    slot.alive = false;
    slot.worker = null;
    // A dead worker's isolate is gone; its memory must stop counting.
    slot.memorySample = null;
    console.error(
      `[AnalysisWorkerPool] Analysis worker ${slot.index} exited unexpectedly (code ${code}); ` +
        `${slot.terminals.size} terminal(s) affected`
    );

    // Fail requests routed at the dead worker.
    for (const [requestId, req] of [...this.pending]) {
      if (req.slotIndex === slot.index) {
        this.pending.delete(requestId);
        clearTimeout(req.timer);
        req.resolve(emptyResult(req.op));
      }
    }

    if (slot.respawnCount < MAX_RESPAWNS_PER_SLOT) {
      slot.respawnCount++;
      const backoff = RESPAWN_BACKOFF_MS * slot.respawnCount;
      const timer = setTimeout(() => {
        if (this.disposed) return;
        if (this.spawnIntoSlot(slot)) {
          console.warn(`[AnalysisWorkerPool] Analysis worker ${slot.index} respawned`);
          for (const terminalId of slot.terminals) {
            this.backends.get(terminalId)?.handleWorkerLost();
          }
        } else {
          this.redistribute(slot);
        }
      }, backoff);
      timer.unref();
      return;
    }

    this.redistribute(slot);
  }

  private redistribute(deadSlot: PoolSlot): void {
    const terminals = [...deadSlot.terminals];
    deadSlot.terminals.clear();
    const alive = this.slots.filter((s) => s.alive);
    for (const terminalId of terminals) {
      const backend = this.backends.get(terminalId);
      if (!backend) {
        this.assignments.delete(terminalId);
        continue;
      }
      const target = alive.reduce<PoolSlot | null>(
        (best, s) => (best === null || s.terminals.size < best.terminals.size ? s : best),
        null
      );
      if (!target) {
        this.assignments.delete(terminalId);
        backend.handleDetached();
        continue;
      }
      target.terminals.add(terminalId);
      this.assignments.set(terminalId, target);
      backend.handleWorkerLost();
    }
  }
}
