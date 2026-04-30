import { events } from "../events.js";
import { nextAgentState, getStateChangeTimestamp, type AgentEvent } from "../AgentStateMachine.js";
// AgentState type used implicitly via TerminalInfo.agentState
import {
  AgentStateChangedSchema,
  AgentCompletedSchema,
  AgentKilledSchema,
  type AgentStateChangeTrigger,
} from "../../schemas/agent.js";
import type { TerminalInfo } from "./types.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import type { WaitingReason } from "../../../shared/types/agent.js";

// Backend-side identity used when routing agent-state events (who is this
// event about?). Detection wins; during the boot window the launch hint is
// used so a cold-launched agent's first state transitions carry a stable
// agentType.
function getLiveAgentId(terminal: TerminalInfo): string | undefined {
  return terminal.detectedAgentId ?? terminal.launchAgentId;
}

/**
 * Service responsible for agent state machine logic and event emission.
 * Handles state transitions, trigger inference, and emits validated agent events.
 */
export class AgentStateService {
  private headlineGenerator = new ActivityHeadlineGenerator();

  private normalizeConfidence(confidence: number): number {
    if (!Number.isFinite(confidence)) {
      return 0.5;
    }
    if (confidence < 0) return 0;
    if (confidence > 1) return 1;
    return confidence;
  }

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
      case "kill":
        return "exit";
      case "start":
        return "activity";
      case "error":
        return "activity";
      case "completion":
        return "activity";
      case "respawn":
        return "activity";
      case "watchdog-timeout":
        return "timeout";
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
    confidence?: number,
    waitingReason?: WaitingReason,
    sessionCost?: number,
    sessionTokens?: number
  ): boolean {
    // Detection wins; fall back to the launch hint during the boot window.
    const effectiveAgentId = terminal.detectedAgentId ?? terminal.launchAgentId;
    if (!effectiveAgentId) {
      return false;
    }

    const previousState = terminal.agentState || "idle";
    const newState = nextAgentState(previousState, event);

    if (newState === previousState) {
      // Allow waitingReason updates within the same "waiting" state
      if (
        newState === "waiting" &&
        waitingReason !== undefined &&
        waitingReason !== terminal.waitingReason
      ) {
        terminal.waitingReason = waitingReason;

        const inferredTrigger = trigger ?? this.inferTrigger(event);
        const inferredConfidence = this.normalizeConfidence(
          confidence ?? this.inferConfidence(event, inferredTrigger)
        );

        const stateChangePayload = {
          agentId: effectiveAgentId,
          state: newState,
          previousState,
          timestamp: getStateChangeTimestamp(),
          traceId: terminal.traceId,
          terminalId: terminal.id,
          cwd: terminal.cwd,
          trigger: inferredTrigger,
          confidence: inferredConfidence,
          waitingReason,
        };

        const validated = AgentStateChangedSchema.safeParse(stateChangePayload);
        if (validated.success) {
          events.emit("agent:state-changed", validated.data);
        }

        this.emitTerminalActivity(terminal);
        return true;
      }
      return false;
    }

    terminal.agentState = newState;
    terminal.lastStateChange = getStateChangeTimestamp();

    // Store/clear waitingReason on terminal
    if (newState === "waiting") {
      terminal.waitingReason = waitingReason;
    } else {
      terminal.waitingReason = undefined;
    }

    const inferredTrigger = trigger ?? this.inferTrigger(event);
    const inferredConfidence = this.normalizeConfidence(
      confidence ?? this.inferConfidence(event, inferredTrigger)
    );

    // Build and validate state change payload
    const stateChangePayload = {
      agentId: effectiveAgentId,
      state: newState,
      previousState,
      timestamp: terminal.lastStateChange,
      traceId: terminal.traceId,
      terminalId: terminal.id,
      cwd: terminal.cwd,
      trigger: inferredTrigger,
      confidence: inferredConfidence,
      ...(newState === "waiting" && waitingReason ? { waitingReason } : {}),
      ...((newState === "completed" || newState === "exited") && sessionCost != null
        ? { sessionCost }
        : {}),
      ...((newState === "completed" || newState === "exited") && sessionTokens != null
        ? { sessionTokens }
        : {}),
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
      if (process.env.DAINTREE_VERBOSE) {
        console.log(
          `[AgentStateService] Rejected stale state transition for ${terminal.id} ` +
            `(session ${spawnedAt} vs current ${terminal.spawnedAt})`
        );
      }
      return false;
    }

    return this.updateAgentState(terminal, event, trigger, confidence);
  }

  emitAgentCompleted(terminal: TerminalInfo, exitCode: number): void {
    const liveAgentId = getLiveAgentId(terminal);
    if (!liveAgentId) {
      return;
    }

    const completedAt = Date.now();
    const duration = Math.max(0, completedAt - terminal.spawnedAt);

    const completedPayload = {
      agentId: liveAgentId,
      exitCode,
      duration,
      timestamp: completedAt,
      traceId: terminal.traceId,
      terminalId: terminal.id,
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
    const liveAgentId = getLiveAgentId(terminal);
    if (!liveAgentId) {
      return;
    }

    const killedPayload = {
      agentId: liveAgentId,
      reason,
      timestamp: Date.now(),
      traceId: terminal.traceId,
      terminalId: terminal.id,
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
    activity: "busy" | "idle" | "completed",
    metadata?: {
      trigger: "input" | "output" | "pattern" | "timeout" | "dispose";
      patternConfidence?: number;
      waitingReason?: WaitingReason;
      sessionCost?: number;
      sessionTokens?: number;
    }
  ): void {
    if (!terminal.detectedAgentId && !terminal.launchAgentId) {
      return;
    }

    const event: AgentEvent =
      activity === "busy"
        ? metadata?.trigger === "input"
          ? { type: "input" }
          : { type: "busy" }
        : activity === "completed"
          ? { type: "completion" }
          : { type: "prompt" };

    if (metadata?.trigger === "timeout") {
      this.updateAgentState(terminal, event, "timeout", 0.6, metadata?.waitingReason);
    } else if (metadata?.trigger === "pattern") {
      const confidence = metadata.patternConfidence ?? 0.9;
      this.updateAgentState(
        terminal,
        event,
        "heuristic",
        confidence,
        metadata?.waitingReason,
        metadata?.sessionCost,
        metadata?.sessionTokens
      );
    } else if (metadata?.trigger === "output") {
      this.updateAgentState(terminal, event, "output", 1.0, metadata?.waitingReason);
    } else if (metadata?.trigger === "input") {
      this.updateAgentState(terminal, event, "input", 1.0, metadata?.waitingReason);
    } else {
      this.updateAgentState(terminal, event, "activity", 1.0, metadata?.waitingReason);
    }
  }

  emitTerminalActivity(terminal: TerminalInfo): void {
    const { headline, status, type } = this.headlineGenerator.generate({
      terminalId: terminal.id,
      agentId: terminal.detectedAgentId ?? terminal.launchAgentId,
      agentState: terminal.agentState,
      waitingReason: terminal.waitingReason,
    });

    events.emit("terminal:activity", {
      terminalId: terminal.id,
      headline,
      status,
      type,
      confidence: 1.0,
      timestamp: Date.now(),
      // lastCommand is only populated for shell terminals currently
      lastCommand: undefined,
    });
  }
}
