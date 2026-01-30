/**
 * Tests for TaskOrchestrator - Coordinates task queue with agent state machine.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import os from "os";

// Mock electron app before importing TaskQueueService
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

import { TaskOrchestrator } from "../TaskOrchestrator.js";
import { TaskQueueService } from "../TaskQueueService.js";
import { events } from "../events.js";
import type { PtyClient } from "../PtyClient.js";
import type { AgentRouter } from "../AgentRouter.js";

type MockPtyClient = {
  getAvailableTerminalsAsync: ReturnType<typeof vi.fn>;
};

type MockAgentRouter = {
  routeTask: ReturnType<typeof vi.fn>;
  scoreCandidates: ReturnType<typeof vi.fn>;
  hasCapableAgent: ReturnType<typeof vi.fn>;
};

function createMockPtyClient(): MockPtyClient {
  return {
    getAvailableTerminalsAsync: vi.fn().mockResolvedValue([]),
  };
}

function createMockAgentRouter(): MockAgentRouter {
  return {
    routeTask: vi.fn().mockResolvedValue(null),
    scoreCandidates: vi.fn().mockResolvedValue([]),
    hasCapableAgent: vi.fn().mockReturnValue(false),
  };
}

describe("TaskOrchestrator", () => {
  let orchestrator: TaskOrchestrator;
  let queueService: TaskQueueService;
  let mockPtyClient: MockPtyClient;
  let mockRouter: MockAgentRouter;

  beforeEach(() => {
    queueService = new TaskQueueService();
    queueService.setPersistenceEnabled(false);
    mockPtyClient = createMockPtyClient();
    mockRouter = createMockAgentRouter();
    orchestrator = new TaskOrchestrator(
      queueService,
      mockPtyClient as unknown as PtyClient,
      mockRouter as unknown as AgentRouter
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    orchestrator.dispose();
  });

  describe("assignNextTask", () => {
    it("assigns queued task to available idle agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("agent-1");
      expect(updatedTask?.runId).toBeDefined();
    });

    it("assigns queued task to available waiting agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "waiting",
        },
      ]);

      await orchestrator.assignNextTask();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("agent-1");
    });

    it("does not assign to working agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "working",
        },
      ]);

      await orchestrator.assignNextTask();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("queued");
    });

    it("does not assign to non-agent terminal", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "terminal",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("queued");
    });

    it("does not assign when no tasks queued", async () => {
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Should complete without error
      expect(mockPtyClient.getAvailableTerminalsAsync).not.toHaveBeenCalled();
    });

    it("emits task:assigned event on assignment", async () => {
      const emitSpy = vi.spyOn(events, "emit");
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      expect(emitSpy).toHaveBeenCalledWith(
        "task:assigned",
        expect.objectContaining({
          taskId: task.id,
          agentId: "agent-1",
        })
      );
    });

    it("prevents concurrent assignment operations", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });
      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Call twice simultaneously
      await Promise.all([orchestrator.assignNextTask(), orchestrator.assignNextTask()]);

      // Only one should have been assigned (the higher priority one)
      const updated1 = await queueService.getTask(task1.id);
      const updated2 = await queueService.getTask(task2.id);

      expect(updated1?.status).toBe("running");
      expect(updated2?.status).toBe("queued");
    });
  });

  describe("agent state change handling", () => {
    it("triggers assignment when agent becomes idle", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Emit agent state change
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
    });

    it("triggers assignment when agent becomes waiting", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "waiting",
        },
      ]);

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
    });

    it("does not trigger assignment when agent becomes working", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("queued");
      expect(mockPtyClient.getAvailableTerminalsAsync).not.toHaveBeenCalled();
    });
  });

  describe("agent completion handling", () => {
    it("marks task as completed when agent completes", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      const runningTask = await queueService.getTask(task.id);
      expect(runningTask?.status).toBe("running");
      expect(runningTask?.runId).toBeDefined();

      // Emit agent completed
      events.emit("agent:completed", {
        agentId: "agent-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const completedTask = await queueService.getTask(task.id);
      expect(completedTask?.status).toBe("completed");
    });

    it("ignores completion for unknown agents", async () => {
      // Emit completion for agent with no tracked task
      events.emit("agent:completed", {
        agentId: "unknown-agent",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      // Should complete without error
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("triggers assignment for next task after completion", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });
      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Assign first task
      await orchestrator.assignNextTask();

      const running1 = await queueService.getTask(task1.id);
      expect(running1?.status).toBe("running");

      // Complete first task
      events.emit("agent:completed", {
        agentId: "agent-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second task should now be assigned
      const updated2 = await queueService.getTask(task2.id);
      expect(updated2?.status).toBe("running");
    });
  });

  describe("agent failure handling", () => {
    it("marks task as failed when agent fails", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Emit agent failed
      events.emit("agent:failed", {
        agentId: "agent-1",
        error: "Something went wrong",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const failedTask = await queueService.getTask(task.id);
      expect(failedTask?.status).toBe("failed");
      expect(failedTask?.result?.error).toBe("Something went wrong");
    });

    it("triggers assignment for next task after failure", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });
      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Fail first task
      events.emit("agent:failed", {
        agentId: "agent-1",
        error: "Failure",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second task should be assigned
      const updated2 = await queueService.getTask(task2.id);
      expect(updated2?.status).toBe("running");
    });
  });

  describe("worktree removal handling", () => {
    it("cancels tasks for removed worktree", async () => {
      const task1 = await queueService.createTask({
        title: "Task 1",
        worktreeId: "wt-1",
      });
      const task2 = await queueService.createTask({
        title: "Task 2",
        worktreeId: "wt-1",
      });
      const task3 = await queueService.createTask({
        title: "Task 3",
        worktreeId: "wt-2",
      });

      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);
      await queueService.enqueueTask(task3.id);

      // Remove worktree 1
      events.emit("sys:worktree:remove", {
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated1 = await queueService.getTask(task1.id);
      const updated2 = await queueService.getTask(task2.id);
      const updated3 = await queueService.getTask(task3.id);

      expect(updated1?.status).toBe("cancelled");
      expect(updated2?.status).toBe("cancelled");
      expect(updated3?.status).toBe("queued");
    });

    it("does not cancel already completed tasks", async () => {
      const task = await queueService.createTask({
        title: "Completed task",
        worktreeId: "wt-1",
      });

      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
          worktreeId: "wt-1", // Match the task's worktree
        },
      ]);

      await orchestrator.assignNextTask();

      // Verify task is running
      const runningTask = await queueService.getTask(task.id);
      expect(runningTask?.status).toBe("running");

      // Complete the task
      await queueService.markCompleted(task.id, { summary: "Done" });

      // Remove worktree
      events.emit("sys:worktree:remove", {
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("completed");
    });
  });

  describe("dispose", () => {
    it("cleans up event subscriptions", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      orchestrator.dispose();

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Emit events after dispose - should not trigger assignment
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Task should still be queued (no assignment happened)
      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("queued");
    });
  });

  describe("capability-based routing", () => {
    it("uses router when task has routing hints", async () => {
      const task = await queueService.createTask({
        title: "Test task",
        routingHints: {
          requiredCapabilities: ["javascript"],
          preferredDomains: ["frontend"],
        },
      });
      await queueService.enqueueTask(task.id);

      // Mock router to return a specific agent
      mockRouter.routeTask.mockResolvedValue("routed-agent");

      // Mock pty client to verify the routed agent
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "routed-agent",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Verify router was called with hints
      expect(mockRouter.routeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredCapabilities: ["javascript"],
          preferredDomains: ["frontend"],
        })
      );

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("routed-agent");
    });

    it("falls back to simple selection when router returns null", async () => {
      const task = await queueService.createTask({
        title: "Test task",
        routingHints: {
          requiredCapabilities: ["rare-capability"],
        },
      });
      await queueService.enqueueTask(task.id);

      // Router returns null (no matching agent)
      mockRouter.routeTask.mockResolvedValue(null);

      // But there's a fallback agent available
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "fallback-agent",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("fallback-agent");
    });

    it("does not use router when no routing hints", async () => {
      const task = await queueService.createTask({ title: "Simple task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "any-agent",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Router should not be called for tasks without hints
      expect(mockRouter.routeTask).not.toHaveBeenCalled();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("any-agent");
    });

    it("verifies routed agent is available before assignment", async () => {
      const task = await queueService.createTask({
        title: "Test task",
        routingHints: {
          requiredCapabilities: ["javascript"],
        },
      });
      await queueService.enqueueTask(task.id);

      // Router returns an agent
      mockRouter.routeTask.mockResolvedValue("routed-agent");

      // But that agent is not in the available list (maybe went busy)
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "different-agent",
          agentState: "idle",
        },
      ]);

      await orchestrator.assignNextTask();

      // Should fall back to different-agent since routed-agent is not available
      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("different-agent");
    });
  });
});
