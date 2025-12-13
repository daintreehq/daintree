/**
 * Semantic Analysis Web Worker
 *
 * Polls a SharedArrayBuffer ring buffer for terminal data and performs
 * artifact extraction and agent state detection in a background thread.
 * This keeps the main renderer thread free for 60fps terminal rendering.
 */

import { SharedRingBuffer, PacketParser } from "../../shared/utils/SharedRingBuffer.js";
import { extractArtifacts, stripAnsiCodes } from "./WorkerArtifactExtractor.js";
import {
  calculateStateChange,
  createTerminalState,
  pruneSeenArtifacts,
  type AgentEvent,
} from "./WorkerAgentStateService.js";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  WorkerTerminalState,
} from "../../shared/types/worker-messages.js";

const ACTIVE_POLL_MS = 20; // 50Hz when receiving data
const IDLE_INTERVALS = [50, 100, 250] as const; // Progressive backoff when idle
const MAX_ANALYSIS_BUFFER_SIZE = 5000; // 5KB sliding window per terminal

let ringBuffer: SharedRingBuffer | null = null;
let idleLevel = 0;
const packetParser = new PacketParser();
const terminalStates = new Map<string, WorkerTerminalState>();
let isPolling = false;

/**
 * Send a typed message to the main thread.
 */
function postTypedMessage(message: WorkerOutboundMessage): void {
  self.postMessage(message);
}

/**
 * Process a single packet from the ring buffer.
 */
async function processPacket(terminalId: string, data: string): Promise<void> {
  // Get or create terminal state
  let state = terminalStates.get(terminalId);
  if (!state) {
    // Auto-register terminal if not explicitly registered
    state = createTerminalState(terminalId);
    terminalStates.set(terminalId, state);
  }

  // Strip ANSI codes for analysis (terminal renders them but they interfere with parsing)
  const cleanData = stripAnsiCodes(data);

  // Maintain sliding window for artifact detection
  state.analysisBuffer = (state.analysisBuffer + cleanData).slice(-MAX_ANALYSIS_BUFFER_SIZE);

  // Extract artifacts asynchronously (uses Web Crypto API)
  try {
    const artifacts = await extractArtifacts(state.analysisBuffer, state.seenArtifactIds);
    if (artifacts.length > 0) {
      postTypedMessage({
        type: "ARTIFACT_DETECTED",
        terminalId,
        artifacts,
        timestamp: Date.now(),
      });
    }

    // Prune seen artifact IDs to prevent unbounded growth
    pruneSeenArtifacts(state.seenArtifactIds);
  } catch (error) {
    postTypedMessage({
      type: "ERROR",
      error: error instanceof Error ? error.message : String(error),
      context: "artifact extraction",
    });
  }

  // Check for state changes if terminal has an agent
  if (state.agentId) {
    // Generate event based on receiving output
    const event: AgentEvent = { type: "busy" };
    const stateChange = calculateStateChange(state, event);

    if (stateChange) {
      // Update local state
      state.agentState = stateChange.state;

      postTypedMessage({
        type: "STATE_CHANGED",
        terminalId: stateChange.terminalId,
        agentId: stateChange.agentId,
        state: stateChange.state,
        previousState: stateChange.previousState,
        timestamp: stateChange.timestamp,
        trigger: stateChange.trigger,
        confidence: stateChange.confidence,
        worktreeId: stateChange.worktreeId,
        traceId: stateChange.traceId,
      });
    }
  }
}

/**
 * Schedule the next poll with adaptive timing.
 * Backs off progressively when no data is being received.
 */
function scheduleNext(hadData: boolean): void {
  if (!isPolling) return;
  idleLevel = hadData ? 0 : Math.min(idleLevel + 1, IDLE_INTERVALS.length - 1);
  const ms = hadData ? ACTIVE_POLL_MS : IDLE_INTERVALS[idleLevel];
  setTimeout(pollBuffer, ms);
}

/**
 * Poll the ring buffer for new data.
 */
async function pollBuffer(): Promise<void> {
  if (!ringBuffer || !isPolling) return;

  let hadData = false;
  try {
    // Read all available data from the ring buffer
    const rawData = ringBuffer.read();

    if (rawData) {
      hadData = true;
      // Parse framed packets (handles partial packets across reads)
      const packets = packetParser.parse(rawData);

      // Group packets by terminal ID to enable concurrent processing per terminal
      const packetsByTerminal = new Map<string, string[]>();
      for (const packet of packets) {
        let terminalPackets = packetsByTerminal.get(packet.id);
        if (!terminalPackets) {
          terminalPackets = [];
          packetsByTerminal.set(packet.id, terminalPackets);
        }
        terminalPackets.push(packet.data);
      }

      // Process each terminal's packets concurrently
      await Promise.all(
        Array.from(packetsByTerminal.entries()).map(async ([terminalId, dataChunks]) => {
          // Process chunks for this terminal sequentially to maintain state order
          for (const data of dataChunks) {
            await processPacket(terminalId, data);
          }
        })
      );
    }
  } catch (error) {
    // Log error but don't stop polling loop
    postTypedMessage({
      type: "ERROR",
      error: error instanceof Error ? error.message : String(error),
      context: "polling loop",
    });
  } finally {
    scheduleNext(hadData);
  }
}

// Handle unhandled rejections to prevent silent failures
self.onunhandledrejection = (event: PromiseRejectionEvent) => {
  postTypedMessage({
    type: "ERROR",
    error: event.reason instanceof Error ? event.reason.message : String(event.reason),
    context: "unhandled rejection",
  });
};

/**
 * Start the polling loop.
 */
function startPolling(): void {
  if (isPolling) return;
  isPolling = true;
  pollBuffer();
}

/**
 * Handle messages from the main thread.
 */
self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "INIT_BUFFER":
      try {
        ringBuffer = new SharedRingBuffer(message.buffer);
        packetParser.reset();
        idleLevel = 0;
        startPolling();
        postTypedMessage({ type: "READY" });
      } catch (error) {
        postTypedMessage({
          type: "ERROR",
          error: error instanceof Error ? error.message : String(error),
          context: "buffer initialization",
        });
      }
      break;

    case "REGISTER_TERMINAL":
      terminalStates.set(
        message.terminalId,
        createTerminalState(
          message.terminalId,
          message.agentId,
          message.worktreeId,
          message.traceId,
          message.initialState
        )
      );
      break;

    case "UNREGISTER_TERMINAL":
      terminalStates.delete(message.terminalId);
      break;

    case "UPDATE_TERMINAL": {
      const state = terminalStates.get(message.terminalId);
      if (state) {
        if (message.agentId !== undefined) state.agentId = message.agentId;
        if (message.worktreeId !== undefined) state.worktreeId = message.worktreeId;
        if (message.traceId !== undefined) state.traceId = message.traceId;
      }
      break;
    }

    case "PING":
      postTypedMessage({
        type: "PONG",
        timestamp: Date.now(),
        bufferUtilization: ringBuffer?.getUtilization(),
      });
      break;

    case "RESET":
      // Clear all state (e.g., on project switch)
      terminalStates.clear();
      packetParser.reset();
      idleLevel = 0;
      break;
  }
};

// Handle worker errors
self.onerror = (event: Event | string) => {
  const errorMessage =
    typeof event === "string" ? event : ((event as ErrorEvent).message ?? "Unknown worker error");
  postTypedMessage({
    type: "ERROR",
    error: errorMessage,
    context: "worker error",
  });
};
