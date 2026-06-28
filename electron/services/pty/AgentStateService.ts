import { z } from "zod/mini";
import { events } from "../events.js";
import { nextAgentState, getStateChangeTimestamp, type AgentEvent } from "../AgentStateMachine.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
// AgentState type used implicitly via TerminalInfo.agentState
import {
  AgentStateChangedSchema,
  AgentStateTransitionDroppedSchema,
  AgentCompletedSchema,
  AgentKilledSchema,
  type AgentStateChangeTrigger,
  type AgentStateTransitionDropReason,
} from "../../schemas/agent.js";

import type { AgentActivityObservationResult } from "./AgentActivityTemperature.js";
import type { TerminalInfo } from "./types.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import { checkResultsEqual, detectCheckResult } from "./CheckResultDetector.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalCheckResult } from "../../../shared/types/checkResult.js";

// States where the agent has just settled out of "working" — the moment a
// just-finished check's summary lines sit at the tail of the semantic buffer.
const CHECK_SETTLE_STATES: ReadonlySet<AgentState> = new Set([
  "idle",
  "waiting",
  "completed",
  "exited",
]);

// Hysteresis tunables. Window is conservative — long enough to absorb
// sub-second flip races (timeout/heuristic firing right after input/output)
// without masking real direction changes (LLM output gaps run 1–5s).
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const HYSTERESIS_WINDOW_MS = 500;

