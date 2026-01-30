/**
 * Tests for WorkflowEngine - Compiles workflow definitions into task queue operations.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import os from "os";

// Mock electron app before importing TaskQueueService
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

import { WorkflowEngine } from "../WorkflowEngine.js";
import { events } from "../events.js";
import type { WorkflowLoader } from "../WorkflowLoader.js";
import type { TaskQueueService } from "../TaskQueueService.js";
import type { WorkflowPersistence } from "../persistence/WorkflowPersistence.js";
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQueueService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPersistence: any;

  const mockWorkflow: WorkflowDefinition = {
    id: "test-workflow",
    name: "Test Workflow",
    version: "1.0.0",
    nodes: [
      {
        id: "node-1",
        type: "action",
        config: { actionId: "action-1", args: {} },
        onSuccess: ["node-2"],
      },
      {
        id: "node-2",
        type: "action",
        config: { actionId: "action-2", args: {} },
        dependencies: ["node-1"],
      },
    ],
  };

  beforeEach(() => {
    mockLoader = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getWorkflow: vi.fn().mockResolvedValue({ definition: mockWorkflow }),
    };

    mockQueueService = {
      createTask: vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      })),
      enqueueTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    };

    mockPersistence = {
      load: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    engine = new WorkflowEngine(
      mockLoader as unknown as WorkflowLoader,
      mockQueueService as unknown as TaskQueueService,
      mockPersistence as unknown as WorkflowPersistence
    );

    vi.clearAllMocks();
  });

  afterEach(() => {
    engine.dispose();
  });

  describe("startWorkflow", () => {
    it("starts a workflow and schedules root nodes", async () => {
      const runId = await engine.startWorkflow("test-workflow");

      expect(runId).toBeDefined();
      expect(mockLoader.getWorkflow).toHaveBeenCalledWith("test-workflow");

      // Should have scheduled node-1 (the root)
      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-1" }),
        })
      );
      expect(mockQueueService.enqueueTask).toHaveBeenCalledWith("task-node-1");
    });

    it("throws error if workflow not found", async () => {
      mockLoader.getWorkflow.mockResolvedValue(null);
      await expect(engine.startWorkflow("invalid")).rejects.toThrow("Workflow not found: invalid");
    });
  });

  describe("handleTaskComplete", () => {
    it("schedules next nodes upon task completion", async () => {
      await engine.startWorkflow("test-workflow");

      // Reset mocks to track only next calls
      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      // Emit task:completed for node-1
      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Success",
        timestamp: Date.now(),
      });

      // Wait for async handlers
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have scheduled node-2
      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-2" }),
        })
      );
      expect(mockQueueService.enqueueTask).toHaveBeenCalledWith("task-node-2");
    });
  });

  describe("persistence integration", () => {
    it("saves workflow state after starting a workflow", async () => {
      await engine.initialize("test-project-id");
      mockPersistence.save.mockClear();

      await engine.startWorkflow("test-workflow");

      expect(mockPersistence.save).toHaveBeenCalledWith(
        "test-project-id",
        expect.arrayContaining([
          expect.objectContaining({
            workflowId: "test-workflow",
            status: "running",
          }),
        ])
      );
    });

    it("saves workflow state after cancelling a workflow", async () => {
      await engine.initialize("test-project-id");
      const runId = await engine.startWorkflow("test-workflow");
      mockPersistence.save.mockClear();

      await engine.cancelWorkflow(runId);

      expect(mockPersistence.save).toHaveBeenCalledWith(
        "test-project-id",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            status: "cancelled",
          }),
        ])
      );
    });

    it("loads workflow runs on initialize", async () => {
      const persistedRun: WorkflowRun = {
        runId: "persisted-run-1",
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        status: "completed",
        startedAt: Date.now() - 10000,
        completedAt: Date.now(),
        definition: mockWorkflow,
        nodeStates: {},
        taskMapping: {},
        scheduledNodes: new Set(),
        evaluatedConditions: [],
      };

      mockPersistence.load.mockResolvedValue([persistedRun]);

      await engine.initialize("test-project-id");

      expect(mockPersistence.load).toHaveBeenCalledWith("test-project-id");

      const runs = await engine.listAllRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe("persisted-run-1");
    });

    it("flushes on project switch", async () => {
      await engine.initialize("project-1");
      mockPersistence.flush.mockClear();

      await engine.onProjectSwitch("project-2");

      expect(mockPersistence.flush).toHaveBeenCalledWith("project-1");
      expect(mockPersistence.load).toHaveBeenCalledWith("project-2");
    });

    it("rebuilds taskToNode index on load", async () => {
      const persistedRun: WorkflowRun = {
        runId: "run-with-task-mapping",
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        status: "running",
        startedAt: Date.now(),
        definition: mockWorkflow,
        nodeStates: {
          "node-1": { status: "completed", taskId: "task-1" },
        },
        taskMapping: { "node-1": "task-1" },
        scheduledNodes: new Set(["node-1"]),
        evaluatedConditions: [],
      };

      mockPersistence.load.mockResolvedValue([persistedRun]);

      await engine.initialize("test-project-id");

      // Verify the run is loaded and has correct state
      const runs = await engine.listAllRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].taskMapping["node-1"]).toBe("task-1");
    });
  });

  describe("crash recovery", () => {
    it("marks orphaned workflows as failed when tasks are missing", async () => {
      const persistedRun: WorkflowRun = {
        runId: "orphaned-run",
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        status: "running",
        startedAt: Date.now() - 10000,
        definition: mockWorkflow,
        nodeStates: {
          "node-1": { status: "running", taskId: "missing-task" },
        },
        taskMapping: { "node-1": "missing-task" },
        scheduledNodes: new Set(["node-1"]),
        evaluatedConditions: [],
      };

      mockPersistence.load.mockResolvedValue([persistedRun]);
      // Task is missing from queue
      mockQueueService.getTask.mockResolvedValue(null);

      await engine.initialize("test-project-id");

      const runs = await engine.listAllRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("failed");
      expect(runs[0].nodeStates["node-1"].status).toBe("failed");
    });

    it("resumes monitoring for workflows with active tasks", async () => {
      const persistedRun: WorkflowRun = {
        runId: "active-run",
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        status: "running",
        startedAt: Date.now() - 10000,
        definition: mockWorkflow,
        nodeStates: {
          "node-1": { status: "running", taskId: "active-task" },
        },
        taskMapping: { "node-1": "active-task" },
        scheduledNodes: new Set(["node-1"]),
        evaluatedConditions: [],
      };

      mockPersistence.load.mockResolvedValue([persistedRun]);
      // Task is still active
      mockQueueService.getTask.mockResolvedValue({
        id: "active-task",
        status: "running",
      });

      await engine.initialize("test-project-id");

      const runs = await engine.listAllRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("running");
    });

    it("updates node state when task completed while down", async () => {
      const persistedRun: WorkflowRun = {
        runId: "recovered-run",
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        status: "running",
        startedAt: Date.now() - 10000,
        definition: mockWorkflow,
        nodeStates: {
          "node-1": { status: "running", taskId: "completed-task" },
        },
        taskMapping: { "node-1": "completed-task" },
        scheduledNodes: new Set(["node-1"]),
        evaluatedConditions: [],
      };

      mockPersistence.load.mockResolvedValue([persistedRun]);
      // Task completed while we were down
      mockQueueService.getTask.mockResolvedValue({
        id: "completed-task",
        status: "completed",
        completedAt: Date.now(),
        result: { summary: "Done" },
      });

      await engine.initialize("test-project-id");

      const runs = await engine.listAllRuns();
      expect(runs[0].nodeStates["node-1"].status).toBe("completed");
      expect(runs[0].nodeStates["node-1"].result?.summary).toBe("Done");
    });
  });
});
