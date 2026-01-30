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
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQueueService: any;

  const mockWorkflow: WorkflowDefinition = {
    id: "test-workflow",
    name: "Test Workflow",
    version: "1.0",
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

    engine = new WorkflowEngine(
      mockLoader as unknown as WorkflowLoader,
      mockQueueService as unknown as TaskQueueService
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
});
