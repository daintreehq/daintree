import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AppStateTerminalEntrySchema,
  TerminalSnapshotSchema,
  TerminalSpawnOptionsSchema,
  RecipeTerminalSchema,
  TerminalRecipeSchema,
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

    it("rejects overlay location (overlay terminals are never persisted to app state)", () => {
      const entry = {
        id: "term-123",
        type: "terminal",
        title: "Terminal",
        cwd: "/Users/test",
        location: "overlay",
      };

      const result = AppStateTerminalEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
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

    it("accepts all locations including trash and overlay", () => {
      const locations = ["grid", "dock", "overlay", "trash", "background"];

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

    // #12419 — the spawn source rides the snapshot so Terminal Info can still
    // name the origin after a restart.
    describe("spawnedBy", () => {
      const base = { id: "snap-123", title: "Terminal", cwd: "/Users/test", location: "grid" };

      it("accepts a legacy snapshot with no spawn source", () => {
        const result = TerminalSnapshotSchema.safeParse(base);
        expect(result.success).toBe(true);
        expect(result.success && result.data.spawnedBy).toBeUndefined();
        // Absent rather than materialized as an undefined-valued key, so a later
        // save does not start writing `"spawnedBy": null` into every legacy entry.
        expect(result.success && "spawnedBy" in result.data).toBe(false);
      });

      // The tag is cosmetic — a value this build does not recognize (e.g. one a
      // newer build added, then downgraded) must cost the tag, never the pane.
      it.each([
        ["cron"],
        [""],
        ["  quickrun  "],
        ["__proto__"],
        ["constructor"],
        [42],
        [null],
        [{ origin: "quickrun" }],
      ])("drops the unrecognized value %s but keeps the entry", (spawnedBy) => {
        const result = TerminalSnapshotSchema.safeParse({ ...base, spawnedBy });
        expect(result.success).toBe(true);
        expect(result.success && result.data.spawnedBy).toBeUndefined();
      });

      // #15977 — a scheduled run's ids ride beside the source; a malformed pair
      // costs the attribution, never the pane.
      it("keeps a scheduled run's ids, and drops ones that don't read without failing the entry", () => {
        const run = { scheduleId: "schedule-1", runId: "run-1" };
        const kept = TerminalSnapshotSchema.safeParse({
          ...base,
          spawnedBy: "schedule",
          scheduledRun: run,
        });
        expect(kept.success && kept.data).toMatchObject({
          spawnedBy: "schedule",
          scheduledRun: run,
        });

        const absent = TerminalSnapshotSchema.safeParse(base);
        expect(absent.success && "scheduledRun" in absent.data).toBe(false);

        for (const scheduledRun of [{ scheduleId: "schedule-1" }, "run-1", { runId: 7 }]) {
          const result = TerminalSnapshotSchema.safeParse({
            ...base,
            spawnedBy: "schedule",
            scheduledRun,
          });
          expect(result.success).toBe(true);
          expect(result.success && result.data.scheduledRun).toBeUndefined();
        }

        const global = AppStateTerminalEntrySchema.safeParse({
          ...base,
          spawnedBy: "schedule",
          scheduledRun: run,
        });
        expect(global.success && global.data.scheduledRun).toEqual(run);
        const brokenGlobal = AppStateTerminalEntrySchema.safeParse({
          ...base,
          spawnedBy: "schedule",
          scheduledRun: { scheduleId: "schedule-1" },
        });
        expect(brokenGlobal.success).toBe(true);
        expect(brokenGlobal.success && brokenGlobal.data.scheduledRun).toBeUndefined();
      });

      it("normalizes the spawn source on the legacy global entry schema too", () => {
        const globalBase = { id: "g1", title: "Terminal", cwd: "/Users/test", location: "grid" };
        const valid = AppStateTerminalEntrySchema.safeParse({
          ...globalBase,
          spawnedBy: "quickrun",
        });
        expect(valid.success).toBe(true);
        expect(valid.success && valid.data.spawnedBy).toBe("quickrun");

        // Legacy migration and the no-project fallback hand these entries back to
        // the renderer unchanged, so an unrecognized value must be dropped here as
        // well or the restore builders receive something outside the union.
        const bogus = AppStateTerminalEntrySchema.safeParse({
          ...globalBase,
          spawnedBy: "__proto__",
        });
        expect(bogus.success).toBe(true);
        expect(bogus.success && bogus.data.spawnedBy).toBeUndefined();
      });

      it("keeps a pane with an unrecognized spawn source through filterValidTerminalEntries", () => {
        const result = filterValidTerminalEntries(
          [
            { ...base, id: "s1", spawnedBy: "quickrun" },
            { ...base, id: "s2", spawnedBy: "cron" },
          ],
          TerminalSnapshotSchema,
          "spawn-source-test"
        );
        expect(result).toHaveLength(2);
        expect(result[0].spawnedBy).toBe("quickrun");
        expect(result[1].spawnedBy).toBeUndefined();
      });
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

describe("Recipe Validation Schemas", () => {
  describe("RecipeTerminalSchema", () => {
    it("accepts minimal valid terminal entry", () => {
      const entry = { type: "terminal" };
      const result = RecipeTerminalSchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("accepts terminal entry with all fields", () => {
      const entry = {
        type: "terminal",
        title: "My Terminal",
        command: "npm run dev",
        env: { NODE_ENV: "development" },
        initialPrompt: "Start coding",
        args: "--model sonnet",
        devCommand: "npm run dev",
        exitBehavior: "keep",
        agentModelId: "sonnet",
        agentLaunchFlags: ["--verbose"],
      };
      const result = RecipeTerminalSchema.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.env).toEqual({ NODE_ENV: "development" });
        expect(result.data.agentLaunchFlags).toEqual(["--verbose"]);
      }
    });

    it("rejects entry with empty type", () => {
      const entry = { type: "" };
      const result = RecipeTerminalSchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects entry with missing type", () => {
      const entry = { title: "No type" };
      const result = RecipeTerminalSchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("rejects invalid exitBehavior values", () => {
      const result = RecipeTerminalSchema.safeParse({
        type: "terminal",
        exitBehavior: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("accepts all valid exitBehavior values", () => {
      const behaviors = ["keep", "trash", "remove", "restart"];
      for (const behavior of behaviors) {
        const result = RecipeTerminalSchema.safeParse({
          type: "terminal",
          exitBehavior: behavior,
        });
        expect(result.success).toBe(true);
      }
    });

    it("rejects env with non-string values", () => {
      const result = RecipeTerminalSchema.safeParse({
        type: "terminal",
        env: { KEY: 123 },
      });
      expect(result.success).toBe(false);
    });

    it("preserves unknown fields via passthrough", () => {
      const entry = { type: "terminal", unknownField: "preserved", anotherExtra: 456 };
      const result = RecipeTerminalSchema.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("unknownField", "preserved");
        expect(result.data).toHaveProperty("anotherExtra", 456);
      }
    });
  });

  describe("TerminalRecipeSchema", () => {
    it("accepts valid minimal recipe", () => {
      const recipe = {
        id: "recipe-1",
        name: "My Recipe",
        terminals: [{ type: "terminal" }],
        createdAt: 1700000000000,
      };
      const result = TerminalRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(true);
    });

    it("accepts recipe with all fields", () => {
      const recipe = {
        id: "full-recipe",
        name: "Full Recipe",
        projectId: "proj-123",
        worktreeId: "wt-456",
        terminals: [
          { type: "terminal", command: "npm start" },
          { type: "claude", initialPrompt: "Review this code" },
        ],
        createdAt: 1700000000000,
        showInEmptyState: true,
        lastUsedAt: 1700100000000,
        usageHistory: [1700000000000, 1700100000000],
        autoAssign: "prompt",
      };
      const result = TerminalRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(true);
    });

    it("rejects recipe with empty id", () => {
      const recipe = {
        id: "",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
      };
      const result = TerminalRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(false);
    });

    it("rejects recipe with empty name", () => {
      const recipe = {
        id: "r1",
        name: "",
        terminals: [],
        createdAt: 0,
      };
      const result = TerminalRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(false);
    });

    it("rejects recipe with missing terminals", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        createdAt: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects recipe with invalid terminal in array", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [{ type: "ok" }, { type: "" }], // second terminal has empty type
        createdAt: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid autoAssign values", () => {
      expect(
        TerminalRecipeSchema.safeParse({
          id: "r1",
          name: "Recipe",
          terminals: [],
          createdAt: 0,
          autoAssign: "maybe",
        }).success
      ).toBe(false);
    });

    it("accepts all valid autoAssign values", () => {
      for (const mode of ["always", "never", "prompt"]) {
        const result = TerminalRecipeSchema.safeParse({
          id: "r1",
          name: "Recipe",
          terminals: [],
          createdAt: 0,
          autoAssign: mode,
        });
        expect(result.success).toBe(true);
      }
    });

    it("preserves unknown fields via passthrough", () => {
      const recipe = {
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
        unknownField: "kept",
      };
      const result = TerminalRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("unknownField", "kept");
      }
    });

    it("rejects recipe with NaN createdAt", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: Number.NaN,
      });
      expect(result.success).toBe(false);
    });

    it("rejects recipe with Infinity createdAt", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: Number.POSITIVE_INFINITY,
      });
      expect(result.success).toBe(false);
    });

    it("rejects recipe with NaN lastUsedAt", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
        lastUsedAt: Number.NaN,
      });
      expect(result.success).toBe(false);
    });

    it("rejects recipe with non-finite usageHistory entry", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
        usageHistory: [1700000000000, Number.POSITIVE_INFINITY],
      });
      expect(result.success).toBe(false);
    });

    it("accepts usageHistory at the 20-entry cap", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
        usageHistory: Array.from({ length: 20 }, (_v, i) => i + 1),
      });
      expect(result.success).toBe(true);
    });

    it("rejects usageHistory exceeding the 20-entry cap", () => {
      const result = TerminalRecipeSchema.safeParse({
        id: "r1",
        name: "Recipe",
        terminals: [],
        createdAt: 0,
        usageHistory: Array.from({ length: 21 }, (_v, i) => i + 1),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("filterValidTerminalEntries with TerminalRecipeSchema", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("filters out recipes with deep field type errors", () => {
      const recipes = [
        { id: "r1", name: "Valid", terminals: [], createdAt: 1 },
        {
          id: "r2",
          name: "command is number",
          terminals: [{ type: "terminal", command: 123 }],
          createdAt: 2,
        }, // command should be string
        {
          id: "r3",
          name: "env is array",
          terminals: [{ type: "terminal", env: ["not", "a", "record"] }],
          createdAt: 3,
        },
      ];

      const result = filterValidTerminalEntries(recipes, TerminalRecipeSchema, "test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("r1");
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe("portable project plugin kinds (#12280)", () => {
  // A project-local plugin's kind persists in the portable form, which is
  // byte-identical to a global plugin's runtime form. If a global plugin of the
  // same manifest and kind id is installed AND declares hasPty, a registry
  // lookup here answers from the wrong plugin and demands a `cwd` the project
  // panel never had — and a rejected entry is a DELETED panel.
  const projectPanel = {
    id: "plug-1",
    title: "Overview",
    kind: "acme.dashboard.overview",
    kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
    pluginId: "acme.dashboard",
    location: "grid",
  };

  it("accepts a project plugin panel with no cwd", () => {
    expect(TerminalSnapshotSchema.safeParse(projectPanel).success).toBe(true);
    expect(AppStateTerminalEntrySchema.safeParse(projectPanel).success).toBe(true);
  });

  it("preserves kindRef and extensionStateVersion through validation", () => {
    const parsed = TerminalSnapshotSchema.safeParse({
      ...projectPanel,
      extensionState: { activeTab: "a" },
      extensionStateVersion: 2,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as Record<string, unknown>;
    expect(data.kindRef).toEqual(projectPanel.kindRef);
    expect(data.extensionStateVersion).toBe(2);
  });

  it("keeps a malformed kindRef from deleting the panel", () => {
    // The field is deliberately undeclared so a corrupt value degrades at read
    // time instead of failing validation and taking the record with it.
    expect(
      TerminalSnapshotSchema.safeParse({ ...projectPanel, kindRef: { origin: "project" } }).success
    ).toBe(true);
  });
});
