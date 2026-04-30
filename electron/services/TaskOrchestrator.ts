/**
 * TaskOrchestrator - Coordinates task queue with agent state machine.
 *
 * Subscribes to agent lifecycle events and drives task state transitions:
 * - Assigns queued tasks to idle agents using capability-based routing
 * - Monitors agent execution and updates task state
 * - Handles failures and propagates to dependents
 * - Cancels tasks when worktrees are removed
 */

import { randomUUID } from "crypto";
import { events } from "./events.js";
import { taskQueueService, TaskQueueService } from "./TaskQueueService.js";
import { AgentRouter, getAgentRouter } from "./AgentRouter.js";
import type { PtyClient } from "./PtyClient.js";
import type { AgentState } from "../../shared/types/agent.js";
import type { DaintreeEventMap } from "./events.js";
import type { TaskRoutingHints } from "../../shared/types/task.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

/**
 * Check if an agent is available to receive a new task.
 * An agent is available if it's idle or waiting for user input.
 */
function isAgentAvailable(state: AgentState | undefined): boolean {
  return state === "idle" || state === "waiting";
}

export class TaskOrchestrator {
  /** Map of runId -> taskId for correlating agent completions to tasks */
  private runToTaskMap: Map<string, string> = new Map();

  /**
   * Map of terminalId -> runId for tracking current runs.
   *
   * Keyed by terminalId (immutable for the panel's lifetime) rather than the
   * logical agentId. This avoids collisions when multiple panels share an
   * agentId of the same named type (e.g. two "claude" panels) and lets the
   * orchestrator track runtime-detected agents — plain terminals with a
   * `detectedAgentId` but no stored `agentId` — without colliding on the
   * shared agent type.
   */
  private agentToRunMap: Map<string, string> = new Map();

  /**
   * Map of runId -> terminalId. Used to clean up `agentToRunMap` during
   * worktree removal, since `task.assignedAgentId` holds the logical agent
   * identity rather than the terminal id.
   */
  private terminalIdByRunId: Map<string, string> = new Map();

  /** Lock to prevent concurrent assignment operations */
  private isAssigning = false;

  /** Flag to coalesce triggers that arrive while assignment is in progress */
  private pendingAssignment = false;

  /** Flag to track if orchestrator is disposed */
  private isDisposed = false;

  /** Unsubscribe functions for event listeners */
  private unsubscribers: Array<() => void> = [];

  /** Router for capability-based agent selection */
  private router: AgentRouter;

