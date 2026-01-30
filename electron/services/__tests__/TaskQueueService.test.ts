/**
 * Tests for TaskQueueService - DAG-based task queue for orchestration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";

// Mock electron app before importing TaskQueueService
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

import { TaskQueueService } from "../TaskQueueService.js";
import { events } from "../events.js";

describe("TaskQueueService", () => {
  let service: TaskQueueService;

  beforeEach(() => {
    service = new TaskQueueService();
    service.setPersistenceEnabled(false);
    vi.clearAllMocks();
  });

  describe("task creation", () => {
    it("creates a task with default values", async () => {
      const task = await service.createTask({ title: "Test task" });

      expect(task.id).toBeDefined();
      expect(task.title).toBe("Test task");
      expect(task.status).toBe("draft");
      expect(task.priority).toBe(0);
      expect(task.dependencies).toEqual([]);
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it("creates a task with custom properties", async () => {
      const task = await service.createTask({
        title: "Custom task",
        description: "A detailed description",
        priority: 10,
        worktreeId: "wt-123",
        metadata: { custom: "value" },
      });

      expect(task.title).toBe("Custom task");
      expect(task.description).toBe("A detailed description");
      expect(task.priority).toBe(10);
      expect(task.worktreeId).toBe("wt-123");
      expect(task.metadata).toEqual({ custom: "value" });
    });

    it("emits task:created event", async () => {
      const emitSpy = vi.spyOn(events, "emit");

      await service.createTask({ title: "Event test" });

      expect(emitSpy).toHaveBeenCalledWith(
        "task:created",
        expect.objectContaining({
          taskId: expect.any(String),
          description: "Event test",
        })
      );
    });

    it("creates a task with dependencies", async () => {
      const dep1 = await service.createTask({ title: "Dependency 1" });
      const dep2 = await service.createTask({ title: "Dependency 2" });

      const task = await service.createTask({
        title: "Dependent task",
        dependencies: [dep1.id, dep2.id],
      });

      expect(task.dependencies).toEqual([dep1.id, dep2.id]);
      expect(task.blockedBy).toEqual([dep1.id, dep2.id]);
    });

    it("throws if dependency task does not exist", async () => {
      await expect(
        service.createTask({
          title: "Bad task",
          dependencies: ["non-existent-id"],
        })
      ).rejects.toThrow("Dependency task not found");
    });

    it("updates reverse index on dependency tasks", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep.id],
      });

      const updatedDep = await service.getTask(dep.id);
      expect(updatedDep?.dependents).toContain(task.id);
    });
  });

  describe("task retrieval", () => {
    it("retrieves a task by ID", async () => {
      const created = await service.createTask({ title: "Find me" });
      const found = await service.getTask(created.id);

      expect(found).toEqual(created);
    });

    it("returns null for non-existent task", async () => {
      const found = await service.getTask("non-existent");
      expect(found).toBeNull();
    });

    it("returns a copy, not the original", async () => {
      const created = await service.createTask({ title: "Original" });
      const found = await service.getTask(created.id);

      found!.title = "Modified";

      const refetched = await service.getTask(created.id);
      expect(refetched?.title).toBe("Original");
    });
  });

  describe("task listing and filtering", () => {
    beforeEach(async () => {
      // Create tasks with varying properties
      await service.createTask({ title: "Low priority", priority: 1 });
      await service.createTask({ title: "High priority", priority: 10 });
      await service.createTask({ title: "Medium priority", priority: 5, worktreeId: "wt-1" });
    });

    it("lists all tasks sorted by priority (default)", async () => {
      const tasks = await service.listTasks();

      expect(tasks).toHaveLength(3);
      expect(tasks[0].title).toBe("High priority");
      expect(tasks[1].title).toBe("Medium priority");
      expect(tasks[2].title).toBe("Low priority");
    });

    it("filters by status", async () => {
      const task = await service.createTask({ title: "Queued task" });
      await service.enqueueTask(task.id);

      const queued = await service.listTasks({ status: "queued" });
      const drafts = await service.listTasks({ status: "draft" });

      expect(queued).toHaveLength(1);
      expect(queued[0].title).toBe("Queued task");
      expect(drafts).toHaveLength(3);
    });

    it("filters by multiple statuses", async () => {
      const task = await service.createTask({ title: "Queued task" });
      await service.enqueueTask(task.id);

      const results = await service.listTasks({ status: ["draft", "queued"] });
      expect(results).toHaveLength(4);
    });

    it("filters by worktree", async () => {
      const results = await service.listTasks({ worktreeId: "wt-1" });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Medium priority");
    });

    it("limits results", async () => {
      const results = await service.listTasks({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("sorts by createdAt", async () => {
      const results = await service.listTasks({
        sortBy: "createdAt",
        sortOrder: "asc",
      });

      expect(results[0].title).toBe("Low priority");
    });
  });

  describe("task deletion", () => {
    it("deletes a task", async () => {
      const task = await service.createTask({ title: "Delete me" });
      await service.deleteTask(task.id);

      const found = await service.getTask(task.id);
      expect(found).toBeNull();
    });

    it("throws when deleting non-existent task", async () => {
      await expect(service.deleteTask("non-existent")).rejects.toThrow("Task not found");
    });

    it("removes deleted task from dependents' dependencies", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep.id],
      });

      await service.deleteTask(dep.id);

      const updatedTask = await service.getTask(task.id);
      expect(updatedTask?.dependencies).toEqual([]);
      expect(updatedTask?.blockedBy).toEqual([]);
    });

    it("removes deleted task from dependencies' dependents", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep.id],
      });

      await service.deleteTask(task.id);

      const updatedDep = await service.getTask(dep.id);
      expect(updatedDep?.dependents).toEqual([]);
    });
  });

  describe("DAG validation (cycle detection)", () => {
    it("prevents self-dependency", async () => {
      const task = await service.createTask({ title: "Self-dependent" });

      await expect(service.addDependency(task.id, task.id)).rejects.toThrow(/[Cc]ycle/);
    });

    it("prevents simple cycle (A -> B -> A)", async () => {
      const taskA = await service.createTask({ title: "Task A" });
      const taskB = await service.createTask({
        title: "Task B",
        dependencies: [taskA.id],
      });

      await expect(service.addDependency(taskA.id, taskB.id)).rejects.toThrow(/[Cc]ycle/);
    });

    it("prevents longer cycle (A -> B -> C -> A)", async () => {
      const taskA = await service.createTask({ title: "Task A" });
      const taskB = await service.createTask({
        title: "Task B",
        dependencies: [taskA.id],
      });
      const taskC = await service.createTask({
        title: "Task C",
        dependencies: [taskB.id],
      });

      await expect(service.addDependency(taskA.id, taskC.id)).rejects.toThrow(/[Cc]ycle/);
    });

    it("allows valid DAG structures", async () => {
      // Diamond dependency: A -> B, A -> C, B -> D, C -> D
      const taskA = await service.createTask({ title: "Task A" });
      const taskB = await service.createTask({
        title: "Task B",
        dependencies: [taskA.id],
      });
      const taskC = await service.createTask({
        title: "Task C",
        dependencies: [taskA.id],
      });
      const taskD = await service.createTask({
        title: "Task D",
        dependencies: [taskB.id, taskC.id],
      });

      // This should not throw
      expect(taskD.dependencies).toEqual([taskB.id, taskC.id]);
    });

    it("validates during task creation", async () => {
      const taskA = await service.createTask({ title: "Task A" });
      const taskB = await service.createTask({
        title: "Task B",
        dependencies: [taskA.id],
      });

      // Try to create C that depends on B and has A depend on C
      // This isn't directly testable via createTask since we can't modify A
      // But we can test addDependency for the same effect
      await expect(service.addDependency(taskA.id, taskB.id)).rejects.toThrow(/[Cc]ycle/);
    });
  });

  describe("dependency management", () => {
    it("adds a dependency", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({ title: "Task" });

      await service.addDependency(task.id, dep.id);

      const updated = await service.getTask(task.id);
      expect(updated?.dependencies).toContain(dep.id);
      expect(updated?.blockedBy).toContain(dep.id);

      const updatedDep = await service.getTask(dep.id);
      expect(updatedDep?.dependents).toContain(task.id);
    });

    it("ignores adding duplicate dependency", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Task",
        dependencies: [dep.id],
      });

      await service.addDependency(task.id, dep.id);

      const updated = await service.getTask(task.id);
      expect(updated?.dependencies).toEqual([dep.id]);
    });

    it("removes a dependency", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Task",
        dependencies: [dep.id],
      });

      await service.removeDependency(task.id, dep.id);

      const updated = await service.getTask(task.id);
      expect(updated?.dependencies).toEqual([]);
      expect(updated?.blockedBy).toEqual([]);

      const updatedDep = await service.getTask(dep.id);
      expect(updatedDep?.dependents).toEqual([]);
    });

    it("unblocks task when dependency removed", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Task",
        dependencies: [dep.id],
      });

      await service.enqueueTask(task.id);
      expect((await service.getTask(task.id))?.status).toBe("blocked");

      await service.removeDependency(task.id, dep.id);
      expect((await service.getTask(task.id))?.status).toBe("queued");
    });
  });

  describe("queue operations", () => {
    it("enqueues a task to queued state when no dependencies", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("queued");
      expect(updated?.queuedAt).toBeDefined();
    });

    it("enqueues a task to blocked state when has unmet dependencies", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Task",
        dependencies: [dep.id],
      });

      await service.enqueueTask(task.id);

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("blocked");
    });

    it("throws when enqueueing non-draft task", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);

      await expect(service.enqueueTask(task.id)).rejects.toThrow("Cannot enqueue task in queued");
    });

    it("dequeues highest priority task", async () => {
      const low = await service.createTask({ title: "Low", priority: 1 });
      const high = await service.createTask({ title: "High", priority: 10 });
      const medium = await service.createTask({ title: "Medium", priority: 5 });

      await service.enqueueTask(low.id);
      await service.enqueueTask(high.id);
      await service.enqueueTask(medium.id);

      const next = await service.dequeueNext();
      expect(next?.title).toBe("High");
    });

    it("dequeues by createdAt when priorities are equal", async () => {
      const first = await service.createTask({ title: "First", priority: 5 });
      // Small delay to ensure different createdAt
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await service.createTask({ title: "Second", priority: 5 });

      await service.enqueueTask(first.id);
      await service.enqueueTask(second.id);

      const next = await service.dequeueNext();
      expect(next?.title).toBe("First");
    });

    it("returns null when no tasks are queued", async () => {
      const next = await service.dequeueNext();
      expect(next).toBeNull();
    });

    it("does not dequeue blocked tasks", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Blocked task",
        dependencies: [dep.id],
      });

      await service.enqueueTask(task.id);

      const next = await service.dequeueNext();
      expect(next).toBeNull();
    });
  });

  describe("state transitions", () => {
    it("marks task as running", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("running");
      expect(updated?.assignedAgentId).toBe("agent-1");
      expect(updated?.runId).toBe("run-1");
      expect(updated?.startedAt).toBeDefined();
    });

    it("emits task:assigned when marking running", async () => {
      const emitSpy = vi.spyOn(events, "emit");
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);

      await service.markRunning(task.id, "agent-1", "run-1");

      expect(emitSpy).toHaveBeenCalledWith(
        "task:assigned",
        expect.objectContaining({
          taskId: task.id,
          agentId: "agent-1",
        })
      );
    });

    it("marks task as completed", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");
      await service.markCompleted(task.id, { summary: "Done!" });

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.result?.summary).toBe("Done!");
    });

    it("emits task:completed event", async () => {
      const emitSpy = vi.spyOn(events, "emit");
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");

      await service.markCompleted(task.id, { summary: "Success" });

      expect(emitSpy).toHaveBeenCalledWith(
        "task:completed",
        expect.objectContaining({
          taskId: task.id,
          result: "Success",
        })
      );
    });

    it("marks task as failed", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");
      await service.markFailed(task.id, "Something went wrong");

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.result?.error).toBe("Something went wrong");
    });

    it("emits task:failed event", async () => {
      const emitSpy = vi.spyOn(events, "emit");
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");

      await service.markFailed(task.id, "Error message");

      expect(emitSpy).toHaveBeenCalledWith(
        "task:failed",
        expect.objectContaining({
          taskId: task.id,
          error: "Error message",
        })
      );
    });

    it("throws when transitioning from invalid state", async () => {
      const task = await service.createTask({ title: "Task" });

      await expect(service.markRunning(task.id, "agent-1", "run-1")).rejects.toThrow(
        "Cannot start task in draft"
      );

      await expect(service.markCompleted(task.id)).rejects.toThrow("Cannot complete task in draft");

      await expect(service.markFailed(task.id, "error")).rejects.toThrow(
        "Cannot fail task in draft"
      );
    });
  });

  describe("dependency unblocking", () => {
    it("unblocks dependent task when dependency completes", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep.id],
      });

      await service.enqueueTask(dep.id);
      await service.enqueueTask(task.id);

      expect((await service.getTask(task.id))?.status).toBe("blocked");

      await service.markRunning(dep.id, "agent-1", "run-1");
      await service.markCompleted(dep.id);

      expect((await service.getTask(task.id))?.status).toBe("queued");
    });

    it("keeps task blocked if not all dependencies complete", async () => {
      const dep1 = await service.createTask({ title: "Dep 1" });
      const dep2 = await service.createTask({ title: "Dep 2" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep1.id, dep2.id],
      });

      await service.enqueueTask(dep1.id);
      await service.enqueueTask(dep2.id);
      await service.enqueueTask(task.id);

      await service.markRunning(dep1.id, "agent-1", "run-1");
      await service.markCompleted(dep1.id);

      // Still blocked because dep2 isn't complete
      expect((await service.getTask(task.id))?.status).toBe("blocked");
    });

    it("marks dependent tasks as failed when dependency fails", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const task = await service.createTask({
        title: "Dependent",
        dependencies: [dep.id],
      });

      await service.enqueueTask(dep.id);
      await service.enqueueTask(task.id);
      await service.markRunning(dep.id, "agent-1", "run-1");
      await service.markFailed(dep.id, "Upstream failure");

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.result?.error).toContain("Upstream task");
    });

    it("cascades failure through dependency chain", async () => {
      const taskA = await service.createTask({ title: "A" });
      const taskB = await service.createTask({
        title: "B",
        dependencies: [taskA.id],
      });
      const taskC = await service.createTask({
        title: "C",
        dependencies: [taskB.id],
      });

      await service.enqueueTask(taskA.id);
      await service.enqueueTask(taskB.id);
      await service.enqueueTask(taskC.id);

      await service.markRunning(taskA.id, "agent-1", "run-1");
      await service.markFailed(taskA.id, "A failed");

      expect((await service.getTask(taskB.id))?.status).toBe("failed");
      expect((await service.getTask(taskC.id))?.status).toBe("failed");
    });
  });

  describe("task cancellation", () => {
    it("cancels a draft task", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.cancelTask(task.id);

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("cancelled");
    });

    it("cancels a queued task", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.cancelTask(task.id);

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("cancelled");
    });

    it("cancels a running task", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");
      await service.cancelTask(task.id);

      const updated = await service.getTask(task.id);
      expect(updated?.status).toBe("cancelled");
    });

    it("throws when cancelling completed task", async () => {
      const task = await service.createTask({ title: "Task" });
      await service.enqueueTask(task.id);
      await service.markRunning(task.id, "agent-1", "run-1");
      await service.markCompleted(task.id);

      await expect(service.cancelTask(task.id)).rejects.toThrow("Cannot cancel task in completed");
    });

    it("cascades cancellation to dependent tasks", async () => {
      const taskA = await service.createTask({ title: "A" });
      const taskB = await service.createTask({
        title: "B",
        dependencies: [taskA.id],
      });

      await service.enqueueTask(taskA.id);
      await service.enqueueTask(taskB.id);
      await service.cancelTask(taskA.id);

      expect((await service.getTask(taskB.id))?.status).toBe("cancelled");
    });
  });

  describe("getBlockedTasks", () => {
    it("returns only blocked tasks", async () => {
      const dep = await service.createTask({ title: "Dependency" });
      const blocked1 = await service.createTask({
        title: "Blocked 1",
        dependencies: [dep.id],
      });
      const blocked2 = await service.createTask({
        title: "Blocked 2",
        dependencies: [dep.id],
      });
      const ready = await service.createTask({ title: "Ready" });

      await service.enqueueTask(blocked1.id);
      await service.enqueueTask(blocked2.id);
      await service.enqueueTask(ready.id);

      const blockedTasks = await service.getBlockedTasks();

      expect(blockedTasks).toHaveLength(2);
      expect(blockedTasks.map((t) => t.title)).toContain("Blocked 1");
      expect(blockedTasks.map((t) => t.title)).toContain("Blocked 2");
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      await service.createTask({ title: "Draft" });
      const task2 = await service.createTask({ title: "Queued" });
      const dep = await service.createTask({ title: "Dep" });
      const task3 = await service.createTask({
        title: "Blocked",
        dependencies: [dep.id],
      });

      await service.enqueueTask(task2.id);
      await service.enqueueTask(task3.id);

      const stats = service.getStats();

      expect(stats.total).toBe(4);
      expect(stats.byStatus.draft).toBe(2); // "Draft" and dep
      expect(stats.byStatus.queued).toBe(1);
      expect(stats.byStatus.blocked).toBe(1);
    });
  });

  describe("clear", () => {
    it("removes all tasks", async () => {
      await service.createTask({ title: "Task 1" });
      await service.createTask({ title: "Task 2" });

      service.clear();

      const tasks = await service.listTasks();
      expect(tasks).toHaveLength(0);
    });
  });
});
