import { describe, it, expect } from "vitest";
import { getMergedPresets, getMergedPreset } from "@/config/agents";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

// Adversarial unit tests targeting logic vulnerabilities in the preset system
describe("Adversarial Unit Tests: Logic Vulnerabilities", () => {
  describe("getMergedPresets - Input Validation", () => {
    it("blocks backtick injection in env values", () => {
      const presets = [{ id: "bt", name: "BT", env: { X: "`whoami`" } }];
      const result = getMergedPresets("claude", presets);
      expect(result[0]?.env?.X).toBeUndefined();
    });
  });

  describe("getMergedPreset - Single preset resolution", () => {
    it("returns undefined when presetId is undefined and no defaultPresetId (bare-agent default)", () => {
      const presets = [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ];
      // "Agent default" — no requested preset, no agent-declared default —
      // must resolve to no preset, not silently promote the first one.
      const result = getMergedPreset("claude", undefined, presets, []);
      expect(result).toBeUndefined();
    });

    it("returns the declared default preset when presetId is undefined and defaultPresetId is set", () => {
      const presets = [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ];
      // The other half of the undefined branch: an agent that declares a
      // default preset must still resolve to it (not the first, not nothing).
      const config = getEffectiveAgentConfig("claude");
      config!.defaultPresetId = "second";
      try {
        const result = getMergedPreset("claude", undefined, presets, []);
        expect(result?.id).toBe("second");
      } finally {
        delete config!.defaultPresetId;
      }
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
