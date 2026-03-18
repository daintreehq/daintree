import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../GitService.js", () => ({
  GitService: vi.fn().mockImplementation(function (this: Record<string, unknown>, p: string) {
    this.path = p;
  }),
}));

import { TaskWorktreeService } from "../TaskWorktreeService.js";

describe("TaskWorktreeService", () => {
  let service: TaskWorktreeService;

  beforeEach(() => {
    service = new TaskWorktreeService();
  });

  describe("task-worktree mapping", () => {
    it("adds and retrieves mappings", () => {
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");
      service.addTaskWorktreeMapping("proj1", "task1", "wt2");

      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual(
        expect.arrayContaining(["wt1", "wt2"])
      );
    });

    it("returns empty array for unknown task", () => {
      expect(service.getWorktreeIdsForTask("proj1", "unknown")).toEqual([]);
    });

    it("scopes mappings by project", () => {
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");
      service.addTaskWorktreeMapping("proj2", "task1", "wt2");

      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual(["wt1"]);
      expect(service.getWorktreeIdsForTask("proj2", "task1")).toEqual(["wt2"]);
    });

    it("removes a mapping and cleans up empty task entries", () => {
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");
      service.addTaskWorktreeMapping("proj1", "task1", "wt2");

      service.removeTaskWorktreeMapping("proj1", "task1", "wt1");
      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual(["wt2"]);

      service.removeTaskWorktreeMapping("proj1", "task1", "wt2");
      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual([]);
    });

    it("handles removing non-existent mapping gracefully", () => {
      service.removeTaskWorktreeMapping("proj1", "task1", "wt-nonexistent");
      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual([]);
    });
  });

  describe("gitServiceCache", () => {
    it("returns same instance for same path", () => {
      const s1 = service.getGitService("/path/a");
      const s2 = service.getGitService("/path/a");
      expect(s1).toBe(s2);
    });

    it("returns different instances for different paths", () => {
      const s1 = service.getGitService("/path/a");
      const s2 = service.getGitService("/path/b");
      expect(s1).not.toBe(s2);
    });
  });

  describe("idempotency", () => {
    it("duplicate add does not create duplicate worktree IDs", () => {
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");

      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual(["wt1"]);
    });
  });

  describe("onProjectSwitch", () => {
    it("clears git cache but preserves task mappings", () => {
      service.addTaskWorktreeMapping("proj1", "task1", "wt1");
      const cached = service.getGitService("/path/a");

      service.onProjectSwitch();

      expect(service.getWorktreeIdsForTask("proj1", "task1")).toEqual(["wt1"]);
      expect(service.getGitService("/path/a")).not.toBe(cached);
    });
  });
});
