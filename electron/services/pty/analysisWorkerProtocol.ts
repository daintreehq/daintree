import type { AgentState } from "../../../shared/types/agent.js";
import type { ActivityStateMetadata } from "../ActivityMonitor.js";
import type { AgentConfig } from "../../../shared/config/agentRegistry.js";

// Typed message protocol between the pty-host main thread and the analysis
// worker_threads pool. All payloads must be structured-clone-safe.

export interface AnalysisCreateSpec {
  terminalId: string;
  cols: number;
  rows: number;
  scrollback: number;
  /** Replay the persisted session snapshot into the fresh headless buffer. */
  restore: boolean;
  spawnedAt: number;
  /**
   * Monotonic slot generation. Bumped by the host on every fresh-slot rebuild
   * (worker loss, feed overflow). The worker stamps it onto `data-ack` so the
   * host can discard acks from a superseded generation.
   */
  epoch: number;
}

export interface AnalysisMonitorStartSpec {
  agentId?: string;
  initialState: "busy" | "idle";
  skipInitialStateEmit: boolean;
  /** Whether the host has a live process-state validator to mirror. */
  hasProcessValidator: boolean;
  pollingIntervalMs?: number;
}

export interface AnalysisChunkFlags {
  agentLive: boolean;
  agentState?: AgentState;
}

export type AnalysisRequestOp = "serialize" | "serialize-persistence" | "final-snapshot";

export type HostToWorkerMessage =
  | ({ type: "create" } & AnalysisCreateSpec)
  | { type: "data"; terminalId: string; data: string; flags: AnalysisChunkFlags; epoch: number }
  | { type: "prelude"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "input"; terminalId: string; data: string }
  | { type: "focus"; terminalId: string }
  | { type: "submission"; terminalId: string }
  | ({ type: "monitor-start"; terminalId: string } & AnalysisMonitorStartSpec)
  | { type: "monitor-stop"; terminalId: string }
  | { type: "monitor-reconfigure"; terminalId: string; agentId: string }
  | { type: "set-polling-interval"; terminalId: string; intervalMs: number }
  | { type: "agent-context"; terminalId: string; agentLive: boolean; agentState?: AgentState }
  | {
      type: "process-state";
      terminalId: string;
      hasActiveChildren: boolean;
      cpuUsage: number;
    }
  | { type: "set-scrollback"; terminalId: string; lines: number }
  | { type: "free"; terminalId: string }
  | { type: "plugin-agent-registry"; registry: Record<string, AgentConfig> }
  | {
      /**
       * `generation` is the pool slot's worker generation at post time (bumped
       * on every respawn). The worker echoes it on the response so the host
       * can discard a reply produced by a superseded worker instance — the
       * request/response counterpart of the data-path `epoch` fence.
       */
      type: "request";
      requestId: number;
      terminalId: string;
      op: AnalysisRequestOp;
      generation: number;
    };

export interface AnalysisFinalSnapshot {
  /** Full-buffer serialize (banner included) for the preserved snapshot. */
  snapshot: string | null;
  /** Banner-stripped serialize for on-disk session persistence. */
  persistence: string | null;
}

/**
 * Isolate-scoped memory self-report, posted by each analysis worker on an
 * interval. Worker threads are separate V8 isolates, so the pty-host main
 * thread's `process.memoryUsage()` cannot see their heap or ArrayBuffer
 * backing stores — the headless mirror buffers (the host's dominant memory
 * consumer, ~12 bytes/cell) are invisible to it. This sample is the only
 * signal that lets ResourceGovernor account for that memory.
 */
export interface AnalysisWorkerMemorySample {
  /** `process.memoryUsage().heapUsed` inside the worker isolate, bytes. */
  heapUsedBytes: number;
  /**
   * `process.memoryUsage().external` inside the worker isolate, bytes.
   * Includes the xterm buffer typed-array backing stores.
   */
  externalBytes: number;
  /** Live AnalysisSessions on this worker at sample time. */
  sessionCount: number;
  /**
   * Actual per-session buffer occupancy (lines really held, not the
   * configured scrollback cap) so the governor's targeted trim can rank by
   * real usage instead of assuming every buffer is full.
   */
  sessions: Array<{ terminalId: string; bufferLines: number; cols: number }>;
  /** Worker-side epoch ms when the sample was taken. */
  sampledAt: number;
}

export type AnalysisRequestResult = string | null | AnalysisFinalSnapshot;

export type WorkerToHostMessage =
  | { type: "ready" }
  | ({ type: "memory-sample" } & AnalysisWorkerMemorySample)
  | {
      /**
       * Batched flow-control ack: `bytes` of data-message payload (string
       * length, the same unit the host counts) have been fully parsed by this
       * terminal's mirror. The host decrements its outstanding-unacked counter
       * and releases held feeds once below the low watermark. `epoch` echoes
       * the slot generation the acked data belonged to — the host ignores acks
       * from a superseded generation so a late pre-reset ack can't debit the
       * fresh slot's ledger.
       */
      type: "data-ack";
      terminalId: string;
      bytes: number;
      epoch: number;
    }
  | {
      type: "activity-state";
      terminalId: string;
      spawnedAt: number;
      state: "busy" | "idle" | "completed";
      metadata?: ActivityStateMetadata;
    }
  | { type: "waiting-timeout"; terminalId: string; spawnedAt: number }
  | { type: "boot-complete"; terminalId: string; spawnedAt: number; timestamp: number }
  | { type: "pty-response"; terminalId: string; data: string }
  | { type: "viewport"; terminalId: string; lines: string[]; cursorLine: string | null }
  | {
      type: "response";
      requestId: number;
      terminalId: string;
      result: AnalysisRequestResult;
      error?: string;
      /** Echo of the request's worker generation; absent from legacy workers. */
      generation?: number;
    };
