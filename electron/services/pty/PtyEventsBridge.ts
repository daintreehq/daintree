/**
 * PtyEventsBridge - Bridges PTY Host events to the internal event bus.
 *
 * Extracts domain routing from PtyClient, keeping it focused on transport + correlation.
 * This module handles forwarding agent state changes, terminal trashed/restored events,
 * and other domain-specific events to the appropriate consumers.
 */

import { events } from "../events.js";
import { isHostThrowawayTerminalId } from "../../../shared/config/hostThrowaway.js";
import {
  HANDBACK_CODE_PATTERN,
  HANDBACK_MESSAGE_MAX_CHARS,
} from "../../../shared/types/handback.js";
import type { PtyHostEvent, TerminalFlowStatus } from "../../../shared/types/pty-host.js";
import type { AgentStateChangeTrigger } from "../../types/index.js";
import type {
  AgentFallbackReason,
  AgentFallbackTriggeredPayload,
} from "../../../shared/types/ipc/agent.js";

const FALLBACK_REASONS: ReadonlySet<AgentFallbackReason> = new Set([
  "connection",
  "auth",
  "rate-limit",
]);

export interface PtyEventsBridgeConfig {
  /** Called when terminal status changes for flow control visibility */
  onTerminalStatus?: (payload: {
    id: string;
    status: TerminalFlowStatus;
    bufferUtilization?: number;
    pauseDuration?: number;
    reason?: string;
    droppedBytes?: number;
    timestamp: number;
  }) => void;

  /** Called when host is throttled for memory pressure visibility */
  onHostThrottled?: (payload: {
    isThrottled: boolean;
    reason?: string;
    duration?: number;
    forced?: boolean;
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
  "title",
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

/** The terminal an agent event is about, wherever its shape carries it. */
function agentEventTerminalId(event: PtyHostEvent): string {
  const fields = event as {
    id?: unknown;
    terminalId?: unknown;
    payload?: { terminalId?: unknown };
  };
  const id = fields.id ?? fields.terminalId ?? fields.payload?.terminalId;
  return typeof id === "string" ? id : "";
}

/**
 * Bridge PTY Host events to the internal event bus.
 * Returns true if the event was handled as a domain event.
 */
export function bridgePtyEvent(event: PtyHostEvent, config?: PtyEventsBridgeConfig): boolean {
  // A host's throwaway run (#14445) is its Shell session's alone: none of its
  // agent's observations reach the bus, so no renderer, notification, sound or
  // Shell notice ever hears of it.
  if (event.type.startsWith("agent-") && isHostThrowawayTerminalId(agentEventTerminalId(event))) {
    return true;
  }
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
        cwd: event.cwd,
        waitingReason: event.waitingReason,
        sessionCost: event.sessionCost,
        sessionTokens: event.sessionTokens,
        ...(event.agentIncarnation !== undefined
          ? { agentIncarnation: event.agentIncarnation }
          : {}),
        // Exit metadata on completed/exited transitions. exitCode may be null
        // (signal kill), so forward on presence rather than truthiness. #10638
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.exitSignal !== undefined ? { exitSignal: event.exitSignal } : {}),
        // Live temperature fields, only present when the activity detector
        // drove the transition. Spread conditionally to keep the bus payload
        // minimal when the activity path didn't fire.
        ...(event.temperature !== undefined ? { temperature: event.temperature } : {}),
        ...(event.heatAdded !== undefined ? { heatAdded: event.heatAdded } : {}),
        ...(event.changedChars !== undefined ? { changedChars: event.changedChars } : {}),
        ...(event.lastHandback ? { lastHandback: event.lastHandback } : {}),
      });
      return true;

    case "agent-state-transition-dropped":
      events.emit("agent:state-transition-dropped", {
        terminalId: event.id,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        outcome: event.outcome,
        currentState: event.currentState,
        ...(event.attemptedState !== undefined ? { attemptedState: event.attemptedState } : {}),
        ...(event.trigger !== undefined ? { trigger: normalizeAgentTrigger(event.trigger) } : {}),
        ...(event.confidence !== undefined
          ? { confidence: normalizeConfidence(event.confidence) }
          : {}),
        ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
        ...(event.spawnedAt !== undefined ? { spawnedAt: event.spawnedAt } : {}),
        ...(event.terminalSpawnedAt !== undefined
          ? { terminalSpawnedAt: event.terminalSpawnedAt }
          : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.validationErrors !== undefined
          ? { validationErrors: event.validationErrors }
          : {}),
        ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
        timestamp: event.timestamp,
      });
      return true;

