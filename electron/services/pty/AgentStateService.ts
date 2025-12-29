import { events } from "../events.js";
import { nextAgentState, getStateChangeTimestamp, type AgentEvent } from "../AgentStateMachine.js";
// AgentState type used implicitly via TerminalInfo.agentState
import {
  AgentStateChangedSchema,
  AgentFailedSchema,
  AgentCompletedSchema,
  AgentKilledSchema,
  type AgentStateChangeTrigger,
} from "../../schemas/agent.js";
import type { TerminalInfo } from "./types.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";

/**
 * Service responsible for agent state machine logic and event emission.
 * Handles state transitions, trigger inference, and emits validated agent events.
 */
export class AgentStateService {
  private headlineGenerator = new ActivityHeadlineGenerator();

  inferTrigger(event: AgentEvent): AgentStateChangeTrigger {
    switch (event.type) {
      case "input":
        return "input";
      case "output":
        return "output";
      case "busy":
        return "activity";
      case "prompt":
        return "activity";
      case "exit":
        return "exit";
      case "start":
        return "activity";
      case "error":
        return "activity";
      default:
        return "output";
    }
  }

  /**
   * Infer confidence level based on event type and trigger.
   */
  inferConfidence(event: AgentEvent, trigger: AgentStateChangeTrigger): number {
    if (trigger === "input" || trigger === "exit") {
      return 1.0;
    }

    if (trigger === "output") {
      return 1.0;
    }

    if (trigger === "activity") {
      return 1.0;
    }

    if (trigger === "heuristic") {
      if (event.type === "busy") {
        return 0.9;
      }
      if (event.type === "prompt") {
        return 0.75;
      }
      if (event.type === "start") {
        return 0.7;
      }
      if (event.type === "error") {
        return 0.65;
      }
    }

    if (trigger === "ai-classification") {
      return 0.85;
    }

    if (trigger === "timeout") {
      return 0.6;
    }

    return 0.5;
  }

  /**
   * Update agent state based on an event.
   * Emits state change events and specific completion/failure events.
   * Returns true if state changed, false otherwise.
   */
  updateAgentState(
    terminal: TerminalInfo,
    event: AgentEvent,
    trigger?: AgentStateChangeTrigger,
    confidence?: number
  ): boolean {
    if (!terminal.agentId) {
      return false;
    }

    const previousState = terminal.agentState || "idle";
    const newState = nextAgentState(previousState, event);

    // Update error message even if staying in failed state
    if (event.type === "error") {
      terminal.error = event.error;
    }

    if (newState === previousState) {
      return false;
    }

    terminal.agentState = newState;
    terminal.lastStateChange = getStateChangeTimestamp();

    const inferredTrigger = trigger ?? this.inferTrigger(event);
    const inferredConfidence = confidence ?? this.inferConfidence(event, inferredTrigger);

    // Build and validate state change payload
    const stateChangePayload = {
      agentId: terminal.agentId,
      state: newState,
      previousState,
      timestamp: terminal.lastStateChange,
      traceId: terminal.traceId,
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId,
      trigger: inferredTrigger,
      confidence: inferredConfidence,
    };

    const validatedStateChange = AgentStateChangedSchema.safeParse(stateChangePayload);
    if (validatedStateChange.success) {
      events.emit("agent:state-changed", validatedStateChange.data);
    } else {
      console.error(
        "[AgentStateService] Invalid agent:state-changed payload:",
        validatedStateChange.error.format()
      );
    }

    // Emit terminal activity event for UI headline updates
    this.emitTerminalActivity(terminal);

    // Emit specific failure event
    if (newState === "failed" && event.type === "error") {
      this.emitAgentFailed(terminal, event.error);
    }

    return true;
  }

