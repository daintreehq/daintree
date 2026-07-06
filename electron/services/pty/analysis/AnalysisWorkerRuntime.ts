import { setPluginAgentRegistry } from "../../../../shared/config/pluginAgentRegistry.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AnalysisSession } from "./AnalysisSession.js";
import type {
  AnalysisWorkerMemorySample,
  HostToWorkerMessage,
  WorkerToHostMessage,
} from "../analysisWorkerProtocol.js";

/**
 * Cadence of the worker's isolate-memory self-report. Matches the
 * ResourceGovernor's 2s check interval so the governor never acts on a signal
 * more than one tick old. The payload is a handful of numbers plus one small
 * entry per session — noise next to the data-path traffic.
 */
export const MEMORY_SAMPLE_INTERVAL_MS = 2000;

/**
 * Worker-side message dispatcher. Holds the terminal-slot map and routes
 * host messages to per-terminal AnalysisSessions. Plain class (no
 * worker_threads dependency) so protocol behavior is unit-testable
 * in-process; `electron/pty-host/analysisWorker.ts` is the thin entry that
 * binds it to `parentPort`.
 */
export class AnalysisWorkerRuntime {
  private readonly sessions = new Map<string, AnalysisSession>();
  // Per-terminal ordering barrier. A `request` op is asynchronous — it drains
  // xterm's parse queue (an async write callback) before serializing — while
  // every other op applies synchronously. Without a barrier, a `free`/`resize`/
  // `set-scrollback`/`create` arriving behind a pending request would dispose
  // or reflow the buffer BEFORE the drain callback runs, breaking the
  // SessionSnapshotter kill-path guarantee that a serialize request queued
  // ahead of `free` captures the pre-kill buffer. While a request is pending,
  // ALL subsequent messages for that terminal chain behind it, preserving
  // total per-terminal message order.
  private readonly barriers = new Map<string, Promise<void>>();
  private memorySampleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (msg: WorkerToHostMessage) => void,
    /**
     * Injectable isolate-memory reader for tests; production uses the worker's
     * own `process.memoryUsage()`, which is isolate-scoped — the whole point
     * of sampling here rather than on the pty-host main thread.
     */
    private readonly readMemory: () => { heapUsed: number; external: number } = () =>
      process.memoryUsage()
  ) {}

  /**
   * Isolate memory + per-session buffer occupancy at this instant. The
   * governor on the pty-host main thread cannot observe worker-isolate memory
   * (separate V8 isolates), so this self-report is its only visibility into
   * the headless mirror buffers that dominate the process footprint.
   */
  collectMemorySample(): AnalysisWorkerMemorySample {
    const memory = this.readMemory();
    const sessions: AnalysisWorkerMemorySample["sessions"] = [];
    for (const [terminalId, session] of this.sessions) {
      const stats = session.bufferStats();
      if (stats) {
        sessions.push({ terminalId, bufferLines: stats.bufferLines, cols: stats.cols });
      }
    }
    return {
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      sessionCount: this.sessions.size,
      sessions,
      sampledAt: Date.now(),
    };
  }

  /**
   * Begin periodic memory self-reporting. The timer is unref'd so an idle
   * worker never keeps the process alive; a saturated worker event loop delays
   * the sample, which the host treats as staleness (stale contributes 0).
   */
  startMemorySampling(intervalMs: number = MEMORY_SAMPLE_INTERVAL_MS): void {
    if (this.memorySampleTimer) return;
    this.memorySampleTimer = setInterval(() => {
      try {
        this.emit({ type: "memory-sample", ...this.collectMemorySample() });
      } catch (error) {
        console.error("[AnalysisWorker] memory sample failed:", error);
      }
    }, intervalMs);
    this.memorySampleTimer.unref?.();
  }

  stopMemorySampling(): void {
    if (this.memorySampleTimer) {
      clearInterval(this.memorySampleTimer);
      this.memorySampleTimer = null;
    }
  }

  handleMessage(msg: HostToWorkerMessage): void {
    const terminalId = "terminalId" in msg ? msg.terminalId : undefined;
    if (terminalId === undefined) {
      void this.runSafe(msg);
      return;
    }
    const pending = this.barriers.get(terminalId);
    if (pending) {
      this.extendBarrier(
        terminalId,
        pending.then(() => this.runSafe(msg))
      );
      return;
    }
    const result = this.runSafe(msg);
    if (result) {
      this.extendBarrier(terminalId, result);
    }
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private runSafe(msg: HostToWorkerMessage): Promise<void> | void {
    try {
      const result = this.dispatch(msg);
      if (result) {
        return result.catch((error: unknown) => {
          console.error("[AnalysisWorker] Failed to handle message:", msg?.type, error);
        });
      }
    } catch (error) {
      console.error("[AnalysisWorker] Failed to handle message:", msg?.type, error);
    }
  }

  private extendBarrier(terminalId: string, work: Promise<void>): void {
    const barrier = work.then(
      () => undefined,
      () => undefined
    );
    this.barriers.set(terminalId, barrier);
    void barrier.then(() => {
      if (this.barriers.get(terminalId) === barrier) {
        this.barriers.delete(terminalId);
      }
    });
  }

  private dispatch(msg: HostToWorkerMessage): Promise<void> | void {
    switch (msg.type) {
      case "create": {
        this.sessions.get(msg.terminalId)?.free();
        this.sessions.set(msg.terminalId, new AnalysisSession(msg, this.emit));
        return;
      }
      case "data":
        this.sessions.get(msg.terminalId)?.feedChunk(msg.data, msg.flags, msg.epoch);
        return;
      case "prelude":
        this.sessions.get(msg.terminalId)?.feedPrelude(msg.data);
        return;
      case "resize":
        this.sessions.get(msg.terminalId)?.resize(msg.cols, msg.rows);
        return;
      case "input":
        this.sessions.get(msg.terminalId)?.notifyInput(msg.data);
        return;
      case "focus":
        this.sessions.get(msg.terminalId)?.notifyFocus();
        return;
      case "submission":
        this.sessions.get(msg.terminalId)?.notifySubmission();
        return;
      case "monitor-start":
        this.sessions.get(msg.terminalId)?.startMonitor(msg);
        return;
      case "monitor-stop":
        this.sessions.get(msg.terminalId)?.stopMonitor();
        return;
      case "monitor-reconfigure":
        this.sessions.get(msg.terminalId)?.reconfigureMonitor(msg.agentId);
        return;
      case "set-polling-interval":
        this.sessions.get(msg.terminalId)?.setPollingInterval(msg.intervalMs);
        return;
      case "agent-context":
        this.sessions.get(msg.terminalId)?.updateAgentContext(msg.agentLive, msg.agentState);
        return;
      case "process-state":
        this.sessions.get(msg.terminalId)?.updateProcessState(msg.hasActiveChildren, msg.cpuUsage);
        return;
      case "set-scrollback":
        this.sessions.get(msg.terminalId)?.setScrollback(msg.lines);
        return;
      case "free": {
        const session = this.sessions.get(msg.terminalId);
        if (session) {
          session.free();
          this.sessions.delete(msg.terminalId);
        }
        return;
      }
      case "plugin-agent-registry":
        setPluginAgentRegistry(msg.registry);
        return;
      case "request": {
        const session = this.sessions.get(msg.terminalId);
        if (!session) {
          this.emit({
            type: "response",
            requestId: msg.requestId,
            terminalId: msg.terminalId,
            result: msg.op === "final-snapshot" ? { snapshot: null, persistence: null } : null,
            error: "no-session",
            generation: msg.generation,
          });
          return;
        }
        const promise =
          msg.op === "serialize"
            ? session.serialize()
            : msg.op === "serialize-persistence"
              ? session.serializeForPersistence()
              : session.captureFinalSnapshot();
        // Returned so handleMessage arms the per-terminal barrier: later
        // messages must not mutate the session until this settles.
        return promise.then(
          (result) => {
            this.emit({
              type: "response",
              requestId: msg.requestId,
              terminalId: msg.terminalId,
              result,
              generation: msg.generation,
            });
          },
          (error: unknown) => {
            this.emit({
              type: "response",
              requestId: msg.requestId,
              terminalId: msg.terminalId,
              result: msg.op === "final-snapshot" ? { snapshot: null, persistence: null } : null,
              error: formatErrorMessage(error, "analysis request failed"),
              generation: msg.generation,
            });
          }
        );
      }
    }
  }
}
