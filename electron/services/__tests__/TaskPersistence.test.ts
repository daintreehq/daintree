import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../persistence/db.js", () => ({
  openDb: vi.fn(),
  getSharedDb: vi.fn(),
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { TaskPersistence } from "../persistence/TaskPersistence.js";
import type { TaskRecord } from "../../../shared/types/task.js";
import * as schema from "../persistence/schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    queued_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    dependencies TEXT NOT NULL DEFAULT '[]',
    worktree_id TEXT,
    assigned_agent_id TEXT,
    run_id TEXT,
    metadata TEXT,
    result TEXT,
    routing_hints TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);
`;

describe("TaskPersistence", () => {
  let persistence: TaskPersistence;
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let testProjectId: string;

  const createTestTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Task",
    status: "draft",
    priority: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dependencies: [],
    dependents: [],
    ...overrides,
  });

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    testProjectId = "a".repeat(64);
    persistence = new TaskPersistence(db, 0);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("save and load", () => {
    it("saves and loads tasks correctly", async () => {
      const tasks = [
        createTestTask({ title: "Task 1", priority: 10 }),
        createTestTask({ title: "Task 2", priority: 5 }),
      ];

      await persistence.save(testProjectId, tasks);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(2);
      const t1 = loaded.find((t) => t.title === "Task 1");
      const t2 = loaded.find((t) => t.title === "Task 2");
      expect(t1?.priority).toBe(10);
      expect(t2?.priority).toBe(5);
    });

    it("saves tasks with dependencies", async () => {
      const task1 = createTestTask({ id: "task-1", title: "Task 1" });
      const task2 = createTestTask({
        id: "task-2",
        title: "Task 2",
        dependencies: ["task-1"],
      });

      await persistence.save(testProjectId, [task1, task2]);
      const loaded = await persistence.load(testProjectId);

      const loadedTask2 = loaded.find((t) => t.id === "task-2");
      expect(loadedTask2?.dependencies).toEqual(["task-1"]);
    });

    it("saves tasks with metadata", async () => {
      const task = createTestTask({
        metadata: { custom: "value", nested: { key: "val" } },
      });

      await persistence.save(testProjectId, [task]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].metadata).toEqual({ custom: "value", nested: { key: "val" } });
    });

    it("saves tasks with result", async () => {
      const task = createTestTask({
        status: "completed",
        result: { summary: "Done!", artifacts: ["/path/to/file.txt"] },
      });

      await persistence.save(testProjectId, [task]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].result?.summary).toBe("Done!");
      expect(loaded[0].result?.artifacts).toEqual(["/path/to/file.txt"]);
    });

    it("saves tasks with routingHints", async () => {
      const task = createTestTask({
        routingHints: { requiredCapabilities: ["javascript"], preferredDomains: ["frontend"] },
      });

      await persistence.save(testProjectId, [task]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].routingHints?.requiredCapabilities).toEqual(["javascript"]);
    });

    it("returns empty array for non-existent project", async () => {
      const loaded = await persistence.load("b".repeat(64));
      expect(loaded).toEqual([]);
    });

    it("overwrites existing tasks on subsequent saves", async () => {
      const tasks = [createTestTask({ title: "Original" })];
      await persistence.save(testProjectId, tasks);

      const updated = [createTestTask({ title: "Updated" })];
      await persistence.save(testProjectId, updated);

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].title).toBe("Updated");
    });

    it("saves empty array (clears project tasks)", async () => {
      const tasks = [createTestTask()];
      await persistence.save(testProjectId, tasks);

      await persistence.save(testProjectId, []);
      const loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);
    });

    it("isolates tasks by project", async () => {
      const projectA = "a".repeat(64);
      const projectB = "b".repeat(64);

      await persistence.save(projectA, [createTestTask({ title: "Task A" })]);
      await persistence.save(projectB, [createTestTask({ title: "Task B" })]);

      const loadedA = await persistence.load(projectA);
      const loadedB = await persistence.load(projectB);

      expect(loadedA).toHaveLength(1);
      expect(loadedA[0].title).toBe("Task A");
      expect(loadedB).toHaveLength(1);
      expect(loadedB[0].title).toBe("Task B");
    });
  });

  describe("flush", () => {
    it("flushes pending saves immediately", async () => {
      const slowPersistence = new TaskPersistence(db, 5000);

      const tasks = [createTestTask()];
      slowPersistence.save(testProjectId, tasks);

      await slowPersistence.flush(testProjectId);

      const loaded = await slowPersistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
    });

    it("flush is a no-op when no pending save", async () => {
      await expect(persistence.flush(testProjectId)).resolves.not.toThrow();
    });
  });

  describe("clear", () => {
    it("removes tasks for project", async () => {
      const tasks = [createTestTask()];
      await persistence.save(testProjectId, tasks);

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
      const slowPersistence = new TaskPersistence(db, 5000);

      vi.useFakeTimers();
      try {
        const tasks = [createTestTask()];
        const pendingSave = slowPersistence.save(testProjectId, tasks);

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
    it("returns empty array for invalid project ID", async () => {
      const loaded = await persistence.load("invalid-project-id");
      expect(loaded).toEqual([]);
    });

    it("rejects project IDs that could cause injection", async () => {
      const loaded = await persistence.load("'; DROP TABLE tasks; --");
      expect(loaded).toEqual([]);
    });

    it("rejects save for invalid project IDs immediately", async () => {
      await expect(persistence.save("invalid-project-id", [createTestTask()])).rejects.toThrow(
        "Invalid project ID"
      );
    });
  });

  describe("all task fields round-trip", () => {
    it("preserves all optional timestamp fields", async () => {
      const now = Date.now();
      const task = createTestTask({
        status: "completed",
        queuedAt: now - 3000,
        startedAt: now - 2000,
        completedAt: now - 1000,
        worktreeId: "wt-abc",
        assignedAgentId: "agent-123",
        runId: "run-456",
      });

      await persistence.save(testProjectId, [task]);
      const loaded = await persistence.load(testProjectId);

      expect(loaded[0].queuedAt).toBe(task.queuedAt);
      expect(loaded[0].startedAt).toBe(task.startedAt);
      expect(loaded[0].completedAt).toBe(task.completedAt);
      expect(loaded[0].worktreeId).toBe("wt-abc");
      expect(loaded[0].assignedAgentId).toBe("agent-123");
      expect(loaded[0].runId).toBe("run-456");
    });
  });

  describe("debounce coalescing", () => {
    it("last-write wins when multiple saves are queued for same project", async () => {
      const slowPersistence = new TaskPersistence(db, 5000);

      vi.useFakeTimers();
      try {
        const first = [createTestTask({ title: "First" })];
        const second = [createTestTask({ title: "Second" })];

        const p1 = slowPersistence.save(testProjectId, first);
        const p2 = slowPersistence.save(testProjectId, second);

        vi.advanceTimersByTime(6000);

        await Promise.all([p1, p2]);

        const loaded = await slowPersistence.load(testProjectId);
        expect(loaded).toHaveLength(1);
        expect(loaded[0].title).toBe("Second");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