    case "agent-handback-observed":
      events.emit("agent:handback-observed", {
        terminalId: event.terminalId,
        handback: event.handback,
        // Crossed a process boundary, so only a well-formed code is passed on.
        ...(typeof event.code === "string" && HANDBACK_CODE_PATTERN.test(event.code)
          ? { code: event.code }
          : {}),
        ...(typeof event.lastStateChange === "number" && Number.isFinite(event.lastStateChange)
          ? { lastStateChange: event.lastStateChange }
          : {}),
        timestamp: event.timestamp,
      });
      return true;

    case "agent-run-handback-observed": {
      // Crossed a process boundary and settles a durable run, so only a
      // well-formed report is passed on.
      const { terminalId, spawnedAt, code, report, message, truncated, observedAt } = event;
      if (
        typeof spawnedAt !== "number" ||
        !Number.isFinite(spawnedAt) ||
        typeof code !== "string" ||
        !HANDBACK_CODE_PATTERN.test(code) ||
        (report !== "done" && report !== "needs-you") ||
        (message !== null &&
          (typeof message !== "string" || message.length > HANDBACK_MESSAGE_MAX_CHARS)) ||
        typeof truncated !== "boolean" ||
        typeof observedAt !== "number" ||
        !Number.isFinite(observedAt)
      ) {
        return true;
      }
      events.emit("agent:run-handback-observed", {
        terminalId,
        spawnedAt,
        code,
        report,
        message,
        truncated,
        observedAt,
        timestamp: event.timestamp,
      });
      return true;
    }

    case "agent-rate-limit-observed":
      events.emit("agent:rate-limit-observed", {
        terminalId: event.terminalId,
        observedAt: event.observedAt,
        timestamp: event.timestamp,
      });
      return true;

    case "agent-fallback-triggered": {
      // Crossed a process boundary, and the renderer may end a live pane on it.
      const p = event.payload as Partial<AgentFallbackTriggeredPayload> | null;
      if (
        !p ||
        typeof p !== "object" ||
        !p.reason ||
        !FALLBACK_REASONS.has(p.reason) ||
        typeof p.terminalId !== "string" ||
        typeof p.agentId !== "string" ||
        typeof p.fromPresetId !== "string" ||
        typeof p.timestamp !== "number" ||
        !Number.isFinite(p.timestamp)
      ) {
        return true;
      }
      events.emit("agent:fallback-triggered", {
        terminalId: p.terminalId,
        agentId: p.agentId,
        fromPresetId: p.fromPresetId,
        ...(typeof p.originalPresetId === "string" ? { originalPresetId: p.originalPresetId } : {}),
        reason: p.reason,
        ...(Number.isInteger(p.exitCode) ? { exitCode: p.exitCode } : {}),
        timestamp: p.timestamp,
      });
      return true;
    }

    case "agent-detected":
      events.emit("agent:detected", {
        terminalId: event.terminalId,
        agentType: event.agentType,
        processIconId: event.processIconId,
        processName: event.processName,
        timestamp: event.timestamp,
        ...(event.agentIncarnation !== undefined
          ? { agentIncarnation: event.agentIncarnation }
          : {}),
      });
      return true;

    case "agent-exited":
      events.emit("agent:exited", {
        terminalId: event.terminalId,
        agentType: event.agentType,
        timestamp: event.timestamp,
        exitKind: event.exitKind,
        ...(event.agentEnd ? { agentEnd: event.agentEnd } : {}),
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

    case "agent-killed":
      events.emit("agent:killed", event.payload);
      return true;

    case "terminal-trashed":
      events.emit("terminal:trashed", { id: event.id, expiresAt: event.expiresAt });
      return true;

    case "terminal-restored":
      events.emit("terminal:restored", { id: event.id });
      return true;

    case "terminal-trash-cleared":
      events.emit("terminal:trash-cleared", { id: event.id, expiresAt: event.expiresAt });
      return true;

    case "agent-session-captured":
      events.emit("agent-session:captured", {
        terminalId: event.terminalId,
        launchGeneration: event.launchGeneration,
        boundary: event.boundary,
        record: event.record,
        ...(event.run ? { run: event.run } : {}),
      });
      return true;

    case "agent-session-observed":
      events.emit("agent-session:observed", {
        terminalId: event.terminalId,
        agentId: event.agentId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        run: event.run,
      });
      return true;

    case "terminal-status": {
      const statusPayload = {
        id: event.id,
        status: event.status,
        bufferUtilization: event.bufferUtilization,
        pauseDuration: event.pauseDuration,
        reason: event.reason,
        droppedBytes: event.droppedBytes,
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
        forced: event.forced,
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
