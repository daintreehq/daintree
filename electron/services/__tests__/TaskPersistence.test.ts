/**
 * Tests for TaskPersistence - file-based task queue persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { TaskPersistence } from "../persistence/TaskPersistence.js";
import type { TaskRecord } from "../../../shared/types/task.js";

// Mock electron app for testing
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

describe("TaskPersistence", () => {
  let persistence: TaskPersistence;
  let testProjectId: string;
  let testDir: string;

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

  beforeEach(async () => {
    // Create a unique test directory for each test
    testDir = path.join(os.tmpdir(), `task-persistence-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Use a valid SHA-256 hash as project ID (64 hex chars)
    testProjectId = "a".repeat(64);

    // Create persistence with 0 debounce for immediate saves in tests
    persistence = new TaskPersistence(0);

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
    it("saves and loads tasks correctly", async () => {
      const tasks = [
        createTestTask({ title: "Task 1", priority: 10 }),
        createTestTask({ title: "Task 2", priority: 5 }),
      ];

      await persistence.save(testProjectId, tasks);
      const loaded = await persistence.load(testProjectId);

      expect(loaded).toHaveLength(2);
      expect(loaded[0].title).toBe("Task 1");
      expect(loaded[0].priority).toBe(10);
      expect(loaded[1].title).toBe("Task 2");
      expect(loaded[1].priority).toBe(5);
    });

    it("saves tasks with dependencies", async () => {
      const task1 = createTestTask({ id: "task-1", title: "Task 1" });
      const task2 = createTestTask({
        id: "task-2",
        title: "Task 2",
        dependencies: ["task-1"],
        blockedBy: ["task-1"],
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

    it("returns empty array for non-existent project", async () => {
      const loaded = await persistence.load("b".repeat(64));
      expect(loaded).toEqual([]);
    });

    it("creates project directory if it does not exist", async () => {
      const tasks = [createTestTask()];
      await persistence.save(testProjectId, tasks);

      const projectDir = path.join(testDir, testProjectId);
      const exists = await fs
        .access(projectDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe("corruption handling", () => {
    it("quarantines corrupted file and returns empty array", async () => {
      const projectDir = path.join(testDir, testProjectId);
      await fs.mkdir(projectDir, { recursive: true });

      const filePath = path.join(projectDir, "tasks.json");
      await fs.writeFile(filePath, "{ invalid json }", "utf-8");

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);

      // Check quarantine file exists (with timestamp suffix)
      const checkDir = path.join(testDir, testProjectId);
      const files = await fs.readdir(checkDir);
      const quarantineFiles = files.filter((f) => f.startsWith("tasks.json.corrupted."));
      expect(quarantineFiles.length).toBeGreaterThan(0);
    });

    it("quarantines file with invalid schema", async () => {
      const projectDir = path.join(testDir, testProjectId);
      await fs.mkdir(projectDir, { recursive: true });

      const filePath = path.join(projectDir, "tasks.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: "1.0",
          tasks: [{ id: 123, title: "Invalid ID type" }], // id should be string
          lastUpdated: Date.now(),
        }),
        "utf-8"
      );

      const loaded = await persistence.load(testProjectId);
      expect(loaded).toEqual([]);

      // Check quarantine file exists (with timestamp suffix)
      const checkFiles = await fs.readdir(projectDir);
      const quarantineFiles = checkFiles.filter((f) => f.startsWith("tasks.json.corrupted."));
      expect(quarantineFiles.length).toBeGreaterThan(0);
    });
  });

  describe("atomic writes", () => {
    it("uses temp file for atomic write", async () => {
      const tasks = [createTestTask()];

      // Spy on fs operations
      const writeSpy = vi.spyOn(fs, "writeFile");
      const renameSpy = vi.spyOn(fs, "rename");

      await persistence.save(testProjectId, tasks);

      // Should write to temp file then rename
      expect(writeSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();

      const writeCall = writeSpy.mock.calls[0];
      const renameCall = renameSpy.mock.calls[0];

      // Temp file should have .tmp extension
      expect(String(writeCall[0])).toContain(".tmp");
      // Rename should be from temp to final
      expect(String(renameCall[0])).toContain(".tmp");
      expect(String(renameCall[1])).toContain("tasks.json");
      expect(String(renameCall[1])).not.toContain(".tmp");

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  describe("flush", () => {
    it("flushes pending saves immediately", async () => {
      // Create persistence with longer debounce
      const slowPersistence = new TaskPersistence(5000);
      (slowPersistence as unknown as { projectsConfigDir: string }).projectsConfigDir = testDir;

      const tasks = [createTestTask()];

      // This starts a debounced save
      slowPersistence.save(testProjectId, tasks);

      // Flush should force immediate save
      await slowPersistence.flush(testProjectId);

      // Verify file was saved
      const loaded = await slowPersistence.load(testProjectId);
      expect(loaded).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("removes tasks file for project", async () => {
      const tasks = [createTestTask()];
      await persistence.save(testProjectId, tasks);

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

    it("cancels pending debounced saves so cleared state is not resurrected", async () => {
      const slowPersistence = new TaskPersistence(5000);
      (slowPersistence as unknown as { projectsConfigDir: string }).projectsConfigDir = testDir;

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
    it("returns null path for invalid project ID", async () => {
      const loaded = await persistence.load("invalid-project-id");
      expect(loaded).toEqual([]);
    });

    it("rejects project IDs that could cause path traversal", async () => {
      const loaded = await persistence.load("../../../etc/passwd");
      expect(loaded).toEqual([]);
    });

    it("rejects save for invalid project IDs immediately", async () => {
      await expect(persistence.save("invalid-project-id", [createTestTask()])).rejects.toThrow(
        "Invalid project ID"
      );
    });
  });

  describe("schema versioning", () => {
    it("includes version in saved data", async () => {
      const tasks = [createTestTask()];
      await persistence.save(testProjectId, tasks);

      const filePath = path.join(testDir, testProjectId, "tasks.json");
      const content = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(content);

      expect(data.version).toBe("1.0");
      expect(data.lastUpdated).toBeGreaterThan(0);
    });
  });
});
