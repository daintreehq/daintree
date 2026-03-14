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

  const settle = () => new Promise((r) => setTimeout(r, 10));

  describe("handleTaskFailed", () => {
    it("schedules onFailure targets and keeps the workflow running", async () => {
      const failureWorkflow: WorkflowDefinition = {
        id: "failure-routing",
        name: "Failure Routing Workflow",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onFailure: ["node-err"],
          },
          {
            id: "node-err",
            type: "action",
            config: { actionId: "act-err" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: failureWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("failure-routing");

      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      events.emit("task:failed", {
        taskId: "task-node-a",
        error: "boom",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-err" }),
        })
      );
      expect(mockQueueService.enqueueTask).toHaveBeenCalledWith("task-node-err");

      const runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("running");
    });

    it("marks the workflow failed immediately when no onFailure targets exist", async () => {
      const noFailureWorkflow: WorkflowDefinition = {
        id: "no-failure-routing",
        name: "No Failure Routing Workflow",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: noFailureWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("no-failure-routing");

      mockQueueService.createTask.mockClear();

      events.emit("task:failed", {
        taskId: "task-node-a",
        error: "something broke",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).not.toHaveBeenCalled();

      const runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("failed");
      expect(runs[0].completedAt).toBeDefined();
    });
  });

  describe("conditional routing — status conditions", () => {
    it("routes onSuccess when a status condition passes", async () => {
      const condWorkflow: WorkflowDefinition = {
        id: "cond-pass",
        name: "Conditional Pass",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [{ type: "status", op: "==", value: "completed" }],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: condWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("cond-pass");
      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Success",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-b" }),
        })
      );

      const runs = await engine.listAllRuns();
      expect(runs[0].evaluatedConditions).toHaveLength(1);
      expect(runs[0].evaluatedConditions[0].result).toBe(true);
    });

    it("blocks routing when a status condition fails", async () => {
      const condWorkflow: WorkflowDefinition = {
        id: "cond-fail",
        name: "Conditional Fail",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [{ type: "status", op: "==", value: "failed" }],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: condWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("cond-fail");
      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Success",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).not.toHaveBeenCalled();

      const runs = await engine.listAllRuns();
      expect(runs[0].evaluatedConditions).toHaveLength(1);
      expect(runs[0].evaluatedConditions[0].result).toBe(false);
    });

    it("requires ALL conditions to pass (short-circuits on first failure)", async () => {
      const condWorkflow: WorkflowDefinition = {
        id: "cond-multi",
        name: "Multi Condition",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [
              { type: "status", op: "!=", value: "completed" },
              { type: "status", op: "==", value: "completed" },
            ],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: condWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("cond-multi");
      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Success",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).not.toHaveBeenCalled();

      const runs = await engine.listAllRuns();
      // .every() short-circuits: only the first (false) condition is recorded
      expect(runs[0].evaluatedConditions).toHaveLength(1);
      expect(runs[0].evaluatedConditions[0].result).toBe(false);
    });

    it("evaluates cross-node status conditions via condition.taskId", async () => {
      // node-b's condition checks that node-a is "completed".
      // We complete node-a first, then fail node-b (via onFailure routing).
      // The condition reads node-a's state (completed), NOT node-b's state (failed).
      // If the engine ignored taskId, it would read "failed" and the condition would fail.
      const crossNodeWorkflow: WorkflowDefinition = {
        id: "cross-node",
        name: "Cross Node Condition",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            onFailure: ["node-c"],
            conditions: [{ type: "status", taskId: "node-a", op: "==", value: "completed" }],
          },
          {
            id: "node-c",
            type: "action",
            config: { actionId: "act-3" },
            dependencies: ["node-b"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: crossNodeWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("cross-node");

      // Complete node-a so its state is "completed"
      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Done",
        timestamp: Date.now(),
      });
      await settle();

      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      // Fail node-b — its onFailure condition references node-a's status ("completed"),
      // NOT node-b's own status ("failed"). This distinguishes cross-node from self lookup.
      events.emit("task:failed", {
        taskId: "task-node-b",
        error: "node-b broke",
        timestamp: Date.now(),
      });
      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-c" }),
        })
      );
    });
  });

  describe("conditional routing — result conditions", () => {
    it("routes when a result condition matches a nested path", async () => {
      const resultWorkflow: WorkflowDefinition = {
        id: "result-pass",
        name: "Result Condition Pass",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [{ type: "result", path: "summary", op: "==", value: "Success" }],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: resultWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("result-pass");
      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Success",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-b" }),
        })
      );

      const runs = await engine.listAllRuns();
      expect(runs[0].evaluatedConditions[0].result).toBe(true);
    });

    it("blocks routing when result path resolves to a missing key", async () => {
      const resultWorkflow: WorkflowDefinition = {
        id: "result-missing",
        name: "Result Missing Key",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [{ type: "result", path: "missing.key", op: "==", value: "anything" }],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: resultWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("result-missing");
      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Done",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).not.toHaveBeenCalled();

      const runs = await engine.listAllRuns();
      expect(runs[0].evaluatedConditions[0].result).toBe(false);
    });

    it("blocks routing when result path crosses a non-object intermediate", async () => {
      const resultWorkflow: WorkflowDefinition = {
        id: "result-nonobj",
        name: "Result Non-Object Path",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onSuccess: ["node-b"],
            conditions: [{ type: "result", path: "summary.nested", op: "==", value: "x" }],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: resultWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("result-nonobj");
      mockQueueService.createTask.mockClear();

      // "Done" becomes { summary: "Done" } — summary is a string, not an object
      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Done",
        timestamp: Date.now(),
      });

      await settle();

      expect(mockQueueService.createTask).not.toHaveBeenCalled();

      const runs = await engine.listAllRuns();
      expect(runs[0].evaluatedConditions[0].result).toBe(false);
    });

    it("evaluates cross-node result conditions via condition.taskId", async () => {
      const crossResultWorkflow: WorkflowDefinition = {
        id: "cross-result",
        name: "Cross Node Result",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-2" },
            onSuccess: ["node-c"],
            conditions: [
              { type: "result", taskId: "node-a", path: "summary", op: "==", value: "Done" },
            ],
          },
          {
            id: "node-c",
            type: "action",
            config: { actionId: "act-3" },
            dependencies: ["node-b"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: crossResultWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("cross-result");

      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "Done",
        timestamp: Date.now(),
      });
      await settle();

      mockQueueService.createTask.mockClear();
      mockQueueService.enqueueTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-b",
        result: "Also done",
        timestamp: Date.now(),
      });
      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-c" }),
        })
      );
    });
  });

  describe("diamond DAG completion", () => {
    it("wires fan-in dependencies correctly and deduplicates scheduling", async () => {
      // True diamond: A → B and A → C, then B → D and C → D.
      // D has dependencies on both B and C (fan-in).
      // The engine schedules D when the first upstream (B or C) completes,
      // wiring both dep task IDs. The scheduledNodes guard prevents the second
      // upstream from scheduling D again. Fan-in ordering is enforced by the
      // task queue via the `dependencies` array.
      const diamondWorkflow: WorkflowDefinition = {
        id: "diamond",
        name: "Diamond DAG",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-a" },
            onSuccess: ["node-b", "node-c"],
          },
          {
            id: "node-b",
            type: "action",
            config: { actionId: "act-b" },
            dependencies: ["node-a"],
            onSuccess: ["node-d"],
          },
          {
            id: "node-c",
            type: "action",
            config: { actionId: "act-c" },
            dependencies: ["node-a"],
            onSuccess: ["node-d"],
          },
          {
            id: "node-d",
            type: "action",
            config: { actionId: "act-d" },
            dependencies: ["node-b", "node-c"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: diamondWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("diamond");

      // Complete node-a → both node-b and node-c get scheduled
      events.emit("task:completed", {
        taskId: "task-node-a",
        result: "A done",
        timestamp: Date.now(),
      });
      await settle();

      const createCalls1 = mockQueueService.createTask.mock.calls;
      const scheduledNodeIds1 = createCalls1.map(
        (call: [{ metadata: { nodeId: string } }]) => call[0].metadata.nodeId
      );
      expect(scheduledNodeIds1).toContain("node-b");
      expect(scheduledNodeIds1).toContain("node-c");
      expect(scheduledNodeIds1).not.toContain("node-d");

      mockQueueService.createTask.mockClear();

      // Complete node-b → node-d gets scheduled with both B and C task dependencies
      // (C was already scheduled so its taskMapping exists)
      events.emit("task:completed", {
        taskId: "task-node-b",
        result: "B done",
        timestamp: Date.now(),
      });
      await settle();

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ nodeId: "node-d" }),
          dependencies: expect.arrayContaining(["task-node-b", "task-node-c"]),
        })
      );

      mockQueueService.createTask.mockClear();

      // Complete node-c → node-d should NOT be scheduled again (dedup guard)
      events.emit("task:completed", {
        taskId: "task-node-c",
        result: "C done",
        timestamp: Date.now(),
      });
      await settle();

      const createCalls3 = mockQueueService.createTask.mock.calls;
      const scheduledNodeIds3 = createCalls3.map(
        (call: [{ metadata: { nodeId: string } }]) => call[0].metadata.nodeId
      );
      expect(scheduledNodeIds3).not.toContain("node-d");

      // Complete node-d → workflow should complete
      events.emit("task:completed", {
        taskId: "task-node-d",
        result: "D done",
        timestamp: Date.now(),
      });
      await settle();

      const runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("completed");
      expect(runs[0].completedAt).toBeDefined();
    });
  });

  describe("checkWorkflowCompletion", () => {
    it("marks workflow as failed via completion check when a scheduled node has failed", async () => {
      // node-a fails but has onFailure routing to node-err, keeping the run "running".
      // node-err completes. Now all scheduled nodes are terminal (node-a: failed, node-err: completed).
      // checkWorkflowCompletion fires and detects the failed node → workflow status = "failed".
      const completionWorkflow: WorkflowDefinition = {
        id: "completion-check",
        name: "Completion Check Workflow",
        version: "1.0.0",
        nodes: [
          {
            id: "node-a",
            type: "action",
            config: { actionId: "act-1" },
            onFailure: ["node-err"],
          },
          {
            id: "node-err",
            type: "action",
            config: { actionId: "act-err" },
            dependencies: ["node-a"],
          },
        ],
      };

      mockLoader.getWorkflow = vi.fn().mockResolvedValue({ definition: completionWorkflow });
      mockQueueService.createTask = vi.fn().mockImplementation((params) => ({
        id: `task-${params.metadata.nodeId}`,
        status: "queued",
        ...params,
      }));
      mockQueueService.enqueueTask = vi.fn().mockResolvedValue(undefined);
      mockPersistence.save = vi.fn().mockResolvedValue(undefined);

      await engine.startWorkflow("completion-check");

      // Fail node-a → onFailure routes to node-err, run stays "running"
      events.emit("task:failed", {
        taskId: "task-node-a",
        error: "something broke",
        timestamp: Date.now(),
      });
      await settle();

      let runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("running");

      // Complete node-err → all scheduled nodes are terminal now
      // checkWorkflowCompletion sees node-a is "failed" → workflow fails
      events.emit("task:completed", {
        taskId: "task-node-err",
        result: "Recovered",
        timestamp: Date.now(),
      });
      await settle();

      runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("failed");
      expect(runs[0].completedAt).toBeDefined();
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
