import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AppStateTerminalEntrySchema,
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
} from "../ipc.js";

describe("Terminal Entry Validation Schemas", () => {
  describe("AppStateTerminalEntrySchema", () => {
    it("accepts valid terminal entry", () => {
      const entry = {
        id: "term-123",
        type: "terminal",
        title: "Terminal 1",
        cwd: "/Users/test/project",
        location: "grid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(entry);
      }
    });

    it("accepts valid agent terminal entry", () => {
      const entry = {
        id: "claude-456",
        type: "claude",
        title: "Claude Agent",
        cwd: "/Users/test/project",
        worktreeId: "wt-123",
        location: "dock",
        command: "claude --model sonnet-4",
        isInputLocked: true,
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("accepts all valid terminal types", () => {
      const types = ["terminal", "claude", "gemini", "codex", "opencode"];

      for (const type of types) {
        const entry = {
          id: `${type}-id`,
          type,
          title: `${type} Terminal`,
          cwd: "/Users/test",
          location: "grid",
        };

        const result = AppStateTerminalEntrySchema.safeParse(entry);
        expect(result.success).toBe(true);
      }
    });

    it("accepts all valid locations (grid and dock only)", () => {
      const locations = ["grid", "dock"];

      for (const location of locations) {
        const entry = {
          id: "term-id",
          type: "terminal",
          title: "Test",
          cwd: "/Users/test",
          location,
        };

        const result = AppStateTerminalEntrySchema.safeParse(entry);
        expect(result.success).toBe(true);
      }
    });

    it("rejects trash location (not persisted at app level)", () => {
      const entry = {
        id: "term-id",
        type: "terminal",
        title: "Test",
        cwd: "/Users/test",
        location: "trash",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("accepts optional settings field", () => {
      const entry = {
        id: "term-123",
        type: "terminal",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
        settings: {
          autoRestart: true,
        },
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("rejects entry with missing id", () => {
      const entry = {
        type: "terminal",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects entry with empty id", () => {
      const entry = {
        id: "",
        type: "terminal",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects entry with missing type", () => {
      const entry = {
        id: "term-123",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects entry with invalid type", () => {
      const entry = {
        id: "term-123",
        type: "invalid-type",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects entry with invalid location", () => {
      const entry = {
        id: "term-123",
        type: "terminal",
        title: "Terminal",
        cwd: "/Users/test",
        location: "invalid",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects non-object values", () => {
      expect(AppStateTerminalEntrySchema.safeParse(null).success).toBe(false);
      expect(AppStateTerminalEntrySchema.safeParse(undefined).success).toBe(false);
      expect(AppStateTerminalEntrySchema.safeParse("string").success).toBe(false);
      expect(AppStateTerminalEntrySchema.safeParse(123).success).toBe(false);
      expect(AppStateTerminalEntrySchema.safeParse([]).success).toBe(false);
    });
  });

  describe("TerminalSnapshotSchema", () => {
    it("accepts valid snapshot with minimal fields", () => {
      const snapshot = {
        id: "snap-123",
        title: "Terminal 1",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("accepts valid snapshot with all fields", () => {
      const snapshot = {
        id: "snap-123",
        kind: "agent",
        type: "claude",
        agentId: "claude",
        title: "Claude Agent",
        cwd: "/Users/test/project",
        worktreeId: "wt-456",
        location: "dock",
        command: "claude --model sonnet-4",
        browserUrl: "http://localhost:3000",
        notePath: "/notes/test.md",
        noteId: "note-789",
        scope: "worktree",
        createdAt: Date.now(),
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("accepts browser panel snapshot", () => {
      const snapshot = {
        id: "browser-123",
        kind: "browser",
        title: "Browser",
        cwd: "/Users/test",
        location: "grid",
        browserUrl: "https://example.com",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("accepts notes panel snapshot", () => {
      const snapshot = {
        id: "notes-123",
        kind: "notes",
        title: "Notes",
        cwd: "/Users/test",
        location: "grid",
        notePath: "/notes/test.md",
        noteId: "note-123",
        scope: "project",
        createdAt: 1704067200000,
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("accepts extension panel kinds (string)", () => {
      const snapshot = {
        id: "ext-123",
        kind: "custom-extension-panel",
        title: "Custom Panel",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("accepts all locations including trash", () => {
      const locations = ["grid", "dock", "trash"];

      for (const location of locations) {
        const snapshot = {
          id: "snap-123",
          title: "Test",
          cwd: "/Users/test",
          location,
        };

        const result = TerminalSnapshotSchema.safeParse(snapshot);
        expect(result.success).toBe(true);
      }
    });

    it("rejects snapshot with empty id", () => {
      const snapshot = {
        id: "",
        title: "Terminal",
        cwd: "/Users/test",
        location: "grid",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
    });

    it("rejects snapshot with invalid scope", () => {
      const snapshot = {
        id: "notes-123",
        kind: "notes",
        title: "Notes",
        cwd: "/Users/test",
        location: "grid",
        scope: "invalid",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
    });
  });

  describe("filterValidTerminalEntries", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("returns all valid entries unchanged", () => {
      const entries = [
        { id: "t1", type: "terminal", title: "T1", cwd: "/", location: "grid" },
        { id: "t2", type: "claude", title: "T2", cwd: "/", location: "dock" },
      ];

      const result = filterValidTerminalEntries(entries, AppStateTerminalEntrySchema, "test");
      expect(result).toHaveLength(2);
      expect(result).toEqual(entries);
    });

    it("filters out invalid entries", () => {
      const entries = [
        { id: "t1", type: "terminal", title: "T1", cwd: "/", location: "grid" },
        { id: "", type: "terminal", title: "Invalid", cwd: "/", location: "grid" }, // empty id
        { type: "terminal", title: "Missing ID", cwd: "/", location: "grid" }, // no id
        { id: "t2", type: "invalid", title: "Bad type", cwd: "/", location: "grid" }, // invalid type
        { id: "t3", type: "claude", title: "T3", cwd: "/", location: "dock" },
      ];

      const result = filterValidTerminalEntries(entries, AppStateTerminalEntrySchema, "test");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("t1");
      expect(result[1].id).toBe("t3");
    });

    it("logs warning for each filtered entry", () => {
      const entries = [
        { id: "valid", type: "terminal", title: "V", cwd: "/", location: "grid" },
        { id: "bad1", type: "invalid", title: "Bad", cwd: "/", location: "grid" },
        { id: "bad2", title: "Missing type", cwd: "/", location: "grid" },
      ];

      filterValidTerminalEntries(entries, AppStateTerminalEntrySchema, "test-context");

      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(
        "[test-context] Filtering invalid terminal entry bad1:",
        expect.any(Object)
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "[test-context] Filtering invalid terminal entry bad2:",
        expect.any(Object)
      );
    });

    it("uses index for entries without id", () => {
      const entries = [
        { type: "terminal", title: "No ID", cwd: "/", location: "grid" }, // index 0
        { id: "valid", type: "terminal", title: "V", cwd: "/", location: "grid" },
      ];

      filterValidTerminalEntries(entries, AppStateTerminalEntrySchema, "test");

      expect(consoleSpy).toHaveBeenCalledWith(
        "[test] Filtering invalid terminal entry index-0:",
        expect.any(Object)
      );
    });

    it("handles empty array", () => {
      const result = filterValidTerminalEntries([], AppStateTerminalEntrySchema, "test");
      expect(result).toEqual([]);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("handles null/undefined entries in array", () => {
      const entries = [
        { id: "t1", type: "terminal", title: "T1", cwd: "/", location: "grid" },
        null,
        undefined,
        { id: "t2", type: "terminal", title: "T2", cwd: "/", location: "grid" },
      ];

      const result = filterValidTerminalEntries(
        entries as any[],
        AppStateTerminalEntrySchema,
        "test"
      );
      expect(result).toHaveLength(2);
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it("preserves extra fields via passthrough (forward compatibility)", () => {
      const entries = [
        {
          id: "t1",
          type: "terminal",
          title: "T1",
          cwd: "/",
          location: "grid",
          unknownField: "should be preserved",
          anotherExtra: 123,
        },
      ];

      const result = filterValidTerminalEntries(entries, AppStateTerminalEntrySchema, "test");
      expect(result).toHaveLength(1);
      // Passthrough mode preserves unknown fields for forward compatibility
      expect(result[0]).toHaveProperty("unknownField", "should be preserved");
      expect(result[0]).toHaveProperty("anotherExtra", 123);
    });

    it("works with TerminalSnapshotSchema", () => {
      const snapshots = [
        { id: "s1", title: "Snap 1", cwd: "/", location: "grid" },
        { id: "", title: "Invalid", cwd: "/", location: "grid" }, // empty id
        { id: "s2", kind: "browser", title: "Browser", cwd: "/", location: "dock" },
      ];

      const result = filterValidTerminalEntries(snapshots, TerminalSnapshotSchema, "snapshot-test");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
      expect(result[1].id).toBe("s2");
    });
  });

  describe("Recovery from corrupted state", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("recovers valid entries from heavily corrupted array", () => {
      const corruptedEntries = [
        "not an object",
        123,
        null,
        undefined,
        { malformed: true },
        { id: "valid1", type: "terminal", title: "OK", cwd: "/", location: "grid" },
        [],
        { id: "partial", type: "terminal" }, // missing required fields
        { id: "valid2", type: "gemini", title: "Gemini", cwd: "/home", location: "dock" },
        { id: "", type: "terminal", title: "Empty ID", cwd: "/", location: "grid" },
      ];

      const result = filterValidTerminalEntries(
        corruptedEntries as any[],
        AppStateTerminalEntrySchema,
        "corruption-test"
      );

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("valid1");
      expect(result[1].id).toBe("valid2");
    });

    it("preserves ordering of valid entries", () => {
      const entries = [
        { id: "first", type: "terminal", title: "First", cwd: "/", location: "grid" },
        { id: "", type: "invalid", title: "Bad", cwd: "/", location: "grid" },
        { id: "second", type: "terminal", title: "Second", cwd: "/", location: "grid" },
        { invalid: "entry" },
        { id: "third", type: "terminal", title: "Third", cwd: "/", location: "grid" },
      ];

      const result = filterValidTerminalEntries(
        entries as any[],
        AppStateTerminalEntrySchema,
        "test"
      );

      expect(result.map((e) => e.id)).toEqual(["first", "second", "third"]);
    });

    it("handles complete corruption gracefully", () => {
      const totallyCorrupted = [null, undefined, {}, [], "string", 42, true];

      const result = filterValidTerminalEntries(
        totallyCorrupted as any[],
        AppStateTerminalEntrySchema,
        "total-corruption"
      );

      expect(result).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledTimes(7);
    });
  });
});
