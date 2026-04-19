import { describe, it, expect } from "vitest";
import { getMergedPresets, getMergedPreset } from "@/config/agents";

// Adversarial unit tests targeting logic vulnerabilities in the preset system
describe("Adversarial Unit Tests: Logic Vulnerabilities", () => {
  describe("getMergedPresets - Input Validation", () => {
    it("handles null/undefined inputs without crashing", () => {
      expect(() =>
        getMergedPresets("claude", null as unknown as undefined, undefined)
      ).not.toThrow();
      expect(() => getMergedPresets("claude", [], null as unknown as undefined)).not.toThrow();
    });

    it("blocks shell injection in env values", () => {
      const presets = [{ id: "hack", name: "Evil", env: { CMD: "$(rm -rf /)" } }];
      const result = getMergedPresets("claude", presets);
      expect(result[0]?.env?.CMD).toBeUndefined();
    });

    it("blocks backtick injection in env values", () => {
      const presets = [{ id: "bt", name: "BT", env: { X: "`whoami`" } }];
      const result = getMergedPresets("claude", presets);
      expect(result[0]?.env?.X).toBeUndefined();
    });

    it("blocks semicolon injection in env values", () => {
      const presets = [{ id: "semi", name: "Semi", env: { X: "val; rm -rf /" } }];
      const result = getMergedPresets("claude", presets);
      expect(result[0]?.env?.X).toBeUndefined();
    });

    it("handles circular references in env objects without throwing", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      const presets = [{ id: "loop", name: "Loop", env: circular as Record<string, string> }];
      expect(() => getMergedPresets("claude", presets)).not.toThrow();
      const result = getMergedPresets("claude", presets);
      // Preset survives, circular value is dropped
      expect(result).toHaveLength(1);
      expect(result[0]!.env?.["self"]).toBeUndefined();
    });

    it("validates preset ID format — rejects unsafe chars", () => {
      const badIds = [
        { id: "../escape", name: "Path traversal" },
        { id: "id with spaces", name: "Spaces" },
        { id: "id\twith\ttabs", name: "Tabs" },
        { id: "", name: "Empty ID" },
      ];
      const result = getMergedPresets("claude", badIds);
      expect(result).toHaveLength(0);
    });

    it("deduplicates — first entry wins when IDs collide", () => {
      const dups = [
        { id: "dup", name: "First" },
        { id: "dup", name: "Second" },
      ];
      const result = getMergedPresets("claude", dups);
      expect(result.filter((f) => f.id === "dup")).toHaveLength(1);
      expect(result.find((f) => f.id === "dup")?.name).toBe("First");
    });

    it("handles extremely large env objects without crashing", () => {
      const hugeEnv: Record<string, string> = {};
      for (let i = 0; i < 10000; i++) {
        hugeEnv[`VAR_${i}`] = `value_${i}`;
      }
      const presets = [{ id: "huge", name: "Big", env: hugeEnv }];
      expect(() => getMergedPresets("claude", presets)).not.toThrow();
      const result = getMergedPresets("claude", presets);
      expect(result[0]!.env).toBeDefined();
    });

    it("blocks dangerous env var names (PATH, LD_PRELOAD, etc.)", () => {
      const dangerous = [
        { id: "danger", name: "Bad", env: { PATH: "/bin", LD_PRELOAD: "evil.so" } },
      ];
      const result = getMergedPresets("claude", dangerous);
      expect(result[0]!.env?.PATH).toBeUndefined();
      expect(result[0]!.env?.LD_PRELOAD).toBeUndefined();
    });

    it("rejects non-string env values silently", () => {
      const presets = [
        {
          id: "nonstr",
          name: "NonStr",
          env: { NUM: 42 as unknown as string, OBJ: {} as unknown as string },
        },
      ];
      expect(() => getMergedPresets("claude", presets)).not.toThrow();
      const result = getMergedPresets("claude", presets);
      expect(result[0]!.env?.NUM).toBeUndefined();
      expect(result[0]!.env?.OBJ).toBeUndefined();
    });
  });

  describe("getMergedPreset - Single preset resolution", () => {
    it("returns undefined when no presets exist", () => {
      const result = getMergedPreset("claude", undefined, [], []);
      expect(result).toBeUndefined();
    });

    it("returns first preset when presetId is undefined and no defaultPresetId", () => {
      const presets = [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ];
      const result = getMergedPreset("claude", undefined, presets, []);
      expect(result?.id).toBe("first");
    });

    it("returns undefined for unknown presetId", () => {
      const presets = [{ id: "real", name: "Real" }];
      const result = getMergedPreset("claude", "ghost", presets, []);
      expect(result).toBeUndefined();
    });

    it("resolves by explicit presetId", () => {
      const presets = [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ];
      const result = getMergedPreset("claude", "b", presets, []);
      expect(result?.id).toBe("b");
    });

    it("custom preset takes precedence over CCR preset with same ID", () => {
      const custom = [{ id: "shared", name: "Custom Version" }];
      const ccr = [{ id: "shared", name: "CCR Version" }];
      const result = getMergedPreset("claude", "shared", custom, ccr);
      expect(result?.name).toBe("Custom Version");
    });
  });

  describe("getMergedPresets - Project preset precedence", () => {
    it("custom preset shadows project preset with same ID", () => {
      const custom = [{ id: "shared", name: "User Custom" }];
      const project = [{ id: "shared", name: "Team Project" }];
      const result = getMergedPresets("claude", custom, [], project);
      const shared = result.filter((f) => f.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]!.name).toBe("User Custom");
    });

    it("project preset shadows CCR preset with same ID", () => {
      const ccr = [{ id: "shared", name: "CCR Version" }];
      const project = [{ id: "shared", name: "Team Project" }];
      const result = getMergedPresets("claude", [], ccr, project);
      const shared = result.filter((f) => f.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]!.name).toBe("Team Project");
    });

    it("project presets appear alongside custom and CCR with distinct IDs", () => {
      const custom = [{ id: "user-a", name: "User A" }];
      const ccr = [{ id: "ccr-a", name: "CCR A" }];
      const project = [{ id: "team-a", name: "Team A" }];
      const result = getMergedPresets("claude", custom, ccr, project);
      expect(result.map((f) => f.id)).toEqual(
        expect.arrayContaining(["user-a", "ccr-a", "team-a"])
      );
    });

    it("getMergedPreset resolves project preset when no custom override exists", () => {
      const project = [{ id: "team-a", name: "Team Opus" }];
      const result = getMergedPreset("claude", "team-a", [], [], project);
      expect(result?.name).toBe("Team Opus");
    });
  });
});
