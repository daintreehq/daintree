/**
 * Type definitions for Semantic Analysis Web Worker communication.
 * Worker runs in browser context, polling a SharedArrayBuffer for terminal data.
 */

import type { AgentState, AgentStateChangeTrigger } from "./agent.js";
import type { Artifact } from "./ipc.js";

// Worker → Main Thread Messages

/** Artifact detected in terminal output */
export interface WorkerArtifactDetectedMessage {
  type: "ARTIFACT_DETECTED";
  terminalId: string;
  artifacts: Artifact[];
  timestamp: number;
}

/** Agent state transition detected */
export interface WorkerStateChangedMessage {
  type: "STATE_CHANGED";
  terminalId: string;
  agentId: string;
  state: AgentState;
  previousState: AgentState;
  timestamp: number;
  trigger: AgentStateChangeTrigger;
  confidence: number;
  worktreeId?: string;
  traceId?: string;
}

/** Worker initialization complete */
export interface WorkerReadyMessage {
  type: "READY";
}

/** Worker error (non-fatal) */
export interface WorkerErrorMessage {
  type: "ERROR";
  error: string;
  context?: string;
}

/** Worker health ping response */
export interface WorkerPongMessage {
  type: "PONG";
  timestamp: number;
  bufferUtilization?: number;
}

/** All messages from worker to main thread */
export type WorkerOutboundMessage =
  | WorkerArtifactDetectedMessage
  | WorkerStateChangedMessage
  | WorkerReadyMessage
  | WorkerErrorMessage
  | WorkerPongMessage;

// Main Thread → Worker Messages

/** Initialize worker with analysis buffer */
export interface MainInitBufferMessage {
  type: "INIT_BUFFER";
  buffer: SharedArrayBuffer;
}

/** Register a terminal for state tracking */
export interface MainRegisterTerminalMessage {
  type: "REGISTER_TERMINAL";
  terminalId: string;
  agentId?: string;
  worktreeId?: string;
  traceId?: string;
  initialState?: AgentState;
}

/** Unregister a terminal from state tracking */
export interface MainUnregisterTerminalMessage {
  type: "UNREGISTER_TERMINAL";
  terminalId: string;
}

/** Update terminal metadata (e.g., when agent spawns) */
export interface MainUpdateTerminalMessage {
  type: "UPDATE_TERMINAL";
  terminalId: string;
  agentId?: string;
  worktreeId?: string;
  traceId?: string;
}

/** Health check ping */
export interface MainPingMessage {
  type: "PING";
}

/** Reset parser state (e.g., on project switch) */
export interface MainResetMessage {
  type: "RESET";
}

/** All messages from main thread to worker */
export type WorkerInboundMessage =
  | MainInitBufferMessage
  | MainRegisterTerminalMessage
  | MainUnregisterTerminalMessage
  | MainUpdateTerminalMessage
  | MainPingMessage
  | MainResetMessage;

// Terminal state tracking within worker

/** Per-terminal analysis state maintained in worker */
export interface WorkerTerminalState {
  terminalId: string;
  agentId?: string;
  worktreeId?: string;
  traceId?: string;
  agentState: AgentState;
  /** Sliding window buffer for multi-chunk artifact detection (last 5KB) */
  analysisBuffer: string;
  /** Previously detected artifact IDs to avoid duplicates (max 1000 IDs) */
  seenArtifactIds: Set<string>;
}