// Direction grouping for hysteresis. "active" = agent is producing work;
// "passive" = agent is paused/done. A low-confidence cross between groups
// inside the window is what we suppress. Note this is intentionally distinct
// from `ACTIVE_AGENT_STATES` in shared/types/agent.ts, which classifies
// states by "agent still present" (used for close-confirmation/eviction).
function getStateGroup(state: AgentState): "active" | "passive" {
  switch (state) {
    case "working":
    case "directing":
      return "active";
    case "idle":
    case "waiting":
    case "completed":
    case "exited":
      return "passive";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function isOppositeDirectionTransition(from: AgentState, to: AgentState): boolean {
  return getStateGroup(from) !== getStateGroup(to);
}

// Lifecycle events bypass hysteresis entirely — exit/kill/respawn are
// authoritative signals, not confidence estimates. Suppressing one could
// strand the UI on "working" after the agent has already terminated.
function isLifecycleEvent(event: AgentEvent): boolean {
  return event.type === "exit" || event.type === "kill" || event.type === "respawn";
}

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

  /**
   * Best-effort diagnostic emit. Wraps `events.emit` in try/catch — diagnostics
   * must never break detection (lesson #1317). Failures are logged but do not
   * propagate. Returns true on a successful, schema-valid emit.
   */
  private emitTransitionDropped(
    terminal: TerminalInfo,
    payload: {
      outcome: AgentStateTransitionDropReason;
      currentState: AgentState;
      attemptedState?: AgentState;
      trigger?: AgentStateChangeTrigger;
      confidence?: number;
      cwd?: string;
      spawnedAt?: number;
      terminalSpawnedAt?: number;
      reason?: string;
      validationErrors?: string[];
    }
  ): void {
    const effectiveAgentId = terminal.detectedAgentId ?? terminal.launchAgentId;
    const dropPayload = {
      terminalId: terminal.id,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      ...(terminal.worktreeId ? { worktreeId: terminal.worktreeId } : {}),
      ...(terminal.traceId ? { traceId: terminal.traceId } : {}),
      timestamp: Date.now(),
      ...payload,
    };
    const validated = AgentStateTransitionDroppedSchema.safeParse(dropPayload);
    if (!validated.success) {
      console.error(
        "[AgentStateService] Invalid agent:state-transition-dropped payload:",
        z.prettifyError(validated.error)
      );
      return;
    }
    try {
      events.emit("agent:state-transition-dropped", validated.data);
    } catch (err) {
      console.error(
        "[AgentStateService] Failed to emit agent:state-transition-dropped:",
        formatErrorMessage(err, "unknown emit failure")
      );
    }
  }

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
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
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
   *
   * The optional `temperature` argument carries the live `AgentActivityTemperature`
   * observation that drove this transition (only the activity-detector path
   * has one — `transitionState` callers pass `undefined`). When present, the
   * `temperature`/`heatAdded`/`changedChars` fields are attached to the emitted
   * `agent:state-changed` event for diagnostics; the `suppressed` flag is
   * intentionally NOT carried (resize-quiet signal, separate semantics).
   */
  updateAgentState(
    terminal: TerminalInfo,
    event: AgentEvent,
    trigger?: AgentStateChangeTrigger,
    confidence?: number,
    waitingReason?: WaitingReason,
    sessionCost?: number,
    sessionTokens?: number,
    temperature?: AgentActivityObservationResult
  ): boolean {
    // Detection wins; fall back to the launch hint during the boot window.
    // May be undefined for runtime-detected-only flows; consumers fall back to
    // terminalId for routing.
    const effectiveAgentId = terminal.detectedAgentId ?? terminal.launchAgentId;

    const previousState = terminal.agentState || "idle";
    const newState = nextAgentState(previousState, event);

    if (newState === previousState) {
      this.emitTransitionDropped(terminal, {
        outcome: "no-op",
        currentState: previousState,
        attemptedState: newState,
        ...(trigger ? { trigger } : {}),
        ...(confidence !== undefined ? { confidence: this.normalizeConfidence(confidence) } : {}),
      });
      return false;
    }

    const inferredTrigger = trigger ?? this.inferTrigger(event);
    const inferredConfidence = this.normalizeConfidence(
      confidence ?? this.inferConfidence(event, inferredTrigger)
    );

    // Hysteresis guard: drop opposite-direction low-confidence transitions
    // that arrive shortly after a high-confidence transition settled the
    // state. Lifecycle events (exit/kill/respawn) and high-confidence events
    // always pass through.
    if (
      terminal.hysteresisLockedUntil !== undefined &&
      performance.now() < terminal.hysteresisLockedUntil &&
      !isLifecycleEvent(event) &&
      inferredConfidence < HIGH_CONFIDENCE_THRESHOLD &&
      isOppositeDirectionTransition(previousState, newState)
    ) {
      if (process.env.DAINTREE_VERBOSE) {
        console.log(
          `[AgentStateService] Suppressed low-confidence ${inferredTrigger} ` +
            `(${inferredConfidence}) ${previousState} → ${newState} for ${terminal.id} ` +
            `within hysteresis window`
        );
      }
      this.emitTransitionDropped(terminal, {
        outcome: "hysteresis",
        currentState: previousState,
        attemptedState: newState,
        trigger: inferredTrigger,
        confidence: inferredConfidence,
        cwd: terminal.cwd,
        reason: "Opposite-direction low-confidence transition within hysteresis window",
      });
      return false;
    }

    // Build and validate state change payload BEFORE mutating terminal state.
    const timestamp = getStateChangeTimestamp();

    // Parse a structured check result from recent output as the agent settles
    // out of "working". Only a NEW (changed) result is attached to the event,
    // so working↔waiting flapping doesn't spam identical updates (issue #10682).
    // Stored on the terminal AFTER validation succeeds (see the commit block).
    const newCheckResult = this.detectCheckResultOnSettle(terminal, newState, event, timestamp);

    const stateChangePayload = {
      agentId: effectiveAgentId,
      state: newState,
      previousState,
      timestamp,
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
      // Carry exit metadata on the settling event itself so subscribers learn
      // pass/fail synchronously with the state transition. The exit event is
      // the only AgentEvent that holds an exit code; pattern/timeout-driven
      // completions have none. Signal is the raw node-pty value (no 128+signum
      // POSIX decode — wrong on Windows, lesson #7028).
      ...((newState === "completed" || newState === "exited") && event.type === "exit"
        ? {
            exitCode: event.code,
            ...(event.signal !== undefined ? { exitSignal: event.signal } : {}),
          }
        : {}),
      ...(temperature
        ? {
            temperature: temperature.temperature,
            heatAdded: temperature.heatAdded,
            changedChars: temperature.changedChars,
          }
        : {}),
      ...(newCheckResult ? { lastCheckResult: newCheckResult } : {}),
    };

    const validatedStateChange = AgentStateChangedSchema.safeParse(stateChangePayload);
    if (!validatedStateChange.success) {
      const validationErrors = z.prettifyError(validatedStateChange.error).split("\n");
      console.error(
        "[AgentStateService] Invalid agent:state-changed payload:",
        z.prettifyError(validatedStateChange.error)
      );
      this.emitTransitionDropped(terminal, {
        outcome: "schema-invalid",
        currentState: previousState,
        attemptedState: newState,
        trigger: inferredTrigger,
        confidence: inferredConfidence,
        cwd: terminal.cwd,
        reason: "agent:state-changed payload failed Zod validation",
        validationErrors,
      });
      return false;
    }

    // Commit all mutations atomically.
    terminal.agentState = newState;
    terminal.lastStateChange = timestamp;

    // Persist the parsed check result post-validation (#10682). A respawn
    // starts a new session, so any prior run's result is dropped — even though
    // the old summary may still sit in the semantic buffer.
    if (event.type === "respawn") {
      terminal.lastCheckResult = undefined;
    } else if (newCheckResult) {
      terminal.lastCheckResult = newCheckResult;
    }

    // Refresh the hysteresis lock only when a high-confidence transition
    // actually crosses the active/passive boundary. Lifecycle events clear
    // the lock to prevent cross-session leakage.
    if (isLifecycleEvent(event)) {
      terminal.hysteresisLockedUntil = undefined;
    } else if (
      inferredConfidence >= HIGH_CONFIDENCE_THRESHOLD &&
      isOppositeDirectionTransition(previousState, newState)
    ) {
      terminal.hysteresisLockedUntil = performance.now() + HYSTERESIS_WINDOW_MS;
    }

    if (newState === "waiting") {
      terminal.waitingReason = waitingReason;
    } else {
      terminal.waitingReason = undefined;
    }

    events.emit("agent:state-changed", validatedStateChange.data);
    this.emitTerminalActivity(terminal);

    return true;
  }

  /**
   * Parse the recent semantic buffer for a test/lint/build summary as the agent
   * settles out of "working" (issue #10682). Pure read — the caller stores the
   * result post-validation. Returns it ONLY when it differs from the stored
   * result, so the event carries it just once and the original `ranAt` is
   * preserved across repeat detections of the same run. Skips respawns, whose
   * buffer still holds the prior session's (now irrelevant) summary.
   */
  private detectCheckResultOnSettle(
    terminal: TerminalInfo,
    newState: AgentState,
    event: AgentEvent,
    timestamp: number
  ): TerminalCheckResult | undefined {
    if (event.type === "respawn") return undefined;
    if (!CHECK_SETTLE_STATES.has(newState)) return undefined;

    const detected = detectCheckResult(terminal.semanticBuffer.join("\n"), timestamp);
    if (!detected) return undefined;

    if (checkResultsEqual(terminal.lastCheckResult, detected)) {
      // Same check as last time — keep the original timestamp, emit nothing new.
      return undefined;
    }

    return detected;
  }

  /**
   * Transition agent state from an external observer.
   * Validates session token to prevent stale observations.
   *
   * Returns `boolean` (load-bearing for `electron/ipc/handlers/terminal/io.ts:225`
   * and the main-side `PtyClient.transitionState` `Promise<boolean>` resolver).
   * The richer `reason` discriminator lives on the bus event emitted by this
   * service, not the return value — see `PtyManager.transitionState` for the
   * `transition-result` wire `reason` derivation.
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
      this.emitTransitionDropped(terminal, {
        outcome: "stale-session",
        currentState: terminal.agentState || "idle",
        trigger,
        confidence: this.normalizeConfidence(confidence),
        cwd: terminal.cwd,
        spawnedAt,
        terminalSpawnedAt: terminal.spawnedAt,
        reason: "External observer's spawnedAt token did not match the live session",
      });
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
        z.prettifyError(validatedCompleted.error)
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
        z.prettifyError(validatedKilled.error)
      );
    }
  }

  /**
   * Convert activity state to agent event and trigger state update.
   *
   * The optional `metadata.temperature` is the live `AgentActivityObservationResult`
   * computed by the activity detector for the sample that drove this transition.
   * When present, it is forwarded to `updateAgentState` and attached to the
   * emitted `agent:state-changed` event for diagnostics. Absent for transitions
   * driven by other paths (input, output, lifecycle).
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
      temperature?: AgentActivityObservationResult;
    }
  ): void {
    // The ActivityMonitor emits a synthetic `idle` observation with
    // `trigger: "dispose"` during teardown when it was still in the busy
    // state. Without this branch the observation falls through to the
    // generic `activity` path below, which publishes a high-confidence
    // `working → waiting` transition on `agent:state-changed` — a false
    // positive that fires an "Agent waiting for input" OS notification
    // (#9867) and burns the one-shot `useAgentWaitingNudge`. Suppress the
    // publication and emit a diagnostic drop so the event-log inspector
    // keeps the trace without the bad transition crossing the bus. The
    // `ActivityMonitor.dispose()` emit itself is preserved so terminals
    // that lose their ActivityMonitor without an authoritative exit/kill
    // event are not stranded in `working` — the renderer's direct idle
    // observation covers that path.
    if (metadata?.trigger === "dispose") {
      this.emitTransitionDropped(terminal, {
        outcome: "no-op",
        currentState: terminal.agentState || "idle",
        reason: "dispose observation suppressed at teardown",
      });
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
    const temperature = metadata?.temperature;

    if (metadata?.trigger === "timeout") {
      this.updateAgentState(
        terminal,
        event,
        "timeout",
        0.6,
        metadata?.waitingReason,
        undefined,
        undefined,
        temperature
      );
    } else if (metadata?.trigger === "pattern") {
      const confidence = metadata.patternConfidence ?? 0.9;
      this.updateAgentState(
        terminal,
        event,
        "heuristic",
        confidence,
        metadata?.waitingReason,
        metadata?.sessionCost,
        metadata?.sessionTokens,
        temperature
      );
    } else if (metadata?.trigger === "output") {
      this.updateAgentState(
        terminal,
        event,
        "output",
        1.0,
        metadata?.waitingReason,
        undefined,
        undefined,
        temperature
      );
    } else if (metadata?.trigger === "input") {
      this.updateAgentState(
        terminal,
        event,
        "input",
        1.0,
        metadata?.waitingReason,
        undefined,
        undefined,
        temperature
      );
    } else {
      this.updateAgentState(
        terminal,
        event,
        "activity",
        1.0,
        metadata?.waitingReason,
        undefined,
        undefined,
        temperature
      );
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
