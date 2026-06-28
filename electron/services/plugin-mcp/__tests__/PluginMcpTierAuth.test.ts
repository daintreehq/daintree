import { describe, expect, it } from "vitest";
import { deriveDangerTier } from "../PluginMcpTierAuth.js";
import { CONFIRM_TRIGGERING_CAPABILITIES } from "../../../../shared/config/pluginCapabilities.js";

describe("PluginMcpTierAuth.deriveDangerTier", () => {
  describe("annotation floor", () => {
    it("returns D0 for readOnlyHint:true with a high-risk-capable manifest", () => {
      const result = deriveDangerTier({ readOnlyHint: true }, ["fs:project-write"]);
      expect(result).toEqual({ kind: "tier", tier: "D0" });
    });

    it("returns D1 when no hints are set", () => {
      const result = deriveDangerTier({}, ["fs:project-write"]);
      expect(result).toEqual({ kind: "tier", tier: "D1" });
    });

    it("returns D1 when annotations are undefined", () => {
      const result = deriveDangerTier(undefined, ["fs:project-write"]);
      expect(result).toEqual({ kind: "tier", tier: "D1" });
    });

    it("returns D2 for destructiveHint:true with a write-capable manifest", () => {
      const result = deriveDangerTier({ destructiveHint: true }, ["git:write"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });
  });

  describe("openWorldHint escalation", () => {
    it("raises D0 to D1 when openWorldHint:true", () => {
      const result = deriveDangerTier({ readOnlyHint: true, openWorldHint: true }, [
        "fs:project-write",
      ]);
      expect(result).toEqual({ kind: "tier", tier: "D1" });
    });

    it("raises D1 to D2 when openWorldHint:true", () => {
      const result = deriveDangerTier({ openWorldHint: true }, ["shell:exec"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });
  });

  describe("capability cap", () => {
    it("caps a read-only-capable plugin at D1 — denies a D2 floor", () => {
      const result = deriveDangerTier({ destructiveHint: true }, ["fs:project-read"]);
      expect(result).toEqual({
        kind: "deny",
        reason: "capability-cap-exceeded",
        observedFloor: "D2",
        cap: "D1",
      });
    });

    it("caps a network-only plugin at D1 — denies destructiveHint", () => {
      const result = deriveDangerTier({ destructiveHint: true }, ["network:fetch"]);
      expect(result.kind).toBe("deny");
    });

    it("does not silently downgrade — never returns a tier lower than the floor", () => {
      // A plugin declaring read-only capabilities but advertising a destructive
      // tool must be DENIED, not silently approved as D0/D1.
      const result = deriveDangerTier({ destructiveHint: true, openWorldHint: true }, [
        "fs:project-read",
      ]);
      expect(result.kind).toBe("deny");
    });

    it("allows D2 when the plugin declares shell:exec", () => {
      const result = deriveDangerTier({ destructiveHint: true }, ["shell:exec"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });

    it("allows D2 when the plugin declares fs:user-data-write", () => {
      const result = deriveDangerTier({ destructiveHint: true }, ["fs:user-data-write"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });

    it("allows D2 when the plugin declares agent:invoke", () => {
      // agent:invoke is high-risk (mirrors CONFIRM_TRIGGERING_CAPABILITIES in
      // PluginService) so a destructiveHint tool reaches D2 rather than denying.
      const result = deriveDangerTier({ destructiveHint: true }, ["agent:invoke"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });

    it("allows D2 when the plugin declares agent:register", () => {
      // agent:register registers a launchable agent CLI — a runtime side effect
      // on par with agent:invoke. It is in CONFIRM_TRIGGERING_CAPABILITIES, so a
      // destructiveHint tool reaches D2. (Regression guard: the cap previously
      // diverged from the action-danger set and omitted agent:register.)
      const result = deriveDangerTier({ destructiveHint: true }, ["agent:register"]);
      expect(result).toEqual({ kind: "tier", tier: "D2" });
    });

    // Every member of the shared CONFIRM_TRIGGERING_CAPABILITIES set must reach
    // D2 — guards against membership drift between the MCP tier cap and the
    // action-danger model now that both read the same constant.
    it.each([...CONFIRM_TRIGGERING_CAPABILITIES])(
      "allows D2 for high-risk capability %s",
      (capability) => {
        const result = deriveDangerTier({ destructiveHint: true }, [capability]);
        expect(result).toEqual({ kind: "tier", tier: "D2" });
      }
    );

    it("treats an empty capability set as the read-only cap (D1)", () => {
      // Mirrors a plugin manifest that omits `capabilities` entirely.
      const result = deriveDangerTier({ destructiveHint: true }, undefined);
      expect(result.kind).toBe("deny");
    });
  });
});
