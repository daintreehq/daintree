import { describe, it, expect } from "vitest";
import { ensureSerializable, validateSerializable } from "../serialization.js";
import type { WorktreeChanges, FileChangeDetail } from "../../types/git.js";

describe("ensureSerializable", () => {
  it("preserves plain objects", () => {
    const data = {
      id: "123",
      path: "/foo/bar",
      name: "test",
      count: 42,
      active: true,
    };
    const result = ensureSerializable(data) as any;
    expect(result).toEqual(data);
  });

  it("preserves nested plain objects", () => {
    const data = {
      outer: {
        inner: {
          value: "nested",
          num: 123,
        },
      },
    };
    const result = ensureSerializable(data) as any;
    expect(result).toEqual(data);
  });

  it("preserves arrays of primitives", () => {
    const data = {
      strings: ["a", "b", "c"],
      numbers: [1, 2, 3],
      booleans: [true, false],
    };
    const result = ensureSerializable(data) as any;
    expect(result).toEqual(data);
  });

  it("preserves arrays of objects", () => {
    const data = {
      items: [
        { id: "1", name: "first" },
        { id: "2", name: "second" },
      ],
    };
    const result = ensureSerializable(data) as any;
    expect(result).toEqual(data);
  });

  it("removes function properties", () => {
    const data = {
      name: "test",
      fn: () => "hello",
    } as any;
    const result = ensureSerializable(data) as any;
    expect(result).toEqual({ name: "test" });
    expect(result.fn).toBeUndefined();
  });

  it("converts undefined to null", () => {
    const data = {
      defined: "value",
      notDefined: undefined,
    };
    const result = ensureSerializable(data) as any;
    expect(result.defined).toBe("value");
    expect(result.notDefined).toBeUndefined();
  });

  it("handles null values", () => {
    const data = {
      value: null,
      other: "string",
    };
    const result = ensureSerializable(data) as any;
    expect(result).toEqual(data);
  });

  it("handles Date objects by converting to ISO string", () => {
    const date = new Date("2025-01-01T00:00:00Z");
    const data = {
      timestamp: date,
      other: "value",
    };
    const result = ensureSerializable(data) as any;
    expect(result.timestamp).toBe(date.toISOString());
    expect(result.other).toBe("value");
  });

  it("removes class instances by converting to plain objects", () => {
    class TestClass {
      public value: string;
      constructor(value: string) {
        this.value = value;
      }
      method() {
        return this.value;
      }
    }

    const instance = new TestClass("test");
    const data = {
      obj: instance,
      other: "value",
    };

    const result = ensureSerializable(data) as any;
    expect(result.obj).toEqual({ value: "test" });
    expect((result.obj as any).method).toBeUndefined();
    expect(result.other).toBe("value");
  });
});

describe("validateSerializable", () => {
  it("validates plain objects successfully", () => {
    const data = {
      id: "123",
      name: "test",
      count: 42,
    };
    const result = validateSerializable(data);
    expect(result.valid).toBe(true);
  });

  it("validates nested objects successfully", () => {
    const data = {
      outer: {
        inner: {
          deep: {
            value: "nested",
          },
        },
      },
    };
    const result = validateSerializable(data);
    expect(result.valid).toBe(true);
  });

  it("validates arrays successfully", () => {
    const data = {
      items: [1, 2, 3],
      strings: ["a", "b"],
      objects: [{ id: 1 }, { id: 2 }],
    };
    const result = validateSerializable(data);
    expect(result.valid).toBe(true);
  });

  it("validates null values", () => {
    const data = {
      value: null,
      other: "string",
    };
    const result = validateSerializable(data);
    expect(result.valid).toBe(true);
  });

  it("detects circular references", () => {
    const data: any = {
      name: "test",
    };
    data.self = data;

    const result = validateSerializable(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("circular");
    }
  });
});

