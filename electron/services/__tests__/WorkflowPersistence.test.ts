import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../persistence/db.js", () => ({
  openDb: vi.fn(),
  getSharedDb: vi.fn(),
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { WorkflowPersistence } from "../persistence/WorkflowPersistence.js";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";
import * as schema from "../persistence/schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    definition TEXT NOT NULL,
    node_states TEXT NOT NULL DEFAULT '{}',
    task_mapping TEXT NOT NULL DEFAULT '{}',
    scheduled_nodes TEXT NOT NULL DEFAULT '[]',
    evaluated_conditions TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS workflow_runs_project_idx ON workflow_runs(project_id);
  CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx ON workflow_runs(project_id, status);
`;

describe("WorkflowPersistence", () => {
  let persistence: WorkflowPersistence;
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let testProjectId: string;

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

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    testProjectId = "a".repeat(64);
    persistence = new WorkflowPersistence(db, 0);
  });

  afterEach(() => {
    sqlite.close();
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
      const ids = loaded.map((r) => r.workflowId).sort();
      expect(ids).toEqual(["workflow-1", "workflow-2"]);
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
      const node = loaded[0].definition.nodes[0];
      expect(node.type === "action" && node.config.args).toEqual({ foo: "bar" });
    });

    it("overwrites existing runs on subsequent saves", async () => {
      const runs = [createTestRun({ workflowId: "old-workflow" })];
      await persistence.save(testProjectId, runs);

      const updated = [createTestRun({ workflowId: "new-workflow" })];
      await persistence.save(testProjectId, updated);

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].workflowId).toBe("new-workflow");
    });

    it("isolates runs by project", async () => {
      const projectA = "a".repeat(64);
      const projectB = "b".repeat(64);

      await persistence.save(projectA, [createTestRun({ workflowId: "wf-a" })]);
      await persistence.save(projectB, [createTestRun({ workflowId: "wf-b" })]);

      const loadedA = await persistence.load(projectA);
      const loadedB = await persistence.load(projectB);

      expect(loadedA[0].workflowId).toBe("wf-a");
      expect(loadedB[0].workflowId).toBe("wf-b");
    });
  });

  describe("flush", () => {
    it("flushes pending saves immediately", async () => {
      const slowPersistence = new WorkflowPersistence(db, 5000);

      const runs = [createTestRun()];
      slowPersistence.save(testProjectId, runs);

      await slowPersistence.flush(testProjectId);

      const loaded = await slowPersistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
    });

    it("flush is a no-op when no pending save", async () => {
      await expect(persistence.flush(testProjectId)).resolves.not.toThrow();
    });
  });

  describe("clear", () => {
    it("removes workflow runs for project", async () => {
      const runs = [createTestRun()];
      await persistence.save(testProjectId, runs);

      let loaded = await persistence.load(testProjectId);
      expect(loaded).toHaveLength(1);

      await persistence.clear(testProjectId);

      loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);
    });

    it("does not throw when clearing non-existent project", async () => {
      await expect(persistence.clear("c".repeat(64))).resolves.not.toThrow();
    });

    it("cancels pending debounced saves so cleared state is not resurrected", async () => {
      const slowPersistence = new WorkflowPersistence(db, 5000);

      vi.useFakeTimers();
      try {
        const runs = [createTestRun()];
        const pendingSave = slowPersistence.save(testProjectId, runs);

        await slowPersistence.clear(testProjectId);
        vi.advanceTimersByTime(6000);

        await expect(pendingSave).resolves.toBeUndefined();
        const loaded = await slowPersistence.load(testProjectId);
        expect(loaded).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("project ID validation", () => {
    it("returns empty for invalid project ID", async () => {
      const loaded = await persistence.load("invalid-project-id");
      expect(loaded).toEqual([]);
    });

    it("rejects project IDs that could cause injection", async () => {
      const loaded = await persistence.load("'; DROP TABLE workflow_runs; --");
      expect(loaded).toEqual([]);
    });

    it("rejects save for invalid project IDs immediately", async () => {
      await expect(persistence.save("invalid-project-id", [createTestRun()])).rejects.toThrow(
        "Invalid project ID"
      );
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

    it("preserves empty scheduledNodes Set", async () => {
      const run = createTestRun();
      expect(run.scheduledNodes.size).toBe(0);

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].scheduledNodes).toBeInstanceOf(Set);
      expect(loaded[0].scheduledNodes.size).toBe(0);
    });

    it("preserves NodeState with only required status field (all optional fields absent)", async () => {
      const run = createTestRun({
        nodeStates: {
          "node-minimal": { status: "queued" },
          "node-with-task": { status: "running", taskId: "task-abc" },
        },
      });

      await persistence.save(testProjectId, [run]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].nodeStates["node-minimal"].status).toBe("queued");
      expect(loaded[0].nodeStates["node-minimal"].taskId).toBeUndefined();
      expect(loaded[0].nodeStates["node-minimal"].startedAt).toBeUndefined();
      expect(loaded[0].nodeStates["node-with-task"].taskId).toBe("task-abc");
    });

    it("last-write wins when multiple saves are queued for same project", async () => {
      const slowPersistence = new WorkflowPersistence(db, 5000);

      vi.useFakeTimers();
      try {
        const first = [createTestRun({ workflowId: "first" })];
        const second = [createTestRun({ workflowId: "second" })];

        const p1 = slowPersistence.save(testProjectId, first);
        const p2 = slowPersistence.save(testProjectId, second);

        vi.advanceTimersByTime(6000);

        await Promise.all([p1, p2]);

        const loaded = await slowPersistence.load(testProjectId);
        expect(loaded).toHaveLength(1);
        expect(loaded[0].workflowId).toBe("second");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
