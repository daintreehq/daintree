/**
 * PtyEventsBridge - Bridges PTY Host events to the internal event bus.
 *
 * Extracts domain routing from PtyClient, keeping it focused on transport + correlation.
 * This module handles forwarding agent state changes, terminal trashed/restored events,
 * and other domain-specific events to the appropriate consumers.
 */

import { events } from "../events.js";
import type { PtyHostEvent, TerminalFlowStatus } from "../../../shared/types/pty-host.js";
import type { AgentStateChangeTrigger } from "../../types/index.js";

export interface PtyEventsBridgeConfig {
  /** Called when terminal status changes for flow control visibility */
  onTerminalStatus?: (payload: {
    id: string;
    status: TerminalFlowStatus;
    bufferUtilization?: number;
    pauseDuration?: number;
    timestamp: number;
  }) => void;

  /** Called when host is throttled for memory pressure visibility */
  onHostThrottled?: (payload: {
    isThrottled: boolean;
    reason?: string;
    duration?: number;
    timestamp: number;
  }) => void;
}

const VALID_AGENT_STATE_CHANGE_TRIGGERS: ReadonlySet<AgentStateChangeTrigger> = new Set([
  "input",
  "output",
  "heuristic",
  "ai-classification",
  "timeout",
  "exit",
  "activity",
]);

function normalizeAgentTrigger(trigger: string): AgentStateChangeTrigger {
  if (VALID_AGENT_STATE_CHANGE_TRIGGERS.has(trigger as AgentStateChangeTrigger)) {
    return trigger as AgentStateChangeTrigger;
  }
  return "activity";
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    return 0.5;
  }
  if (confidence < 0) return 0;
  if (confidence > 1) return 1;
  return confidence;
}

/**
 * Bridge PTY Host events to the internal event bus.
 * Returns true if the event was handled as a domain event.
 */
export function bridgePtyEvent(event: PtyHostEvent, config?: PtyEventsBridgeConfig): boolean {
  switch (event.type) {
    case "agent-state":
      events.emit("agent:state-changed", {
        agentId: event.agentId,
        terminalId: event.id,
        state: event.state,
        previousState: event.previousState,
        timestamp: event.timestamp,
        traceId: event.traceId,
        trigger: normalizeAgentTrigger(event.trigger),
        confidence: normalizeConfidence(event.confidence),
        worktreeId: event.worktreeId,
      });
      return true;

    case "agent-detected":
      events.emit("agent:detected", {
        terminalId: event.terminalId,
        agentType: event.agentType,
        processName: event.processName,
        timestamp: event.timestamp,
      });
      return true;

    case "agent-exited":
      events.emit("agent:exited", {
        terminalId: event.terminalId,
        agentType: event.agentType,
        timestamp: event.timestamp,
      });
      return true;

    case "agent-spawned":
      events.emit("agent:spawned", event.payload);
      return true;

    case "agent-output":
      events.emit("agent:output", event.payload);
      return true;

    case "agent-completed":
      events.emit("agent:completed", event.payload);
      return true;

    case "agent-failed":
      events.emit("agent:failed", event.payload);
      return true;

    case "agent-killed":
      events.emit("agent:killed", event.payload);
      return true;

    case "terminal-trashed":
      events.emit("terminal:trashed", { id: event.id, expiresAt: event.expiresAt });
      return true;

    case "terminal-restored":
      events.emit("terminal:restored", { id: event.id });
      return true;

    case "terminal-status": {
      const statusPayload = {
        id: event.id,
        status: event.status,
        bufferUtilization: event.bufferUtilization,
        pauseDuration: event.pauseDuration,
        timestamp: event.timestamp,
      };
      events.emit("terminal:status", statusPayload);
      config?.onTerminalStatus?.(statusPayload);
      return true;
    }

    case "host-throttled":
      config?.onHostThrottled?.({
        isThrottled: event.isThrottled,
        reason: event.reason,
        duration: event.duration,
        timestamp: event.timestamp,
      });
      return true;

    case "terminal-reliability-metric":
      events.emit("terminal:reliability-metric", event.payload);
      return true;

    default:
      return false;
  }
}