  constructor(
    private queueService: TaskQueueService,
    private ptyClient: PtyClient,
    router?: AgentRouter
  ) {
    this.router = router ?? getAgentRouter();
    // Subscribe to agent state changes
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        void this.handleAgentStateChange(payload);
      })
    );

    // Subscribe to agent completions
    this.unsubscribers.push(
      events.on("agent:completed", (payload) => {
        void this.handleAgentComplete(payload);
      })
    );

    // Subscribe to agent kills (user-initiated termination)
    this.unsubscribers.push(
      events.on("agent:killed", (payload) => {
        void this.handleAgentKilled(payload);
      })
    );

    // Subscribe to agent exit (process gone from the terminal). This is the
    // only lifecycle signal that fires for runtime-detected agents — the
    // stored-identity `agent:completed`/`agent:killed` emitters in
    // AgentStateService guard on `terminal.agentId` and skip detected-only
    // terminals. Without this subscription, a task assigned to a detected-only
    // terminal would lock that terminalId in `agentToRunMap` forever.
    this.unsubscribers.push(
      events.on("agent:exited", (payload) => {
        void this.handleAgentExited(payload);
      })
    );

    // Subscribe to worktree removals
    this.unsubscribers.push(
      events.on("sys:worktree:remove", (payload) => {
        void this.handleWorktreeRemove(payload);
      })
    );

    // Subscribe to task state changes to wake assignment when tasks become queued
    this.unsubscribers.push(
      events.on("task:state-changed", (payload) => {
        this.handleTaskStateChange(payload);
      })
    );
  }

  /**
   * Attempt to assign the next queued task to an available agent.
   * Uses capability-based routing when routing hints are present.
   * Falls back to simple availability-based assignment otherwise.
   * Loops until no more tasks or agents are available.
   */
  async assignNextTask(): Promise<void> {
    // Disposed orchestrators must not schedule retries
    if (this.isDisposed) return;

    // Coalesce triggers that arrive while assignment is in progress
    if (this.isAssigning) {
      this.pendingAssignment = true;
      return;
    }

    this.isAssigning = true;
    this.pendingAssignment = false;

    try {
      // Loop to assign multiple tasks if multiple agents are available
      while (true) {
        // Get the next ready task
        const task = await this.queueService.dequeueNext();
        if (!task) {
          break; // No more tasks
        }

        // Try capability-based routing first if routing hints are present
        let selected: SelectedAgent | null = null;

        if (task.routingHints) {
          selected = await this.routeTaskWithHints(task.routingHints, task.worktreeId);
        }

        // Fall back to simple availability-based selection
        if (!selected) {
          selected = await this.findAvailableAgent(task.worktreeId);
        }

        if (!selected) {
          // No available agents - task will stay queued for next attempt
          break;
        }

        // Generate a new run ID for this execution
        const runId = randomUUID();

        // Set tracking maps BEFORE marking running to avoid race with fast agent events
        this.runToTaskMap.set(runId, task.id);
        this.agentToRunMap.set(selected.terminalId, runId);
        this.terminalIdByRunId.set(runId, selected.terminalId);

        // Mark task as running (atomic state transition).
        // Note: markRunning receives the logical agentId (which may originate
        // from either stored `agentId` or runtime-detected `detectedAgentId`),
        // so `Task.assignedAgentId` retains its documented agent-identity
        // semantics. The orchestrator's internal bookkeeping is keyed by the
        // immutable terminalId.
        try {
          await this.queueService.markRunning(task.id, selected.agentId, runId);
        } catch (error) {
          // Task state transition failed - roll back tracking maps
          this.runToTaskMap.delete(runId);
          this.agentToRunMap.delete(selected.terminalId);
          this.terminalIdByRunId.delete(runId);

          console.warn(
            `[TaskOrchestrator] Failed to mark task ${task.id} as running:`,
            formatErrorMessage(error, "Failed to mark task running")
          );
          break; // Don't try to assign more tasks if we hit an error
        }

        // TaskQueueService already emits task:assigned event, no need to duplicate
      }
    } finally {
      this.isAssigning = false;
      if (this.pendingAssignment && !this.isDisposed) {
        setImmediate(() => void this.assignNextTask());
      }
    }
  }

  /**
   * Route a task using capability-based routing.
   * Returns the selected terminal + logical agentId, or null if no suitable
   * agent is found. Matches on stored identity (`agentId`) OR runtime
   * detection (`detectedAgentId`) so plain terminals that have an agent CLI
   * detected at runtime are also eligible.
   */
  private async routeTaskWithHints(
    hints: TaskRoutingHints,
    worktreeId?: string
  ): Promise<SelectedAgent | null> {
    const routedAgentId = await this.router.routeTask({
      ...hints,
      worktreeId,
    });

    if (!routedAgentId) {
      return null;
    }

    // Verify the routed agent is still available in the terminal list
    // and not already running a task. Lock check is keyed by terminalId.
    const availableTerminals = await this.ptyClient.getAvailableTerminalsAsync();
    const terminal = availableTerminals.find(
      (t) =>
        (t.launchAgentId === routedAgentId || t.detectedAgentId === routedAgentId) &&
        isAgentAvailable(t.agentState) &&
        !this.agentToRunMap.has(t.id) &&
        (!worktreeId || t.worktreeId === worktreeId)
    );

    return terminal ? { terminalId: terminal.id, agentId: routedAgentId } : null;
  }

  /**
   * Find any available agent using simple availability-based selection.
   * Used as fallback when no routing hints are present. Accepts either
   * stored identity (`agentId`) or runtime-detected
   * identity (`detectedAgentId`) so agent CLIs launched from plain
   * terminals can receive tasks.
   */
  private async findAvailableAgent(worktreeId?: string): Promise<SelectedAgent | null> {
    const availableTerminals = await this.ptyClient.getAvailableTerminalsAsync();

    // Filter to terminals that look like an agent (stored OR detected) and
    // are available. Lock check is keyed by terminalId so two panels of the
    // same named agent type can be tracked independently.
    const availableAgent = availableTerminals.find((t) => {
      const logicalAgentId = t.launchAgentId ?? t.detectedAgentId;
      return (
        logicalAgentId &&
        isAgentAvailable(t.agentState) &&
        !this.agentToRunMap.has(t.id) &&
        (!worktreeId || t.worktreeId === worktreeId)
      );
    });

    if (!availableAgent) return null;
    const logicalAgentId = availableAgent.launchAgentId ?? availableAgent.detectedAgentId;
    if (!logicalAgentId) return null;

    return { terminalId: availableAgent.id, agentId: logicalAgentId };
  }

  /**
   * Handle agent state changes.
   * When an agent becomes idle or waiting, attempt to assign a new task.
   * Triggers on either a stored `agentId` or a bare `terminalId` so
   * runtime-detected agents (no stored agentId) also wake the scheduler.
   */
  private async handleAgentStateChange(
    payload: DaintreeEventMap["agent:state-changed"]
  ): Promise<void> {
    if (this.isDisposed) return;

    const { state, agentId, terminalId } = payload;

    // Only trigger assignment when agent becomes available
    // Don't clear run mappings here - let completion/failure events handle that
    // to avoid race conditions with out-of-order events
    if (isAgentAvailable(state) && (agentId || terminalId)) {
      // Try to assign next task
      await this.assignNextTask();
    }
  }

  /**
   * Handle task state changes.
   * When a task becomes queued (enqueued or unblocked), attempt assignment.
   */
  private handleTaskStateChange(payload: DaintreeEventMap["task:state-changed"]): void {
    if (this.isDisposed) return;
    if (payload.state === "queued") {
      void this.assignNextTask();
    }
  }

  /**
   * Resolve the terminalId that owns a run, given an agent lifecycle payload.
   * Prefers the payload's explicit `terminalId`; only when the payload has no
   * terminalId does it fall back to matching by `agentId` against
   * `task.assignedAgentId` for tasks currently tracked by the orchestrator.
   *
   * Real emitters (`AgentStateService`, `PtyEventsBridge`) always set
   * `terminalId` on these events, but the type leaves it optional. The
   * fallback preserves the old agentId-keyed behaviour when `terminalId` is
   * genuinely absent, without risking mis-correlation when the payload
   * includes a terminalId for a terminal the orchestrator isn't tracking.
   *
   * Trade-off: when `terminalId` is present but unknown (e.g. the tracking
   * entry was lost to a dispose/reinit race, or a late event arrives after
   * worktree removal), the run is not recovered and the task may remain in
   * `"running"` until a higher-level reconciliation (e.g. worktree teardown)
   * sweeps it. Preferring correctness over recovery is deliberate — a false
   * match in this path would mark an unrelated task as completed.
   */
  private async resolveTerminalIdForRun(
    payloadTerminalId: string | undefined,
    payloadAgentId: string | undefined
  ): Promise<string | null> {
    if (payloadTerminalId) {
      return this.agentToRunMap.has(payloadTerminalId) ? payloadTerminalId : null;
    }
    if (!payloadAgentId) return null;

    // Fallback: scan tracked runs for a task whose assignedAgentId matches.
    for (const [runId, terminalId] of this.terminalIdByRunId) {
      const taskId = this.runToTaskMap.get(runId);
      if (!taskId) continue;
      const task = await this.queueService.getTask(taskId);
      if (task?.assignedAgentId === payloadAgentId) {
        return terminalId;
      }
    }
    return null;
  }

  /**
   * Handle agent completion.
   * Correlate the completion to a running task and mark it as completed.
   */
  private async handleAgentComplete(payload: DaintreeEventMap["agent:completed"]): Promise<void> {
    if (this.isDisposed) return;

    const { agentId, terminalId } = payload;
    if (!agentId && !terminalId) return;

    const resolvedTerminalId = await this.resolveTerminalIdForRun(terminalId, agentId);
    if (!resolvedTerminalId) {
      // Agent completed without a tracked task - that's fine
      return;
    }

    // Find the run ID for this terminal
    const runId = this.agentToRunMap.get(resolvedTerminalId);
    if (!runId) return;

    // Find the task for this run
    const taskId = this.runToTaskMap.get(runId);
    if (!taskId) {
      // Run completed without a tracked task
      this.agentToRunMap.delete(resolvedTerminalId);
      this.terminalIdByRunId.delete(runId);
      return;
    }

    // Get the task to verify it's still running with this runId
    const task = await this.queueService.getTask(taskId);
    if (!task || task.status !== "running" || task.runId !== runId) {
      // Task state has changed - don't update it
      this.runToTaskMap.delete(runId);
      this.agentToRunMap.delete(resolvedTerminalId);
      this.terminalIdByRunId.delete(runId);
      return;
    }

    // Mark task as completed
    try {
      await this.queueService.markCompleted(taskId, {
        summary: `Completed by agent ${task.assignedAgentId ?? agentId ?? "unknown"}`,
      });
    } catch (error) {
      console.error(
        `[TaskOrchestrator] Failed to mark task ${taskId} as completed:`,
        formatErrorMessage(error, "Failed to mark task completed")
      );
    }

    // Clean up tracking
    this.runToTaskMap.delete(runId);
    this.agentToRunMap.delete(resolvedTerminalId);
    this.terminalIdByRunId.delete(runId);

    // Try to assign next task now that this agent is free
    await this.assignNextTask();
  }

  /**
   * Handle agent kill (user-initiated termination).
   * Clean up task tracking and cancel the associated task.
   */
  private async handleAgentKilled(payload: DaintreeEventMap["agent:killed"]): Promise<void> {
    if (this.isDisposed) return;

    const { agentId, terminalId } = payload;
    if (!agentId && !terminalId) return;

    const resolvedTerminalId = await this.resolveTerminalIdForRun(terminalId, agentId);
    if (!resolvedTerminalId) return;

    const runId = this.agentToRunMap.get(resolvedTerminalId);
    if (!runId) return;

    const taskId = this.runToTaskMap.get(runId);
    if (!taskId) {
      this.agentToRunMap.delete(resolvedTerminalId);
      this.terminalIdByRunId.delete(runId);
      return;
    }

    const task = await this.queueService.getTask(taskId);
    if (!task || task.status !== "running" || task.runId !== runId) {
      this.runToTaskMap.delete(runId);
      this.agentToRunMap.delete(resolvedTerminalId);
      this.terminalIdByRunId.delete(runId);
      return;
    }

    try {
      await this.queueService.cancelTask(taskId);
    } catch (err) {
      console.error(
        `[TaskOrchestrator] Failed to cancel task ${taskId} after agent kill:`,
        formatErrorMessage(err, "Failed to cancel task")
      );
    }

    this.runToTaskMap.delete(runId);
    this.agentToRunMap.delete(resolvedTerminalId);
    this.terminalIdByRunId.delete(runId);

    await this.assignNextTask();
  }

  /**
   * Handle agent exit.
   *
   * Fires when the CLI process leaves the terminal. For stored-identity
   * agents this usually runs after `agent:completed`/`agent:killed` has
   * already cleaned up, so the terminalId lookup misses and we no-op. For
   * runtime-detected agents — whose `agent:completed`/`agent:killed` never
   * fire because `AgentStateService` guards on `terminal.agentId` — this is
   * the *only* cleanup path, and we mark the running task as completed so
   * the user sees the task closed out and the next queued task can run.
   *
   * Exit codes are not available on `agent:exited`, so we cannot distinguish
   * success from crash here. Marking completed is the pragmatic choice:
   * tasks that assigned successfully and then exited are treated as done;
   * the terminal output still reflects any errors, and the user can re-queue
   * if needed.
   */
  private async handleAgentExited(payload: DaintreeEventMap["agent:exited"]): Promise<void> {
    if (this.isDisposed) return;

    const { terminalId } = payload;
    if (!terminalId) return;

    const runId = this.agentToRunMap.get(terminalId);
    if (!runId) {
      // Not tracking this terminal — normal for non-agent terminals and for
      // stored-identity agents whose completion/kill events already cleaned up.
      return;
    }

    const taskId = this.runToTaskMap.get(runId);
    if (!taskId) {
      this.agentToRunMap.delete(terminalId);
      this.terminalIdByRunId.delete(runId);
      return;
    }

    const task = await this.queueService.getTask(taskId);
    if (task && task.status === "running" && task.runId === runId) {
      try {
        await this.queueService.markCompleted(taskId, {
          summary: `Completed by agent ${task.assignedAgentId ?? "unknown"}`,
        });
      } catch (err) {
        console.error(
          `[TaskOrchestrator] Failed to mark task ${taskId} completed after agent exit:`,
          formatErrorMessage(err, "Failed to mark task completed")
        );
      }
    }

    this.runToTaskMap.delete(runId);
    this.agentToRunMap.delete(terminalId);
    this.terminalIdByRunId.delete(runId);

    await this.assignNextTask();
  }

  /**
   * Handle worktree removal.
   * Cancel all tasks tied to the removed worktree.
   */
  private async handleWorktreeRemove(
    payload: DaintreeEventMap["sys:worktree:remove"]
  ): Promise<void> {
    if (this.isDisposed) return;

    const { worktreeId } = payload;

    // Find all tasks for this worktree
    const tasks = await this.queueService.listTasks({ worktreeId });

    // Cancel tasks that aren't already completed
    for (const task of tasks) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        continue;
      }

      try {
        await this.queueService.cancelTask(task.id);

        // Clean up tracking for running tasks. Look up the terminalId via
        // the runId → terminalId map (task.assignedAgentId holds the logical
        // agent identity, not the terminal id used as the agentToRunMap key).
        if (task.runId) {
          const terminalId = this.terminalIdByRunId.get(task.runId);
          this.runToTaskMap.delete(task.runId);
          this.terminalIdByRunId.delete(task.runId);
          if (terminalId) {
            this.agentToRunMap.delete(terminalId);
          }
        }
      } catch (error) {
        // Task may already be in a terminal state
        console.warn(
          `[TaskOrchestrator] Failed to cancel task ${task.id} on worktree removal:`,
          formatErrorMessage(error, "Failed to cancel task on worktree removal")
        );
      }
    }
  }

  /**
   * Dispose of the orchestrator and clean up event subscriptions.
   */
  dispose(): void {
    this.isDisposed = true;

    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.runToTaskMap.clear();
    this.agentToRunMap.clear();
    this.terminalIdByRunId.clear();
  }
}

/** Internal result type for agent selection. */
interface SelectedAgent {
  /** Immutable terminal id used as the agentToRunMap key. */
  terminalId: string;
  /** Logical agent identity (stored `agentId` or runtime `detectedAgentId`), persisted as `Task.assignedAgentId`. */
  agentId: string;
}

// Singleton instance
let orchestratorInstance: TaskOrchestrator | null = null;

/**
 * Initialize the task orchestrator with dependencies.
 * Should be called once during app startup after ptyClient is ready.
 */
export function initializeTaskOrchestrator(
  ptyClient: PtyClient,
  router?: AgentRouter
): TaskOrchestrator {
  if (orchestratorInstance) {
    orchestratorInstance.dispose();
  }
  orchestratorInstance = new TaskOrchestrator(taskQueueService, ptyClient, router);
  return orchestratorInstance;
}

/**
 * Get the task orchestrator instance.
 * Returns null if not initialized.
 */
export function getTaskOrchestrator(): TaskOrchestrator | null {
  return orchestratorInstance;
}

/**
 * Dispose the task orchestrator.
 */
export function disposeTaskOrchestrator(): void {
  if (orchestratorInstance) {
    orchestratorInstance.dispose();
    orchestratorInstance = null;
  }
}
