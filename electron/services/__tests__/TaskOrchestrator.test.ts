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

/** Flush the setImmediate queue so pending retries execute */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Wait for all async assignment work to settle */
async function settle(): Promise<void> {
  await flushImmediate();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("TaskOrchestrator", () => {
  let orchestrator: TaskOrchestrator;
  let queueService: TaskQueueService;
  let mockPtyClient: MockPtyClient;
  let mockRouter: MockAgentRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    queueService = new TaskQueueService();
    queueService.setPersistenceEnabled(false);
    mockPtyClient = createMockPtyClient();
    mockRouter = createMockAgentRouter();
    orchestrator = new TaskOrchestrator(
      queueService,
      mockPtyClient as unknown as PtyClient,
      mockRouter as unknown as AgentRouter
    );
  });

  afterEach(() => {
    orchestrator.dispose();
  });

  describe("assignNextTask", () => {
    it("assigns queued task to available idle agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("agent-1");
      expect(updatedTask?.runId).toBeDefined();
    });

    it("assigns queued task to available waiting agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "waiting",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("agent-1");
    });

    it("does not assign to working agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "working",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("queued");
    });

    it("does not assign to non-agent terminal", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "terminal",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("queued");
    });

    it("assigns queued task to plain terminal with detected agent", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-detected",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      // assignedAgentId persists the logical agent identity (detectedAgentId),
      // not the terminal id.
      expect(updatedTask?.assignedAgentId).toBe("claude");
      expect(updatedTask?.runId).toBeDefined();
    });

    it("tracks two panels with the same agentId independently", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-a",
          kind: "agent",
          agentId: "claude",
          agentState: "idle",
        },
        {
          id: "term-b",
          kind: "agent",
          agentId: "claude",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);
      await settle();

      const running1 = await queueService.getTask(task1.id);
      const running2 = await queueService.getTask(task2.id);
      // Both tasks assigned — historically with agentId-keyed tracking, the
      // second would stay queued because the "claude" slot was "taken".
      expect(running1?.status).toBe("running");
      expect(running2?.status).toBe("running");
      expect(running1?.runId).not.toBe(running2?.runId);
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
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      const emitSpy = vi.spyOn(events, "emit");
      await queueService.enqueueTask(task.id);
      await settle();

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

      // Call twice simultaneously — second call sets pendingAssignment
      await Promise.all([orchestrator.assignNextTask(), orchestrator.assignNextTask()]);
      await settle();

      // With pending retry, both may eventually be assigned if agent becomes available
      // But with only one agent, only one task should be running
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

      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
    });

    it("handleAgentStateChange accepts terminalId-only payloads (defensive)", async () => {
      // AgentStateService currently guards on `terminal.agentId` before
      // emitting agent:state-changed, so a terminalId-only payload does not
      // fire in production for runtime-detected agents. This test locks the
      // orchestrator's behaviour in case that guard is relaxed upstream: a
      // payload carrying only terminalId still wakes the scheduler.
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-detected",
          kind: "terminal",
          detectedAgentId: "gemini",
          agentState: "idle",
        },
      ]);

      events.emit("agent:state-changed", {
        terminalId: "term-detected",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
      expect(updated?.assignedAgentId).toBe("gemini");
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

      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
    });

    it("does not trigger assignment when agent becomes working", async () => {
      const task = await queueService.createTask({ title: "Test task" });
      await queueService.enqueueTask(task.id);
      await settle();

      // Clear call history from the event-triggered assignment during enqueue
      mockPtyClient.getAvailableTerminalsAsync.mockClear();

      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "input",
        confidence: 1.0,
      });

      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("queued");
      // After clearing, no new calls should be made for a "working" state change
      expect(mockPtyClient.getAvailableTerminalsAsync).not.toHaveBeenCalled();
    });
  });

  describe("agent completion handling", () => {
    it("marks task as completed when agent completes", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

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

      await settle();

      const completedTask = await queueService.getTask(task.id);
      expect(completedTask?.status).toBe("completed");
    });

    it("correlates completion by terminalId when payload includes it", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-a",
          kind: "agent",
          agentId: "claude",
          agentState: "idle",
        },
        {
          id: "term-b",
          kind: "agent",
          agentId: "claude",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);
      await settle();

      const running1 = await queueService.getTask(task1.id);
      const running2 = await queueService.getTask(task2.id);
      expect(running1?.status).toBe("running");
      expect(running2?.status).toBe("running");

      // Complete only the second panel — the orchestrator must route the
      // completion to task2 via terminalId, not just pick the first claude.
      events.emit("agent:completed", {
        agentId: "claude",
        terminalId: "term-b",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      await settle();

      const updated1 = await queueService.getTask(task1.id);
      const updated2 = await queueService.getTask(task2.id);
      expect(updated1?.status).toBe("running");
      expect(updated2?.status).toBe("completed");
    });

    it("ignores completion when payload terminalId is not tracked", async () => {
      const task = await queueService.createTask({ title: "Test task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "claude",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      // Emit completion for an untracked terminal (event carries terminalId
      // but it doesn't match any tracked run).
      events.emit("agent:completed", {
        agentId: "claude",
        terminalId: "term-untracked",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      await settle();

      // Task must remain running — no mis-correlation.
      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
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
      await settle();
    });

    it("triggers assignment for next task after completion", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);
      await settle();

      const running1 = await queueService.getTask(task1.id);
      expect(running1?.status).toBe("running");

      // Complete first task
      events.emit("agent:completed", {
        agentId: "agent-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      await settle();

      // Second task should now be assigned
      const updated2 = await queueService.getTask(task2.id);
      expect(updated2?.status).toBe("running");
    });
  });

  describe("agent exit handling (runtime-detected agents)", () => {
    it("frees a detected-only terminal when agent:exited fires, and runs the next task", async () => {
      const task1 = await queueService.createTask({ title: "Task 1", priority: 10 });
      const task2 = await queueService.createTask({ title: "Task 2", priority: 5 });

      // First poll: detected-only terminal is idle.
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-detected",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task1.id);
      await queueService.enqueueTask(task2.id);
      await settle();

      // Task 1 runs on the detected terminal; task 2 stays queued.
      const running1 = await queueService.getTask(task1.id);
      const queued2 = await queueService.getTask(task2.id);
      expect(running1?.status).toBe("running");
      expect(running1?.assignedAgentId).toBe("claude");
      expect(queued2?.status).toBe("queued");

      // CLI exits — only agent:exited fires for a detected-only terminal.
      events.emit("agent:exited", {
        terminalId: "term-detected",
        agentType: "claude",
        timestamp: Date.now(),
      });

      await settle();

      // Task 1 must move out of "running" so the terminal slot clears.
      const completed1 = await queueService.getTask(task1.id);
      expect(completed1?.status).toBe("completed");

      // Task 2 must be assigned to the now-free terminal.
      const running2 = await queueService.getTask(task2.id);
      expect(running2?.status).toBe("running");
      expect(running2?.assignedAgentId).toBe("claude");
    });

    it("ignores agent:exited for untracked terminals", async () => {
      // No orchestrator bookkeeping exists — this should be a silent no-op.
      events.emit("agent:exited", {
        terminalId: "term-untracked",
        agentType: "claude",
        timestamp: Date.now(),
      });
      await settle();
      // No assertion needed beyond "did not throw". The test passes the
      // guard implicitly by reaching this point without error.
    });
  });

  describe("worktree removal handling", () => {
    it("cleans up tracking for a task on a runtime-detected terminal", async () => {
      const task = await queueService.createTask({
        title: "Detected-terminal task",
        worktreeId: "wt-1",
      });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-detected",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "idle",
          worktreeId: "wt-1",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

      const running = await queueService.getTask(task.id);
      expect(running?.status).toBe("running");

      events.emit("sys:worktree:remove", {
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });
      await settle();

      const cancelled = await queueService.getTask(task.id);
      expect(cancelled?.status).toBe("cancelled");

      // Queue a follow-up task — if tracking wasn't cleaned up, the terminal
      // would still be locked and the new task would stay queued. Leave the
      // follow-up task's worktreeId unset so the worktree-match predicate in
      // findAvailableAgent doesn't interfere with the availability check.
      const follow = await queueService.createTask({ title: "Follow-up" });
      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-detected",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "idle",
        },
      ]);
      await queueService.enqueueTask(follow.id);
      await settle();

      const runningFollow = await queueService.getTask(follow.id);
      expect(runningFollow?.status).toBe("running");
    });

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

      await settle();

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

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
          worktreeId: "wt-1",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

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

      await settle();

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

      await settle();

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

      await queueService.enqueueTask(task.id);
      await settle();

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

      await queueService.enqueueTask(task.id);
      await settle();

      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("fallback-agent");
    });

    it("does not use router when no routing hints", async () => {
      const task = await queueService.createTask({ title: "Simple task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "any-agent",
          agentState: "idle",
        },
      ]);

      await queueService.enqueueTask(task.id);
      await settle();

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

      await queueService.enqueueTask(task.id);
      await settle();

      // Should fall back to different-agent since routed-agent is not available
      const updatedTask = await queueService.getTask(task.id);
      expect(updatedTask?.status).toBe("running");
      expect(updatedTask?.assignedAgentId).toBe("different-agent");
    });
  });

  describe("signal-and-sweep", () => {
    it("retries assignment after lock releases when trigger was dropped", async () => {
      const task = await queueService.createTask({ title: "Retry task" });
      await queueService.enqueueTask(task.id);
      await settle();

      // Task is still queued (no agents during enqueue)
      const beforeTask = await queueService.getTask(task.id);
      expect(beforeTask?.status).toBe("queued");

      // Now set up: first sweep returns null (simulating no work found),
      // but a trigger arrives during the sweep that sets pendingAssignment
      let firstCall = true;
      const originalDequeueNext = queueService.dequeueNext.bind(queueService);
      vi.spyOn(queueService, "dequeueNext").mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          // While we're inside the lock, simulate a trigger arriving
          void orchestrator.assignNextTask();
          // Return null so the first sweep exits without assigning
          return null;
        }
        // Second sweep (retry): use the real dequeueNext
        return originalDequeueNext();
      });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Start the first assignment sweep
      await orchestrator.assignNextTask();
      // Flush the setImmediate retry
      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
      expect(updated?.assignedAgentId).toBe("agent-1");
    });

    it("enqueuing a task with idle agent triggers assignment via task:state-changed", async () => {
      const task = await queueService.createTask({ title: "Event-driven task" });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Enqueue fires task:state-changed with state "queued"
      // The orchestrator's subscription should call assignNextTask
      await queueService.enqueueTask(task.id);
      await settle();

      const updated = await queueService.getTask(task.id);
      expect(updated?.status).toBe("running");
      expect(updated?.assignedAgentId).toBe("agent-1");
    });

    it("unblocking a dependency triggers assignment for the dependent task", async () => {
      const taskA = await queueService.createTask({ title: "Dependency" });
      const taskB = await queueService.createTask({
        title: "Dependent",
        dependencies: [taskA.id],
      });

      mockPtyClient.getAvailableTerminalsAsync.mockResolvedValue([
        {
          id: "term-1",
          kind: "agent",
          agentId: "agent-1",
          agentState: "idle",
        },
      ]);

      // Enqueue both: taskA goes to queued, taskB goes to blocked
      await queueService.enqueueTask(taskA.id);
      await queueService.enqueueTask(taskB.id);
      await settle();

      const runningA = await queueService.getTask(taskA.id);
      expect(runningA?.status).toBe("running");

      const blockedB = await queueService.getTask(taskB.id);
      expect(blockedB?.status).toBe("blocked");

      // Complete taskA via agent:completed — this goes through handleAgentComplete
      // which cleans up tracking maps, then markCompleted triggers
      // checkAndUnblockDependents → taskB becomes queued → task:state-changed fires
      events.emit("agent:completed", {
        agentId: "agent-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });
      await settle();

      const updatedB = await queueService.getTask(taskB.id);
      expect(updatedB?.status).toBe("running");
      expect(updatedB?.assignedAgentId).toBe("agent-1");
    });
  });
});
