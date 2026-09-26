import { describe, expect, it } from "vitest";
import { normalizeDaintreeMcpTier, resolveDaintreeMcpTier } from "../project.js";

describe("normalizeDaintreeMcpTier", () => {
  it.each(["off", "core", "full"] as const)("keeps the current value %s", (tier) => {
    expect(normalizeDaintreeMcpTier(tier)).toBe(tier);
  });

  // Project files written before the core/full split are read in place, never
  // rewritten, so each rung of the old ladder must land on its equivalent set.
  it.each([
    ["workbench", "core"],
    ["action", "core"],
    ["system", "full"],
  ] as const)("reads the pre-split %s as %s", (stored, expected) => {
    expect(normalizeDaintreeMcpTier(stored)).toBe(expected);
  });

  it.each([undefined, null, "", "godmode", "external", "CORE", 1, true, {}])(
    "returns null for %j",
    (value) => {
      expect(normalizeDaintreeMcpTier(value)).toBeNull();
    }
  );
});

describe("resolveDaintreeMcpTier", () => {
  it("defaults to off when nothing is stored", () => {
    expect(resolveDaintreeMcpTier({})).toBe("off");
    expect(resolveDaintreeMcpTier({ exposeDaintreeMcpToAgents: false })).toBe("off");
  });

  it("maps the legacy exposeDaintreeMcpToAgents flag to core", () => {
    expect(resolveDaintreeMcpTier({ exposeDaintreeMcpToAgents: true })).toBe("core");
  });

  it.each([
    ["workbench", "core"],
    ["action", "core"],
    ["system", "full"],
    ["core", "core"],
    ["full", "full"],
  ] as const)("resolves a stored %s to %s", (stored, expected) => {
    expect(resolveDaintreeMcpTier({ daintreeMcpTier: stored })).toBe(expected);
  });

  it("lets an explicit tier win over the legacy flag, including an explicit off", () => {
    expect(
      resolveDaintreeMcpTier({ daintreeMcpTier: "off", exposeDaintreeMcpToAgents: true })
    ).toBe("off");
    expect(
      resolveDaintreeMcpTier({ daintreeMcpTier: "system", exposeDaintreeMcpToAgents: true })
    ).toBe("full");
  });

  it("falls back to the legacy flag when the stored tier is unrecognised", () => {
    expect(
      resolveDaintreeMcpTier({ daintreeMcpTier: "godmode", exposeDaintreeMcpToAgents: true })
    ).toBe("core");
    expect(resolveDaintreeMcpTier({ daintreeMcpTier: "godmode" })).toBe("off");
  });
});
