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
import type { AgentState } from "../../shared/types/domain.js";
import type { CanopyEventMap } from "./events.js";
import type { TaskRoutingHints } from "../../shared/types/task.js";

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

  /** Map of agentId -> runId for tracking current runs */
  private agentToRunMap: Map<string, string> = new Map();

  /** Lock to prevent concurrent assignment operations */
  private isAssigning = false;

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

    // Subscribe to agent failures
    this.unsubscribers.push(
      events.on("agent:failed", (payload) => {
        void this.handleAgentFailed(payload);
      })
    );

    // Subscribe to worktree removals
    this.unsubscribers.push(
      events.on("sys:worktree:remove", (payload) => {
        void this.handleWorktreeRemove(payload);
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
    // Prevent concurrent assignments
    if (this.isAssigning || this.isDisposed) {
      return;
    }

    this.isAssigning = true;

    try {
      // Loop to assign multiple tasks if multiple agents are available
      while (true) {
        // Get the next ready task
        const task = await this.queueService.dequeueNext();
        if (!task) {
          break; // No more tasks
        }

        // Try capability-based routing first if routing hints are present
        let selectedAgentId: string | null = null;

        if (task.routingHints) {
          selectedAgentId = await this.routeTaskWithHints(task.routingHints, task.worktreeId);
        }

        // Fall back to simple availability-based selection
        if (!selectedAgentId) {
          selectedAgentId = await this.findAvailableAgent(task.worktreeId);
        }

        if (!selectedAgentId) {
          // No available agents - task will stay queued for next attempt
          break;
        }

        // Generate a new run ID for this execution
        const runId = randomUUID();

        // Set tracking maps BEFORE marking running to avoid race with fast agent events
        this.runToTaskMap.set(runId, task.id);
        this.agentToRunMap.set(selectedAgentId, runId);

        // Mark task as running (atomic state transition)
        try {
          await this.queueService.markRunning(task.id, selectedAgentId, runId);
        } catch (error) {
          // Task state transition failed - roll back tracking maps
          this.runToTaskMap.delete(runId);
          this.agentToRunMap.delete(selectedAgentId);

          console.warn(
            `[TaskOrchestrator] Failed to mark task ${task.id} as running:`,
            error instanceof Error ? error.message : String(error)
          );
          break; // Don't try to assign more tasks if we hit an error
        }

        // TaskQueueService already emits task:assigned event, no need to duplicate
      }
    } finally {
      this.isAssigning = false;
    }
  }

  /**
   * Route a task using capability-based routing.
   * Returns the best agent ID or null if no suitable agent is found.
   */
  private async routeTaskWithHints(
    hints: TaskRoutingHints,
    worktreeId?: string
  ): Promise<string | null> {
    const routedAgentId = await this.router.routeTask({
      ...hints,
      worktreeId,
    });

    if (!routedAgentId) {
      return null;
    }

    // Verify the routed agent is still available in the terminal list
    // and not already running a task
    const availableTerminals = await this.ptyClient.getAvailableTerminalsAsync();
    const terminal = availableTerminals.find(
      (t) =>
        t.kind === "agent" &&
        t.agentId === routedAgentId &&
        isAgentAvailable(t.agentState) &&
        !this.agentToRunMap.has(routedAgentId) &&
        (!worktreeId || t.worktreeId === worktreeId)
    );

    return terminal ? routedAgentId : null;
  }

  /**
   * Find any available agent using simple availability-based selection.
   * Used as fallback when no routing hints are present.
   */
  private async findAvailableAgent(worktreeId?: string): Promise<string | null> {
    const availableTerminals = await this.ptyClient.getAvailableTerminalsAsync();

    // Filter to only agent-type terminals that are actually available
    // Match worktree if task has one, otherwise allow any agent
    const availableAgent = availableTerminals.find(
      (t) =>
        t.kind === "agent" &&
        t.agentId &&
        isAgentAvailable(t.agentState) &&
        !this.agentToRunMap.has(t.agentId) && // Not already running a task
        (!worktreeId || t.worktreeId === worktreeId) // Worktree match if specified
    );

    return availableAgent?.agentId ?? null;
  }

  /**
   * Handle agent state changes.
   * When an agent becomes idle or waiting, attempt to assign a new task.
   */
  private async handleAgentStateChange(
    payload: CanopyEventMap["agent:state-changed"]
  ): Promise<void> {
    if (this.isDisposed) return;

    const { state, agentId } = payload;

    // Only trigger assignment when agent becomes available
    // Don't clear run mappings here - let completion/failure events handle that
    // to avoid race conditions with out-of-order events
    if (isAgentAvailable(state) && agentId) {
      // Try to assign next task
      await this.assignNextTask();
    }
  }

  /**
   * Handle agent completion.
   * Correlate the completion to a running task and mark it as completed.
   */
  private async handleAgentComplete(payload: CanopyEventMap["agent:completed"]): Promise<void> {
    if (this.isDisposed) return;

    const { agentId } = payload;
    if (!agentId) return;

    // Find the run ID for this agent
    const runId = this.agentToRunMap.get(agentId);
    if (!runId) {
      // Agent completed without a tracked task - that's fine
      return;
    }

    // Find the task for this run
    const taskId = this.runToTaskMap.get(runId);
    if (!taskId) {
      // Run completed without a tracked task
      this.agentToRunMap.delete(agentId);
      return;
    }

    // Get the task to verify it's still running with this runId
    const task = await this.queueService.getTask(taskId);
    if (!task || task.status !== "running" || task.runId !== runId) {
      // Task state has changed - don't update it
      this.runToTaskMap.delete(runId);
      this.agentToRunMap.delete(agentId);
      return;
    }

    // Mark task as completed
    try {
      await this.queueService.markCompleted(taskId, {
        summary: `Completed by agent ${agentId}`,
      });
    } catch (error) {
      console.error(
        `[TaskOrchestrator] Failed to mark task ${taskId} as completed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Clean up tracking
    this.runToTaskMap.delete(runId);
    this.agentToRunMap.delete(agentId);

    // Try to assign next task now that this agent is free
    await this.assignNextTask();
  }

  /**
   * Handle agent failure.
   * Correlate the failure to a running task and mark it as failed.
   */
  private async handleAgentFailed(payload: CanopyEventMap["agent:failed"]): Promise<void> {
    if (this.isDisposed) return;

    const { agentId, error } = payload;
    if (!agentId) return;

    // Find the run ID for this agent
    const runId = this.agentToRunMap.get(agentId);
    if (!runId) {
      // Agent failed without a tracked task
      return;
    }

    // Find the task for this run
    const taskId = this.runToTaskMap.get(runId);
    if (!taskId) {
      // Run failed without a tracked task
      this.agentToRunMap.delete(agentId);
      return;
    }

    // Get the task to verify it's still running with this runId
    const task = await this.queueService.getTask(taskId);
    if (!task || task.status !== "running" || task.runId !== runId) {
      // Task state has changed - don't update it
      this.runToTaskMap.delete(runId);
      this.agentToRunMap.delete(agentId);
      return;
    }

    // Mark task as failed
    try {
      await this.queueService.markFailed(taskId, error);
    } catch (err) {
      console.error(
        `[TaskOrchestrator] Failed to mark task ${taskId} as failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }

    // Clean up tracking
    this.runToTaskMap.delete(runId);
    this.agentToRunMap.delete(agentId);

    // Try to assign next task (to other available agents)
    await this.assignNextTask();
  }

  /**
   * Handle worktree removal.
   * Cancel all tasks tied to the removed worktree.
   */
  private async handleWorktreeRemove(
    payload: CanopyEventMap["sys:worktree:remove"]
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

        // Clean up tracking for running tasks
        if (task.runId && task.assignedAgentId) {
          this.runToTaskMap.delete(task.runId);
          this.agentToRunMap.delete(task.assignedAgentId);
        }
      } catch (error) {
        // Task may already be in a terminal state
        console.warn(
          `[TaskOrchestrator] Failed to cancel task ${task.id} on worktree removal:`,
          error instanceof Error ? error.message : String(error)
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
  }
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
