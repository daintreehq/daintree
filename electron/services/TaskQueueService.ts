/**
 * TaskQueueService - DAG-based task queue for orchestration
 *
 * Manages tasks with dependencies forming a directed acyclic graph (DAG).
 * Provides priority-based dequeuing with automatic dependency resolution.
 * Persists task state to disk per-project for crash recovery.
 */

import { randomUUID } from "crypto";
import { events } from "./events.js";
import { taskPersistence } from "./persistence/TaskPersistence.js";
import type { TaskState } from "../types/index.js";
import type {
  TaskRecord,
  CreateTaskParams,
  TaskFilter,
  TaskResult,
  DagValidationResult,
} from "../../shared/types/task.js";

export class TaskQueueService {
  private tasks: Map<string, TaskRecord> = new Map();
  private currentProjectId: string | null = null;
  private persistenceEnabled: boolean = true;

  /**
   * Create a new task.
   * Tasks are created in "draft" state by default.
   */
  async createTask(params: CreateTaskParams): Promise<TaskRecord> {
    const now = Date.now();
    const id = randomUUID();

    // Validate dependencies exist
    const dependencies = params.dependencies ?? [];
    for (const depId of dependencies) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency task not found: ${depId}`);
      }
    }

    // Check for cycles if dependencies are specified
    if (dependencies.length > 0) {
      const validation = this.validateDagWithNewEdges(id, dependencies);
      if (!validation.valid) {
        throw new Error(validation.error ?? "Adding dependencies would create a cycle");
      }
    }

    const task: TaskRecord = {
      id,
      title: params.title,
      description: params.description,
      status: "draft",
      priority: params.priority ?? 0,
      createdAt: now,
      updatedAt: now,
      dependencies,
      dependents: [],
      worktreeId: params.worktreeId,
      metadata: params.metadata,
      routingHints: params.routingHints,
    };

    // Compute blocked by (unmet dependencies)
    task.blockedBy = this.computeBlockedBy(task);

    // Update reverse index on dependency tasks
    for (const depId of dependencies) {
      const depTask = this.tasks.get(depId);
      if (depTask) {
        depTask.dependents = depTask.dependents ?? [];
        depTask.dependents.push(id);
      }
    }

    this.tasks.set(id, task);

    // Emit task created event
    events.emit("task:created", {
      taskId: id,
      description: params.title,
      worktreeId: params.worktreeId,
      timestamp: now,
    });

    await this.schedulePersist();

    return { ...task };
  }

  /**
   * Update a task's properties.
   * Cannot change dependencies after creation (use add/removeDependency).
   * Cannot change status (use enqueueTask, markRunning, markCompleted, markFailed, cancelTask).
   * Cannot change computed fields like blockedBy or dependents.
   */
  async updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Prevent updating immutable or computed fields
    const {
      id: _id,
      createdAt: _created,
      dependencies: _deps,
      status: _status,
      blockedBy: _blockedBy,
      dependents: _dependents,
      queuedAt: _queuedAt,
      startedAt: _startedAt,
      completedAt: _completedAt,
      ...safeUpdates
    } = updates;

    const now = Date.now();
    Object.assign(task, safeUpdates, { updatedAt: now });

    await this.schedulePersist();

    return { ...task };
  }

  /**
   * Get a task by ID.
   */
  async getTask(id: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  /**
   * List tasks with optional filtering.
   */
  async listTasks(filter?: TaskFilter): Promise<TaskRecord[]> {
    let results = Array.from(this.tasks.values());

    if (filter) {
      // Filter by status
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        results = results.filter((t) => statuses.includes(t.status));
      }

      // Filter by worktree
      if (filter.worktreeId) {
        results = results.filter((t) => t.worktreeId === filter.worktreeId);
      }

      // Filter by assigned agent
      if (filter.assignedAgentId) {
        results = results.filter((t) => t.assignedAgentId === filter.assignedAgentId);
      }

      // Filter by ready (no unmet dependencies)
      if (filter.ready) {
        results = results.filter((t) => !t.blockedBy || t.blockedBy.length === 0);
      }

      // Sort
      const sortBy = filter.sortBy ?? "priority";
      const sortOrder = filter.sortOrder ?? (sortBy === "priority" ? "desc" : "asc");
      const isDescending = sortOrder === "desc";

      results.sort((a, b) => {
        if (sortBy === "priority") {
          // Primary: priority
          if (a.priority !== b.priority) {
            return isDescending ? b.priority - a.priority : a.priority - b.priority;
          }
          // Secondary: createdAt (earlier first for tie-break)
          return a.createdAt - b.createdAt;
        }
        if (sortBy === "createdAt") {
          return isDescending ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
        }
        if (sortBy === "updatedAt") {
          return isDescending ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt;
        }
        return 0;
      });

      // Limit
      if (filter.limit && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }
    } else {
      // Default sort: priority desc, then createdAt asc
      results.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      });
    }

    return results.map((t) => ({ ...t }));
  }

  /**
   * Delete a task.
   * Removes the task from any dependent tasks' dependencies list.
   */
  async deleteTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Remove from dependents of dependency tasks
    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId);
      if (depTask?.dependents) {
        depTask.dependents = depTask.dependents.filter((d) => d !== id);
      }
    }

    // Remove from dependencies of dependent tasks and potentially unblock them
    if (task.dependents) {
      for (const depId of task.dependents) {
        const depTask = this.tasks.get(depId);
        if (depTask) {
          depTask.dependencies = depTask.dependencies.filter((d) => d !== id);
          depTask.blockedBy = this.computeBlockedBy(depTask);

          // If task was blocked but now has no unmet deps, move to queued
          if (depTask.status === "blocked" && depTask.blockedBy.length === 0) {
            await this.transitionToQueued(depTask);
          }
        }
      }
    }

    this.tasks.delete(id);

    await this.schedulePersist();
  }

  /**
   * Add a dependency between tasks.
   * Validates that adding the dependency won't create a cycle.
   * Can only add dependencies to tasks in draft, queued, or blocked state.
   */
  async addDependency(taskId: string, dependsOn: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const depTask = this.tasks.get(dependsOn);
    if (!depTask) {
      throw new Error(`Dependency task not found: ${dependsOn}`);
    }

    // Only allow adding dependencies to tasks in modifiable states
    const allowedStates: TaskState[] = ["draft", "queued", "blocked"];
    if (!allowedStates.includes(task.status)) {
      throw new Error(`Cannot add dependency to task in ${task.status} state`);
    }

    // Check if dependency already exists
    if (task.dependencies.includes(dependsOn)) {
      return;
    }

    // Validate no cycle would be created
    const validation = this.validateDagWithNewEdges(taskId, [...task.dependencies, dependsOn]);
    if (!validation.valid) {
      throw new Error(validation.error ?? "Adding dependency would create a cycle");
    }

    // Add dependency
    task.dependencies.push(dependsOn);
    task.updatedAt = Date.now();

    // Update reverse index
    depTask.dependents = depTask.dependents ?? [];
    depTask.dependents.push(taskId);

    // Recompute blocked by
    task.blockedBy = this.computeBlockedBy(task);

    // If task was queued but now has unmet deps, move to blocked
    if (task.status === "queued" && task.blockedBy.length > 0) {
      await this.transitionToBlocked(task);
    }

    await this.schedulePersist();
  }

  /**
   * Remove a dependency between tasks.
   */
  async removeDependency(taskId: string, dependsOn: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const depTask = this.tasks.get(dependsOn);
    if (depTask?.dependents) {
      depTask.dependents = depTask.dependents.filter((d) => d !== taskId);
    }

    task.dependencies = task.dependencies.filter((d) => d !== dependsOn);
    task.updatedAt = Date.now();

    // Recompute blocked by
    task.blockedBy = this.computeBlockedBy(task);

    // If task was blocked but now has no unmet deps, check if can unblock
    if (task.status === "blocked" && task.blockedBy.length === 0) {
      await this.transitionToQueued(task);
    }

    await this.schedulePersist();
  }

  /**
   * Get all tasks that are currently blocked.
   */
  async getBlockedTasks(): Promise<TaskRecord[]> {
    return this.listTasks({ status: "blocked" });
  }

  /**
   * Enqueue a task (move from draft to queued or blocked).
   * Tasks with unmet dependencies go to "blocked" state.
   */
  async enqueueTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "draft") {
      throw new Error(`Cannot enqueue task in ${task.status} state`);
    }

    // Recompute blocked by in case dependencies changed state
    task.blockedBy = this.computeBlockedBy(task);

    const now = Date.now();
    task.queuedAt = now;
    task.updatedAt = now;

    if (task.blockedBy.length > 0) {
      await this.transitionToBlocked(task);
    } else {
      await this.transitionToQueued(task);
    }
  }

  /**
   * Dequeue the next highest-priority ready task.
   * Returns null if no tasks are queued.
   */
  async dequeueNext(): Promise<TaskRecord | null> {
    const queued = await this.listTasks({
      status: "queued",
      ready: true,
      sortBy: "priority",
      sortOrder: "desc",
      limit: 1,
    });

    return queued.length > 0 ? queued[0] : null;
  }

  /**
   * Cancel a task.
   * Can only cancel tasks in draft, queued, or blocked state.
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const cancellableStates: TaskState[] = ["draft", "queued", "blocked", "running"];
    if (!cancellableStates.includes(task.status)) {
      throw new Error(`Cannot cancel task in ${task.status} state`);
    }

    const previousState = task.status;
    const now = Date.now();

    task.status = "cancelled";
    task.completedAt = now;
    task.updatedAt = now;

    events.emit("task:state-changed", {
      taskId,
      state: "cancelled",
      previousState,
      timestamp: now,
    });

    // Handle dependents based on policy (mark as cancelled)
    await this.handleUpstreamFailure(task, "cancelled");

    await this.schedulePersist();
  }

  /**
   * Mark a task as running.
   */
  async markRunning(taskId: string, agentId: string, runId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "queued") {
      throw new Error(`Cannot start task in ${task.status} state`);
    }

    const previousState = task.status;
    const now = Date.now();

    task.status = "running";
    task.assignedAgentId = agentId;
    task.runId = runId;
    task.startedAt = now;
    task.updatedAt = now;

    events.emit("task:state-changed", {
      taskId,
      state: "running",
      previousState,
      timestamp: now,
    });

    events.emit("task:assigned", {
      taskId,
      agentId,
      timestamp: now,
    });

    await this.schedulePersist();
  }

  /**
   * Mark a task as completed successfully.
   */
  async markCompleted(taskId: string, result?: TaskResult): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "running") {
      throw new Error(`Cannot complete task in ${task.status} state`);
    }

    const previousState = task.status;
    const now = Date.now();

    task.status = "completed";
    task.completedAt = now;
    task.updatedAt = now;
    task.result = result;

    events.emit("task:state-changed", {
      taskId,
      state: "completed",
      previousState,
      timestamp: now,
    });

    events.emit("task:completed", {
      taskId,
      agentId: task.assignedAgentId,
      runId: task.runId,
      worktreeId: task.worktreeId,
      result: result?.summary ?? "Task completed",
      artifacts: result?.artifacts,
      timestamp: now,
    });

    // Unblock dependent tasks
    await this.checkAndUnblockDependents(task);

    await this.schedulePersist();
  }

  /**
   * Mark a task as failed.
   */
  async markFailed(taskId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "running") {
      throw new Error(`Cannot fail task in ${task.status} state`);
    }

    const previousState = task.status;
    const now = Date.now();

    task.status = "failed";
    task.completedAt = now;
    task.updatedAt = now;
    task.result = { error };

    events.emit("task:state-changed", {
      taskId,
      state: "failed",
      previousState,
      timestamp: now,
    });

    events.emit("task:failed", {
      taskId,
      agentId: task.assignedAgentId,
      runId: task.runId,
      worktreeId: task.worktreeId,
      error,
      timestamp: now,
    });

    // Handle dependents based on policy (mark as failed)
    await this.handleUpstreamFailure(task, "failed");

    await this.schedulePersist();
  }

  /**
   * Validate that adding edges would not create a cycle.
   * Uses DFS to detect cycles.
   */
  validateDagWithNewEdges(taskId: string, newDependencies: string[]): DagValidationResult {
    // Build adjacency list (task -> tasks it depends on)
    const adj = new Map<string, string[]>();
    for (const [id, task] of this.tasks) {
      adj.set(id, [...task.dependencies]);
    }

    // Add the new task with its dependencies
    adj.set(taskId, newDependencies);

    // DFS to detect cycles starting from taskId
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const hasCycle = (node: string): string[] | null => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = adj.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const cycle = hasCycle(neighbor);
          if (cycle) return cycle;
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle - build the cycle path
          const cycleStart = path.indexOf(neighbor);
          return [...path.slice(cycleStart), neighbor];
        }
      }

      path.pop();
      recursionStack.delete(node);
      return null;
    };

    // Check for cycles starting from any unvisited node
    for (const nodeId of adj.keys()) {
      if (!visited.has(nodeId)) {
        const cycle = hasCycle(nodeId);
        if (cycle) {
          return {
            valid: false,
            cycle,
            error: `Cycle detected: ${cycle.join(" -> ")}`,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Compute which dependencies are unmet (not completed).
   * Throws if a dependency doesn't exist (indicates corruption).
   */
  private computeBlockedBy(task: TaskRecord): string[] {
    return task.dependencies.filter((depId) => {
      const dep = this.tasks.get(depId);
      if (!dep) {
        throw new Error(
          `Dependency ${depId} not found for task ${task.id}. This indicates data corruption.`
        );
      }
      return dep.status !== "completed";
    });
  }

  /**
   * Transition a task to queued state.
   */
  private async transitionToQueued(task: TaskRecord): Promise<void> {
    const previousState = task.status;
    const now = Date.now();

    task.status = "queued";
    task.updatedAt = now;

    // Set queuedAt if not already set (first time entering queued state)
    if (!task.queuedAt) {
      task.queuedAt = now;
    }

    events.emit("task:state-changed", {
      taskId: task.id,
      state: "queued",
      previousState,
      timestamp: now,
    });
  }

  /**
   * Transition a task to blocked state.
   */
  private async transitionToBlocked(task: TaskRecord): Promise<void> {
    const previousState = task.status;
    const now = Date.now();

    task.status = "blocked";
    task.updatedAt = now;

    events.emit("task:state-changed", {
      taskId: task.id,
      state: "blocked",
      previousState,
      timestamp: now,
    });
  }

  /**
   * Check and unblock tasks that depend on a completed task.
   */
  private async checkAndUnblockDependents(completedTask: TaskRecord): Promise<void> {
    const dependents = completedTask.dependents ?? [];

    for (const depId of dependents) {
      const depTask = this.tasks.get(depId);
      if (!depTask) continue;

      // Recompute blocked by
      depTask.blockedBy = this.computeBlockedBy(depTask);

      // If task was blocked but now has no unmet deps, move to queued
      if (depTask.status === "blocked" && depTask.blockedBy.length === 0) {
        await this.transitionToQueued(depTask);
      }
    }
  }

  /**
   * Handle upstream task failure by marking dependent tasks.
   * Policy: dependents are marked as failed or cancelled (same as upstream).
   * Cascades to all non-terminal states (draft, blocked, queued, running).
   */
  private async handleUpstreamFailure(
    failedTask: TaskRecord,
    failureState: "failed" | "cancelled"
  ): Promise<void> {
    const dependents = failedTask.dependents ?? [];

    for (const depId of dependents) {
      const depTask = this.tasks.get(depId);
      if (!depTask) continue;

      // Skip tasks already in terminal state
      if (
        depTask.status === "completed" ||
        depTask.status === "failed" ||
        depTask.status === "cancelled"
      ) {
        continue;
      }

      const previousState = depTask.status;
      const now = Date.now();

      depTask.status = failureState;
      depTask.completedAt = now;
      depTask.updatedAt = now;
      depTask.result = {
        error: `Upstream task ${failedTask.id} ${failureState}`,
      };

      events.emit("task:state-changed", {
        taskId: depId,
        state: failureState,
        previousState,
        timestamp: now,
      });

      if (failureState === "failed") {
        events.emit("task:failed", {
          taskId: depId,
          worktreeId: depTask.worktreeId,
          error: `Upstream task ${failedTask.id} failed`,
          timestamp: now,
        });
      }

      // Recursively handle this task's dependents
      await this.handleUpstreamFailure(depTask, failureState);
    }
  }

  /**
   * Get queue statistics.
   */
  getStats(): {
    total: number;
    byStatus: Record<TaskState, number>;
  } {
    const byStatus: Record<TaskState, number> = {
      draft: 0,
      queued: 0,
      running: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      byStatus[task.status]++;
    }

    return {
      total: this.tasks.size,
      byStatus,
    };
  }

  /**
   * Clear all tasks (for testing or reset).
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Initialize the service for a project.
   * Loads persisted tasks from disk.
   */
  async initialize(projectId: string): Promise<void> {
    this.currentProjectId = projectId;
    await this.loadFromDisk(projectId);
  }

  /**
   * Handle project switch: flush pending saves, clear memory, load new project's tasks.
   */
  async onProjectSwitch(newProjectId?: string): Promise<void> {
    // Flush pending saves for current project
    if (this.currentProjectId) {
      await taskPersistence.flush(this.currentProjectId);
    }

    // Clear in-memory tasks
    this.tasks.clear();

    // Load tasks for new project if provided
    if (newProjectId) {
      this.currentProjectId = newProjectId;
      await this.loadFromDisk(newProjectId);
    } else {
      this.currentProjectId = null;
    }
  }

  /**
   * Load tasks from disk for a project.
   * Rebuilds the reverse index (dependents) from forward dependencies.
   */
  private async loadFromDisk(projectId: string): Promise<void> {
    if (!this.persistenceEnabled) return;

    const loadedTasks = await taskPersistence.load(projectId);
    this.tasks.clear();

    // First pass: add all tasks without computing blockedBy
    for (const task of loadedTasks) {
      // Clear dependents - we'll rebuild this from dependencies
      task.dependents = [];
      this.tasks.set(task.id, task);
    }

    // Second pass: rebuild reverse index (dependents) and recompute blockedBy
    for (const task of this.tasks.values()) {
      for (const depId of task.dependencies) {
        const depTask = this.tasks.get(depId);
        if (depTask) {
          depTask.dependents = depTask.dependents ?? [];
          depTask.dependents.push(task.id);
        } else {
          // Dependency not found - this indicates corruption, remove it
          console.warn(
            `[TaskQueueService] Removing orphan dependency ${depId} from task ${task.id}`
          );
          task.dependencies = task.dependencies.filter((d) => d !== depId);
        }
      }
    }

    // Third pass: recompute blockedBy for all tasks
    for (const task of this.tasks.values()) {
      try {
        task.blockedBy = this.computeBlockedBy(task);
      } catch {
        // If computing blockedBy fails, clear dependencies
        console.warn(`[TaskQueueService] Failed to compute blockedBy for task ${task.id}`);
        task.dependencies = [];
        task.blockedBy = [];
      }
    }

    // Fourth pass: crash recovery - normalize task states
    // Tasks in "running" state are reset to "queued" or "blocked" after restart
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        console.warn(
          `[TaskQueueService] Crash recovery: resetting running task ${task.id} to queued/blocked`
        );

        // Clear runtime fields
        task.assignedAgentId = undefined;
        task.runId = undefined;
        task.startedAt = undefined;

        // Move to queued or blocked based on dependencies
        if (task.blockedBy && task.blockedBy.length > 0) {
          task.status = "blocked";
        } else {
          task.status = "queued";
        }
      }
    }

    console.log(`[TaskQueueService] Loaded ${this.tasks.size} tasks for project ${projectId}`);
  }

  /**
   * Schedule a debounced persistence save.
   */
  private async schedulePersist(): Promise<void> {
    if (!this.persistenceEnabled || !this.currentProjectId) return;

    const tasksArray = Array.from(this.tasks.values());
    await taskPersistence.save(this.currentProjectId, tasksArray);
  }

  /**
   * Enable or disable persistence (useful for testing).
   */
  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
  }

  /**
   * Force an immediate save to disk.
   */
  async flushPersistence(): Promise<void> {
    if (!this.currentProjectId) return;
    await taskPersistence.flush(this.currentProjectId);
  }
}

export const taskQueueService = new TaskQueueService();