describe("WorktreeSnapshot serialization", () => {
  it("serializes realistic WorktreeChanges data", () => {
    const changes: FileChangeDetail[] = [
      {
        path: "src/index.ts",
        status: "modified",
        insertions: 10,
        deletions: 5,
        mtimeMs: Date.now(),
      },
      {
        path: "README.md",
        status: "modified",
        insertions: 2,
        deletions: 1,
        mtimeMs: Date.now(),
      },
    ];

    const worktreeChanges: WorktreeChanges = {
      worktreeId: "/path/to/worktree",
      rootPath: "/path/to/worktree",
      changes: changes,
      changedFileCount: 2,
      totalInsertions: 12,
      totalDeletions: 6,
      latestFileMtime: Date.now(),
      lastUpdated: Date.now(),
      lastCommitMessage: "feat: add new feature",
      lastCommitTimestampMs: Date.now(),
    };

    const snapshot = {
      id: "/path/to/worktree",
      path: "/path/to/worktree",
      name: "feature-branch",
      branch: "feature/test",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: "/path/to/worktree/.git",
      summary: "Working on feature",
      modifiedCount: 2,
      changes: changes,
      mood: "active" as const,
      lastActivityTimestamp: Date.now(),
      issueNumber: 123,
      worktreeChanges: worktreeChanges,
      worktreeId: "/path/to/worktree",
      timestamp: Date.now(),
    };

    const validation = validateSerializable(snapshot);
    expect(validation.valid).toBe(true);

    const serialized = ensureSerializable(snapshot) as any;
    expect(serialized).toBeDefined();
    expect(serialized.worktreeChanges).toBeDefined();
    expect(serialized.worktreeChanges?.changes).toHaveLength(2);
    expect(serialized.changes).toHaveLength(2);
  });

  it("handles empty changes arrays", () => {
    const snapshot = {
      id: "/path/to/worktree",
      path: "/path/to/worktree",
      name: "clean-branch",
      isCurrent: false,
      worktreeId: "/path/to/worktree",
      changes: [],
      worktreeChanges: {
        worktreeId: "/path/to/worktree",
        rootPath: "/path/to/worktree",
        changes: [],
        changedFileCount: 0,
      },
    };

    const validation = validateSerializable(snapshot);
    expect(validation.valid).toBe(true);

    const serialized = ensureSerializable(snapshot) as any;
    expect(serialized.changes).toEqual([]);
    expect(serialized.worktreeChanges?.changes).toEqual([]);
  });

  it("handles null worktreeChanges", () => {
    const snapshot = {
      id: "/path/to/worktree",
      path: "/path/to/worktree",
      name: "new-worktree",
      isCurrent: false,
      worktreeId: "/path/to/worktree",
      worktreeChanges: null,
    };

    const validation = validateSerializable(snapshot);
    expect(validation.valid).toBe(true);

    const serialized = ensureSerializable(snapshot) as any;
    expect(serialized.worktreeChanges).toBeNull();
  });

  it("handles large changesets efficiently", () => {
    const changes: FileChangeDetail[] = Array.from({ length: 100 }, (_, i) => ({
      path: `src/file${i}.ts`,
      status: "modified" as const,
      insertions: i * 2,
      deletions: i,
      mtimeMs: Date.now(),
    }));

    const snapshot = {
      id: "/path/to/worktree",
      path: "/path/to/worktree",
      name: "large-changeset",
      isCurrent: false,
      worktreeId: "/path/to/worktree",
      changes: changes,
      worktreeChanges: {
        worktreeId: "/path/to/worktree",
        rootPath: "/path/to/worktree",
        changes: changes,
        changedFileCount: 100,
      },
    };

    const validation = validateSerializable(snapshot);
    expect(validation.valid).toBe(true);

    const serialized = ensureSerializable(snapshot) as any;
    expect(serialized.changes).toHaveLength(100);
    expect(serialized.worktreeChanges?.changes).toHaveLength(100);
  });
});
