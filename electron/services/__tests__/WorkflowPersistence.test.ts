/**
 * Tests for WorkflowPersistence - file-based workflow run state persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { WorkflowPersistence } from "../persistence/WorkflowPersistence.js";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";

// Mock electron app for testing
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

describe("WorkflowPersistence", () => {
  let persistence: WorkflowPersistence;
  let testProjectId: string;
  let testDir: string;

  const mockWorkflowDefinition: WorkflowDefinition = {
    id: "test-workflow",
    name: "Test Workflow",
    version: "1.0.0",
    nodes: [
      {
        id: "node-1",
        type: "action",
        config: { actionId: "action-1" },
      },
    ],
  };

  const createTestRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "test-workflow",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: Date.now(),
    definition: mockWorkflowDefinition,
    nodeStates: {},
    taskMapping: {},
    scheduledNodes: new Set(),
    evaluatedConditions: [],
    ...overrides,
  });

  beforeEach(async () => {
    // Create a unique test directory for each test
    testDir = path.join(os.tmpdir(), `workflow-persistence-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Use a valid SHA-256 hash as project ID (64 hex chars)
    testProjectId = "a".repeat(64);

    // Create persistence with 0 debounce for immediate saves in tests
    persistence = new WorkflowPersistence(0);

    // Override the projects config dir for testing
    (persistence as unknown as { projectsConfigDir: string }).projectsConfigDir = testDir;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("save and load", () => {
    it("saves and loads workflow runs correctly", async () => {
      const runs = [
        createTestRun({ workflowId: "workflow-1" }),
        createTestRun({ workflowId: "workflow-2" }),
      ];

      await persistence.save(testProjectId, runs);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(2);
      expect(loaded[0].workflowId).toBe("workflow-1");
      expect(loaded[1].workflowId).toBe("workflow-2");
    });

    it("saves and loads workflow runs with node states", async () => {
      const run = createTestRun({
        nodeStates: {
          "node-1": {
            status: "completed",
            taskId: "task-1",
            startedAt: Date.now() - 1000,
            completedAt: Date.now(),
            result: { summary: "Success" },
          },
        },
        taskMapping: { "node-1": "task-1" },
      });

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].nodeStates["node-1"].status).toBe("completed");
      expect(loaded[0].nodeStates["node-1"].result?.summary).toBe("Success");
      expect(loaded[0].taskMapping["node-1"]).toBe("task-1");
    });

    it("correctly serializes and deserializes Set<string>", async () => {
      const run = createTestRun();
      run.scheduledNodes.add("node-1");
      run.scheduledNodes.add("node-2");

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].scheduledNodes).toBeInstanceOf(Set);
      expect(loaded[0].scheduledNodes.has("node-1")).toBe(true);
      expect(loaded[0].scheduledNodes.has("node-2")).toBe(true);
      expect(loaded[0].scheduledNodes.size).toBe(2);
    });

    it("saves workflow runs with evaluated conditions", async () => {
      const run = createTestRun({
        evaluatedConditions: [
          {
            nodeId: "node-1",
            condition: { type: "status", op: "==", value: "completed" },
            result: true,
            timestamp: Date.now(),
          },
        ],
      });

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].evaluatedConditions).toHaveLength(1);
      expect(loaded[0].evaluatedConditions[0].result).toBe(true);
    });

    it("returns empty array for non-existent project", async () => {
      const loaded = await persistence.load("b".repeat(64));
      expect(loaded).toEqual([]);
    });

    it("creates project directory if it does not exist", async () => {
      const runs = [createTestRun()];
      await persistence.save(testProjectId, runs);

      const projectDir = path.join(testDir, testProjectId);
      const exists = await fs
        .access(projectDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("preserves workflow definition in persisted runs", async () => {
      const customDefinition: WorkflowDefinition = {
        id: "custom-workflow",
        name: "Custom Workflow",
        version: "2.0.0",
        description: "A custom test workflow",
        nodes: [
          {
            id: "custom-node",
            type: "action",
            config: { actionId: "custom-action", args: { foo: "bar" } },
          },
        ],
      };

      const run = createTestRun({ definition: customDefinition });

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].definition.id).toBe("custom-workflow");
      expect(loaded[0].definition.name).toBe("Custom Workflow");
      expect(loaded[0].definition.nodes[0].config.args).toEqual({ foo: "bar" });
    });
  });

  describe("corruption handling", () => {
    it("quarantines corrupted file and returns empty array", async () => {
      const projectDir = path.join(testDir, testProjectId);
      await fs.mkdir(projectDir, { recursive: true });

      const filePath = path.join(projectDir, "workflow-runs.json");
      await fs.writeFile(filePath, "{ invalid json }", "utf-8");

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);

      // Check quarantine file exists (with timestamp suffix)
      const files = await fs.readdir(projectDir);
      const quarantineFiles = files.filter((f) => f.startsWith("workflow-runs.json.corrupted."));
      expect(quarantineFiles.length).toBeGreaterThan(0);
    });

    it("quarantines file with invalid schema", async () => {
      const projectDir = path.join(testDir, testProjectId);
      await fs.mkdir(projectDir, { recursive: true });

      const filePath = path.join(projectDir, "workflow-runs.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: "1.0",
          runs: [{ runId: 123, workflowId: "test" }], // runId should be string
          lastUpdated: Date.now(),
        }),
        "utf-8"
      );

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);

      const files = await fs.readdir(projectDir);
      const quarantineFiles = files.filter((f) => f.startsWith("workflow-runs.json.corrupted."));
      expect(quarantineFiles.length).toBeGreaterThan(0);
    });
  });

  describe("atomic writes", () => {
    it("uses temp file for atomic write", async () => {
      const runs = [createTestRun()];

      // Spy on fs operations
      const writeSpy = vi.spyOn(fs, "writeFile");
      const renameSpy = vi.spyOn(fs, "rename");

      await persistence.save(testProjectId, runs);

      // Should write to temp file then rename
      expect(writeSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();

      const writeCall = writeSpy.mock.calls[0];
      const renameCall = renameSpy.mock.calls[0];

      // Temp file should have .tmp extension
      expect(String(writeCall[0])).toContain(".tmp");
      // Rename should be from temp to final
      expect(String(renameCall[0])).toContain(".tmp");
      expect(String(renameCall[1])).toContain("workflow-runs.json");
      expect(String(renameCall[1])).not.toContain(".tmp");

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  describe("flush", () => {
    it("flushes pending saves immediately", async () => {
      // Create persistence with longer debounce
      const slowPersistence = new WorkflowPersistence(5000);
      (slowPersistence as unknown as { projectsConfigDir: string }).projectsConfigDir = testDir;

      const runs = [createTestRun()];

      // This starts a debounced save
      slowPersistence.save(testProjectId, runs);

      // Flush should force immediate save
      await slowPersistence.flush(testProjectId);

      // Verify file was saved
      const loaded = await slowPersistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("removes workflow runs file for project", async () => {
      const runs = [createTestRun()];
      await persistence.save(testProjectId, runs);

      // Verify file exists
      let loaded = await persistence.load(testProjectId);
      expect(loaded).toHaveLength(1);

      // Clear
      await persistence.clear(testProjectId);

      // Verify file is gone
      loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);
    });

    it("does not throw when clearing non-existent project", async () => {
      await expect(persistence.clear("c".repeat(64))).resolves.not.toThrow();
    });
  });

  describe("project ID validation", () => {
    it("returns empty for invalid project ID", async () => {
      const loaded = await persistence.load("invalid-project-id");
      expect(loaded).toEqual([]);
    });

    it("rejects project IDs that could cause path traversal", async () => {
      const loaded = await persistence.load("../../../etc/passwd");
      expect(loaded).toEqual([]);
    });
  });

  describe("schema versioning", () => {
    it("includes version in saved data", async () => {
      const runs = [createTestRun()];
      await persistence.save(testProjectId, runs);

      const filePath = path.join(testDir, testProjectId, "workflow-runs.json");
      const content = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(content);

      expect(data.version).toBe("1.0");
      expect(data.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe("multiple workflow runs", () => {
    it("saves and loads runs with different statuses", async () => {
      const runs = [
        createTestRun({ status: "running" }),
        createTestRun({ status: "completed", completedAt: Date.now() }),
        createTestRun({ status: "failed", completedAt: Date.now() }),
        createTestRun({ status: "cancelled", completedAt: Date.now() }),
      ];

      await persistence.save(testProjectId, runs);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(4);
      expect(loaded.map((r) => r.status).sort()).toEqual([
        "cancelled",
        "completed",
        "failed",
        "running",
      ]);
    });
  });
});
