import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AppStateTerminalEntrySchema,
  TerminalSnapshotSchema,
  TerminalSpawnOptionsSchema,
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
      const types = ["terminal", "claude", "gemini", "codex", "opencode", "cursor"];

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
        type: "terminal",
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
        kind: "terminal",
        type: "claude",
        agentId: "claude",
        title: "Claude Agent",
        cwd: "/Users/test/project",
        worktreeId: "wt-456",
        location: "dock",
        command: "claude --model sonnet-4",
        browserUrl: "http://localhost:3000",
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

    it("accepts browser panel snapshot without cwd", () => {
      const snapshot = {
        id: "browser-123",
        kind: "browser",
        title: "Browser",
        location: "grid",
        browserUrl: "https://example.com",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cwd).toBeUndefined();
        expect(result.data).toMatchObject(snapshot);
      }
    });

    it("rejects PTY panel snapshot without cwd (terminal)", () => {
      const snapshot = {
        id: "snap-123",
        kind: "terminal",
        title: "Terminal 1",
        location: "grid",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("PTY-backed panels require");
      }
    });

    it("rejects PTY panel snapshot without cwd (agent)", () => {
      const snapshot = {
        id: "agent-123",
        kind: "terminal",
        agentId: "claude",
        title: "Claude",
        location: "grid",
        type: "claude",
      };

      const result = TerminalSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("PTY-backed panels require");
      }
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
          type: "terminal",
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
        { id: "t2", title: "Bad location", cwd: "/", location: "invalid-loc" }, // invalid location
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
        { id: "bad1", title: "Bad location", cwd: "/", location: "invalid-loc" },
        { id: "bad2", cwd: "/", location: "grid" }, // missing required title
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
        { id: "s1", type: "terminal", title: "Snap 1", cwd: "/", location: "grid" },
        { id: "", title: "Invalid", cwd: "/", location: "grid" }, // empty id
        { id: "s2", kind: "browser", title: "Browser", location: "dock" },
      ];

      const result = filterValidTerminalEntries(snapshots, TerminalSnapshotSchema, "snapshot-test");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
      expect(result[1].id).toBe("s2");
    });
  });

  describe("TerminalSpawnOptionsSchema (#6065 — shell-injection hardening)", () => {
    const baseOptions = { cols: 80, rows: 24 };

    it("accepts spawn options without a command", () => {
      const result = TerminalSpawnOptionsSchema.safeParse(baseOptions);
      expect(result.success).toBe(true);
    });

    it("accepts shell metacharacters that are intentional in user-typed commands", () => {
      const validCommands = [
        "echo hi; echo bye",
        "ls | cat",
        "false && true",
        "false || true",
        "echo $(pwd)",
        "echo `pwd`",
        "FOO=bar node x.js",
        'echo "$HOME" > out.txt',
        "claude --model sonnet-4",
        "ssh 'feat-deploy'@host.example.com",
        "echo 日本語",
      ];

      for (const command of validCommands) {
        const result = TerminalSpawnOptionsSchema.safeParse({ ...baseOptions, command });
        expect(result.success, `expected to accept: ${JSON.stringify(command)}`).toBe(true);
      }
    });

    it("rejects ASCII control characters in command", () => {
      const rejected: Array<[string, string]> = [
        ["NUL", "\x00"],
        ["SOH", "\x01"],
        ["BEL", "\x07"],
        ["TAB", "\x09"],
        ["LF", "\x0A"],
        ["CR", "\x0D"],
        ["ESC", "\x1B"],
        ["DEL", "\x7F"],
      ];

      for (const [name, ch] of rejected) {
        const command = `echo${ch}injected`;
        const result = TerminalSpawnOptionsSchema.safeParse({ ...baseOptions, command });
        expect(
          result.success,
          `expected to reject ${name} (\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")})`
        ).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("control characters");
        }
      }
    });

    it("rejects ANSI escape sequences smuggled through command", () => {
      const result = TerminalSpawnOptionsSchema.safeParse({
        ...baseOptions,
        command: "echo \x1B[31mred\x1B[0m",
      });
      expect(result.success).toBe(false);
    });

    it("rejects multi-line command at the schema boundary", () => {
      const result = TerminalSpawnOptionsSchema.safeParse({
        ...baseOptions,
        command: "evil\nrm -rf ~",
      });
      expect(result.success).toBe(false);
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
