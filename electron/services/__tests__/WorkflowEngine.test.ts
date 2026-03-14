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
import type { WorkflowRun, LoopNodeState } from "../../../shared/types/workflowRun.js";

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

  describe("template resolution", () => {
    const templateWorkflow: WorkflowDefinition = {
      id: "template-workflow",
      name: "Template Workflow",
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
          config: {
            actionId: "action-2",
            args: { count: "{{node-1.data.count}}", label: "static-value" },
          },
          dependencies: ["node-1"],
        },
      ],
    };

    beforeEach(() => {
      mockLoader.getWorkflow.mockResolvedValue({ definition: templateWorkflow });
    });

    it("resolves pure placeholder to raw typed value", async () => {
      await engine.startWorkflow("template-workflow");

      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { count: 42 },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "node-2",
            actionArgs: { count: 42, label: "static-value" },
          }),
        })
      );
    });

    it("resolves embedded placeholder by stringifying non-string values", async () => {
      const embeddedWorkflow: WorkflowDefinition = {
        id: "embedded-workflow",
        name: "Embedded Workflow",
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
            config: {
              actionId: "action-2",
              args: { msg: "Errors: {{node-1.data.count}} found" },
            },
            dependencies: ["node-1"],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: embeddedWorkflow });
      await engine.startWorkflow("embedded-workflow");

      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { count: 5 },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            actionArgs: { msg: "Errors: 5 found" },
          }),
        })
      );
    });

    it("passes through args without templates unchanged", async () => {
      const noTemplateWorkflow: WorkflowDefinition = {
        id: "no-template-workflow",
        name: "No Template",
        version: "1.0.0",
        nodes: [
          {
            id: "node-1",
            type: "action",
            config: { actionId: "action-1", args: { plain: "hello", num: 123 } },
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: noTemplateWorkflow });
      await engine.startWorkflow("no-template-workflow");

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            actionArgs: { plain: "hello", num: 123 },
          }),
        })
      );
    });

    it("resolves nested data paths", async () => {
      const nestedWorkflow: WorkflowDefinition = {
        id: "nested-workflow",
        name: "Nested",
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
            config: {
              actionId: "action-2",
              args: { val: "{{node-1.data.nested.deep.value}}" },
            },
            dependencies: ["node-1"],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: nestedWorkflow });
      await engine.startWorkflow("nested-workflow");

      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { nested: { deep: { value: "found-it" } } },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            actionArgs: { val: "found-it" },
          }),
        })
      );
    });

    it("can reference result.summary from upstream node", async () => {
      const summaryWorkflow: WorkflowDefinition = {
        id: "summary-workflow",
        name: "Summary Ref",
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
            config: {
              actionId: "action-2",
              args: { prevSummary: "{{node-1.summary}}" },
            },
            dependencies: ["node-1"],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: summaryWorkflow });
      await engine.startWorkflow("summary-workflow");

      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Lint passed",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            actionArgs: { prevSummary: "Lint passed" },
          }),
        })
      );
    });
  });

  describe("data flow through task:completed event", () => {
    it("stores data from task:completed payload in nodeState.result", async () => {
      await engine.startWorkflow("test-workflow");

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { errorCount: 0, files: ["a.ts", "b.ts"] },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const runs = await engine.listAllRuns();
      const nodeState = runs[0].nodeStates["node-1"];
      expect(nodeState.result?.data).toEqual({ errorCount: 0, files: ["a.ts", "b.ts"] });
    });
  });

  describe("size guard", () => {
    it("fails node when result data exceeds 1 MB", async () => {
      await engine.startWorkflow("test-workflow");

      const largeData: Record<string, unknown> = {
        bigField: "x".repeat(1_100_000),
      };

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: largeData,
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const runs = await engine.listAllRuns();
      const nodeState = runs[0].nodeStates["node-1"];
      expect(nodeState.status).toBe("failed");
      expect(nodeState.result?.error).toContain("exceeds 1 MB limit");
    });

    it("fails node and marks workflow as failed when size guard triggers", async () => {
      const singleNodeWorkflow: WorkflowDefinition = {
        id: "single-workflow",
        name: "Single Node",
        version: "1.0.0",
        nodes: [
          {
            id: "node-1",
            type: "action",
            config: { actionId: "action-1", args: {} },
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: singleNodeWorkflow });
      await engine.startWorkflow("single-workflow");

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { bigField: "x".repeat(1_100_000) },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const runs = await engine.listAllRuns();
      expect(runs[0].status).toBe("failed");
    });
  });

  describe("template error handling", () => {
    it("fails workflow when template references non-existent node", async () => {
      const badRefWorkflow: WorkflowDefinition = {
        id: "bad-ref-workflow",
        name: "Bad Ref",
        version: "1.0.0",
        nodes: [
          {
            id: "node-1",
            type: "action",
            config: {
              actionId: "action-1",
              args: { val: "{{ghost.data.x}}" },
            },
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: badRefWorkflow });

      await expect(engine.startWorkflow("bad-ref-workflow")).rejects.toThrow(
        'node "ghost" not found'
      );
    });

    it("fails workflow when template expression has no dot path", async () => {
      const noDotWorkflow: WorkflowDefinition = {
        id: "no-dot-workflow",
        name: "No Dot",
        version: "1.0.0",
        nodes: [
          {
            id: "node-1",
            type: "action",
            config: {
              actionId: "action-1",
              args: { val: "{{nodeid}}" },
            },
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: noDotWorkflow });

      await expect(engine.startWorkflow("no-dot-workflow")).rejects.toThrow(
        "must be in format {{nodeId.path}}"
      );
    });

    it("evaluates onFailure routing when failNode is triggered by size guard", async () => {
      const failoverWorkflow: WorkflowDefinition = {
        id: "failover-workflow",
        name: "Failover",
        version: "1.0.0",
        nodes: [
          {
            id: "node-1",
            type: "action",
            config: { actionId: "action-1", args: {} },
            onFailure: ["node-recovery"],
          },
          {
            id: "node-recovery",
            type: "action",
            config: { actionId: "recovery-action", args: {} },
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: failoverWorkflow });
      await engine.startWorkflow("failover-workflow");

      mockQueueService.createTask.mockClear();

      events.emit("task:completed", {
        taskId: "task-node-1",
        result: "Done",
        data: { bigField: "x".repeat(1_100_000) },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await engine.listAllRuns();
      const node1State = runs[0].nodeStates["node-1"];
      expect(node1State.status).toBe("failed");
      expect(node1State.result?.error).toContain("exceeds 1 MB limit");
      // Verify recovery node was scheduled via onFailure routing
      expect(runs[0].scheduledNodes.has("node-recovery")).toBe(true);
      expect(runs[0].nodeStates["node-recovery"]).toBeDefined();
    });
  });

  describe("loop node execution", () => {
    const loopWorkflow: WorkflowDefinition = {
      id: "loop-workflow",
      name: "Loop Workflow",
      version: "1.0.0",
      nodes: [
        {
          id: "my-loop",
          type: "loop",
          config: { maxIterations: 3 },
          body: [
            {
              id: "generate",
              type: "action",
              config: { actionId: "ai.generate" },
            },
            {
              id: "test",
              type: "action",
              config: { actionId: "test.run" },
              dependencies: ["generate"],
            },
          ],
        },
      ],
    };

    it("starts a loop and schedules iteration 0 root nodes", async () => {
      mockLoader.getWorkflow.mockResolvedValue({ definition: loopWorkflow });

      const runId = await engine.startWorkflow("loop-workflow");
      expect(runId).toBeDefined();

      // Should schedule the root body node "generate" with composite ID
      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "my-loop|0|generate",
            loopNodeId: "my-loop",
            iterIndex: 0,
            bodyNodeId: "generate",
          }),
        })
      );
    });

    it("loop exits early on exit condition", async () => {
      const exitLoopWorkflow: WorkflowDefinition = {
        id: "exit-loop",
        name: "Exit Loop",
        version: "1.0.0",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: {
              maxIterations: 5,
              exitCondition: { type: "result", path: "data.passed", op: "==", value: true },
            },
            body: [
              {
                id: "run-test",
                type: "action",
                config: { actionId: "test.run" },
              },
            ],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: exitLoopWorkflow });
      const runId = await engine.startWorkflow("exit-loop");

      // Complete iteration 0 body node with exit condition met
      events.emit("task:completed", {
        taskId: "task-my-loop|0|run-test",
        result: "Tests passed",
        data: { passed: true },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await engine.listAllRuns();
      const run = runs.find((r) => r.runId === runId)!;
      const loopState = run.nodeStates["my-loop"];

      expect(loopState.status).toBe("completed");
      expect((loopState as LoopNodeState).exitedEarly).toBe(true);
      expect((loopState as LoopNodeState).currentIteration).toBe(0);
    });

    it("loop exhausts maxIterations", async () => {
      const maxLoopWorkflow: WorkflowDefinition = {
        id: "max-loop",
        name: "Max Loop",
        version: "1.0.0",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: {
              maxIterations: 2,
              exitCondition: { type: "result", path: "data.passed", op: "==", value: true },
            },
            body: [
              {
                id: "run-test",
                type: "action",
                config: { actionId: "test.run" },
              },
            ],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: maxLoopWorkflow });
      const runId = await engine.startWorkflow("max-loop");

      // Complete iteration 0 without meeting exit condition
      events.emit("task:completed", {
        taskId: "task-my-loop|0|run-test",
        result: "Tests failed",
        data: { passed: false },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Iteration 1 should be scheduled
      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "my-loop|1|run-test",
            iterIndex: 1,
          }),
        })
      );

      // Complete iteration 1 without meeting exit condition
      events.emit("task:completed", {
        taskId: "task-my-loop|1|run-test",
        result: "Tests still failed",
        data: { passed: false },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await engine.listAllRuns();
      const run = runs.find((r) => r.runId === runId)!;
      const loopState = run.nodeStates["my-loop"];

      // Loop completes (not fails) after maxIterations
      expect(loopState.status).toBe("completed");
      expect((loopState as LoopNodeState).exitedEarly).toBe(false);
    });

    it("schedules dependent body nodes after their deps complete", async () => {
      mockLoader.getWorkflow.mockResolvedValue({ definition: loopWorkflow });
      await engine.startWorkflow("loop-workflow");

      // Only "generate" (root) should be scheduled initially
      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "my-loop|0|generate",
            bodyNodeId: "generate",
          }),
        })
      );
      // "test" should NOT be scheduled yet (depends on generate)
      expect(mockQueueService.createTask).not.toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "my-loop|0|test",
          }),
        })
      );

      // Complete "generate" — this should trigger scheduling of "test"
      events.emit("task:completed", {
        taskId: "task-my-loop|0|generate",
        result: "Generated code",
        data: { code: "hello world" },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockQueueService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            nodeId: "my-loop|0|test",
            bodyNodeId: "test",
          }),
        })
      );
    });

    it("loop with maxIterations=1 completes after single iteration", async () => {
      const singleIterWorkflow: WorkflowDefinition = {
        id: "single-iter",
        name: "Single Iteration",
        version: "1.0.0",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: {
              maxIterations: 1,
              exitCondition: { type: "result", path: "data.passed", op: "==", value: true },
            },
            body: [{ id: "run-test", type: "action", config: { actionId: "test.run" } }],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: singleIterWorkflow });
      const runId = await engine.startWorkflow("single-iter");

      // Complete iteration 0 without meeting exit condition
      events.emit("task:completed", {
        taskId: "task-my-loop|0|run-test",
        result: "Tests failed",
        data: { passed: false },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await engine.listAllRuns();
      const run = runs.find((r) => r.runId === runId)!;
      const loopState = run.nodeStates["my-loop"] as LoopNodeState;

      // Should complete (not fail) — max iterations reached
      expect(loopState.status).toBe("completed");
      expect(loopState.exitedEarly).toBe(false);
      // Should NOT have scheduled iteration 1
      expect(run.scheduledNodes.has("my-loop|1|run-test")).toBe(false);
    });

    it("loop body failure causes loop to fail", async () => {
      mockLoader.getWorkflow.mockResolvedValue({ definition: loopWorkflow });
      const runId = await engine.startWorkflow("loop-workflow");

      // Fail the root body node in iteration 0
      events.emit("task:failed", {
        taskId: "task-my-loop|0|generate",
        error: "Generation failed",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await engine.listAllRuns();
      const run = runs.find((r) => r.runId === runId)!;
      const loopState = run.nodeStates["my-loop"];

      expect(loopState.status).toBe("failed");
    });

    it("checkWorkflowCompletion ignores composite IDs", async () => {
      const loopWithSuccessor: WorkflowDefinition = {
        id: "loop-successor",
        name: "Loop Successor",
        version: "1.0.0",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 1 },
            onSuccess: ["final"],
            body: [
              {
                id: "body-step",
                type: "action",
                config: { actionId: "test" },
              },
            ],
          },
          {
            id: "final",
            type: "action",
            config: { actionId: "report" },
            dependencies: ["my-loop"],
          },
        ],
      };

      mockLoader.getWorkflow.mockResolvedValue({ definition: loopWithSuccessor });
      const runId = await engine.startWorkflow("loop-successor");

      // Complete the body task (iteration 0)
      events.emit("task:completed", {
        taskId: "task-my-loop|0|body-step",
        result: "Done",
        data: {},
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Loop should be completed and "final" should be scheduled
      const runs = await engine.listAllRuns();
      const run = runs.find((r) => r.runId === runId)!;
      expect(run.nodeStates["my-loop"].status).toBe("completed");
      expect(run.scheduledNodes.has("final")).toBe(true);

      // Complete the final node
      events.emit("task:completed", {
        taskId: "task-final",
        result: "Report done",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runsAfter = await engine.listAllRuns();
      const runAfter = runsAfter.find((r) => r.runId === runId)!;
      // Workflow should be completed, not failed — composite IDs should not count
      expect(runAfter.status).toBe("completed");
    });
  });
});