  /**
   * Transition agent state from an external observer.
   * Validates session token to prevent stale observations.
   */
  transitionState(
    terminal: TerminalInfo,
    event: AgentEvent,
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): boolean {
    // Validate session token if provided
    if (spawnedAt !== undefined && terminal.spawnedAt !== spawnedAt) {
      if (process.env.CANOPY_VERBOSE) {
        console.log(
          `[AgentStateService] Rejected stale state transition for ${terminal.id} ` +
            `(session ${spawnedAt} vs current ${terminal.spawnedAt})`
        );
      }
      return false;
    }

    return this.updateAgentState(terminal, event, trigger, confidence);
  }

  emitAgentFailed(terminal: TerminalInfo, error: string): void {
    if (!terminal.agentId || !terminal.lastStateChange) {
      return;
    }

    const failedPayload = {
      agentId: terminal.agentId,
      error,
      timestamp: terminal.lastStateChange,
      traceId: terminal.traceId,
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId,
    };

    const validatedFailed = AgentFailedSchema.safeParse(failedPayload);
    if (validatedFailed.success) {
      events.emit("agent:failed", validatedFailed.data);
    } else {
      console.error(
        "[AgentStateService] Invalid agent:failed payload:",
        validatedFailed.error.format()
      );
    }
  }

  emitAgentCompleted(terminal: TerminalInfo, exitCode: number): void {
    if (!terminal.agentId) {
      return;
    }

    const completedAt = Date.now();
    const duration = completedAt - terminal.spawnedAt;

    const completedPayload = {
      agentId: terminal.agentId,
      exitCode,
      duration,
      timestamp: completedAt,
      traceId: terminal.traceId,
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId,
    };

    const validatedCompleted = AgentCompletedSchema.safeParse(completedPayload);
    if (validatedCompleted.success) {
      events.emit("agent:completed", validatedCompleted.data);
    } else {
      console.error(
        "[AgentStateService] Invalid agent:completed payload:",
        validatedCompleted.error.format()
      );
    }
  }

  emitAgentKilled(terminal: TerminalInfo, reason?: string): void {
    if (!terminal.agentId) {
      return;
    }

    const killedPayload = {
      agentId: terminal.agentId,
      reason,
      timestamp: Date.now(),
      traceId: terminal.traceId,
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId,
    };

    const validatedKilled = AgentKilledSchema.safeParse(killedPayload);
    if (validatedKilled.success) {
      events.emit("agent:killed", validatedKilled.data);
    } else {
      console.error(
        "[AgentStateService] Invalid agent:killed payload:",
        validatedKilled.error.format()
      );
    }
  }

  /**
   * Convert activity state to agent event and trigger state update.
   */
  handleActivityState(
    terminal: TerminalInfo,
    activity: "busy" | "idle",
    metadata?: { trigger: "input" | "output" | "pattern"; patternConfidence?: number }
  ): void {
    if (!terminal.agentId) {
      return;
    }

    const event: AgentEvent = activity === "busy" ? { type: "busy" } : { type: "prompt" };

    if (metadata?.trigger === "pattern") {
      // Pattern-based detection has its own confidence
      const confidence = metadata.patternConfidence ?? 0.9;
      this.updateAgentState(terminal, event, "heuristic", confidence);
    } else if (metadata?.trigger === "output") {
      this.updateAgentState(terminal, event, "output", 1.0);
    } else if (metadata?.trigger === "input") {
      this.updateAgentState(terminal, event, "input", 1.0);
    } else {
      this.updateAgentState(terminal, event, "activity", 1.0);
    }
  }

  emitTerminalActivity(terminal: TerminalInfo): void {
    const { headline, status, type } = this.headlineGenerator.generate({
      terminalId: terminal.id,
      terminalType: terminal.type,
      agentId: terminal.agentId,
      agentState: terminal.agentState,
    });

    events.emit("terminal:activity", {
      terminalId: terminal.id,
      headline,
      status,
      type,
      confidence: 1.0,
      timestamp: Date.now(),
      worktreeId: terminal.worktreeId,
      // lastCommand is only populated for shell terminals currently
      lastCommand: undefined,
    });
  }
}
