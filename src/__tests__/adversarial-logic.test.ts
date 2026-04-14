import { describe, it, expect } from "vitest";
import { getMergedFlavors, getMergedFlavor } from "@/config/agents";

// Adversarial unit tests targeting logic vulnerabilities in the flavor system
describe("Adversarial Unit Tests: Logic Vulnerabilities", () => {
  describe("getMergedFlavors - Input Validation", () => {
    it("handles null/undefined inputs without crashing", () => {
      expect(() =>
        getMergedFlavors("claude", null as unknown as undefined, undefined)
      ).not.toThrow();
      expect(() => getMergedFlavors("claude", [], null as unknown as undefined)).not.toThrow();
    });

    it("blocks shell injection in env values", () => {
      const flavors = [{ id: "hack", name: "Evil", env: { CMD: "$(rm -rf /)" } }];
      const result = getMergedFlavors("claude", flavors);
      expect(result[0]?.env?.CMD).toBeUndefined();
    });

    it("blocks backtick injection in env values", () => {
      const flavors = [{ id: "bt", name: "BT", env: { X: "`whoami`" } }];
      const result = getMergedFlavors("claude", flavors);
      expect(result[0]?.env?.X).toBeUndefined();
    });

    it("blocks semicolon injection in env values", () => {
      const flavors = [{ id: "semi", name: "Semi", env: { X: "val; rm -rf /" } }];
      const result = getMergedFlavors("claude", flavors);
      expect(result[0]?.env?.X).toBeUndefined();
    });

    it("handles circular references in env objects without throwing", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      const flavors = [{ id: "loop", name: "Loop", env: circular as Record<string, string> }];
      expect(() => getMergedFlavors("claude", flavors)).not.toThrow();
      const result = getMergedFlavors("claude", flavors);
      // Flavor survives, circular value is dropped
      expect(result).toHaveLength(1);
      expect(result[0].env?.["self"]).toBeUndefined();
    });

    it("validates flavor ID format — rejects unsafe chars", () => {
      const badIds = [
        { id: "../escape", name: "Path traversal" },
        { id: "id with spaces", name: "Spaces" },
        { id: "id\twith\ttabs", name: "Tabs" },
        { id: "", name: "Empty ID" },
      ];
      const result = getMergedFlavors("claude", badIds);
      expect(result).toHaveLength(0);
    });

    it("deduplicates — first entry wins when IDs collide", () => {
      const dups = [
        { id: "dup", name: "First" },
        { id: "dup", name: "Second" },
      ];
      const result = getMergedFlavors("claude", dups);
      expect(result.filter((f) => f.id === "dup")).toHaveLength(1);
      expect(result.find((f) => f.id === "dup")?.name).toBe("First");
    });

    it("handles extremely large env objects without crashing", () => {
      const hugeEnv: Record<string, string> = {};
      for (let i = 0; i < 10000; i++) {
        hugeEnv[`VAR_${i}`] = `value_${i}`;
      }
      const flavors = [{ id: "huge", name: "Big", env: hugeEnv }];
      expect(() => getMergedFlavors("claude", flavors)).not.toThrow();
      const result = getMergedFlavors("claude", flavors);
      expect(result[0].env).toBeDefined();
    });

    it("blocks dangerous env var names (PATH, LD_PRELOAD, etc.)", () => {
      const dangerous = [
        { id: "danger", name: "Bad", env: { PATH: "/bin", LD_PRELOAD: "evil.so" } },
      ];
      const result = getMergedFlavors("claude", dangerous);
      expect(result[0].env?.PATH).toBeUndefined();
      expect(result[0].env?.LD_PRELOAD).toBeUndefined();
    });

    it("rejects non-string env values silently", () => {
      const flavors = [
        {
          id: "nonstr",
          name: "NonStr",
          env: { NUM: 42 as unknown as string, OBJ: {} as unknown as string },
        },
      ];
      expect(() => getMergedFlavors("claude", flavors)).not.toThrow();
      const result = getMergedFlavors("claude", flavors);
      expect(result[0].env?.NUM).toBeUndefined();
      expect(result[0].env?.OBJ).toBeUndefined();
    });
  });

  describe("getMergedFlavor - Single flavor resolution", () => {
    it("returns undefined when no flavors exist", () => {
      const result = getMergedFlavor("claude", undefined, [], []);
      expect(result).toBeUndefined();
    });

    it("returns first flavor when flavorId is undefined and no defaultFlavorId", () => {
      const flavors = [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ];
      const result = getMergedFlavor("claude", undefined, flavors, []);
      expect(result?.id).toBe("first");
    });

    it("returns undefined for unknown flavorId", () => {
      const flavors = [{ id: "real", name: "Real" }];
      const result = getMergedFlavor("claude", "ghost", flavors, []);
      expect(result).toBeUndefined();
    });

    it("resolves by explicit flavorId", () => {
      const flavors = [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ];
      const result = getMergedFlavor("claude", "b", flavors, []);
      expect(result?.id).toBe("b");
    });

    it("custom flavor takes precedence over CCR flavor with same ID", () => {
      const custom = [{ id: "shared", name: "Custom Version" }];
      const ccr = [{ id: "shared", name: "CCR Version" }];
      const result = getMergedFlavor("claude", "shared", custom, ccr);
      expect(result?.name).toBe("Custom Version");
    });
  });
});
