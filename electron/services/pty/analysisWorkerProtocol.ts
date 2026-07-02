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
  | { type: "request"; requestId: number; terminalId: string; op: AnalysisRequestOp };

export interface AnalysisFinalSnapshot {
  /** Full-buffer serialize (banner included) for the preserved snapshot. */
  snapshot: string | null;
  /** Banner-stripped serialize for on-disk session persistence. */
  persistence: string | null;
}

export type AnalysisRequestResult = string | null | AnalysisFinalSnapshot;

export type WorkerToHostMessage =
  | { type: "ready" }
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
    };
