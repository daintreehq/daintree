import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAgentContinuity,
  getAgentIds,
  getEffectiveAgentConfig,
  setUserRegistry,
  type AgentConfig,
  type ConversationContinuityTier,
} from "../agentRegistry.js";

const VALID_TIERS: ConversationContinuityTier[] = [
  "preserved",
  "project-local",
  "provider-migration",
  "unavailable",
  "unverified",
];

function userAgent(
  overrides: Partial<AgentConfig> & Pick<AgentConfig, "id" | "name">
): AgentConfig {
  return {
    command: "noop",
    color: "#ffffff",
    iconId: "terminal",
    supportsContextInjection: false,
    ...overrides,
  };
}

describe("resolveAgentContinuity (#11282 phase 5)", () => {
  beforeEach(() => setUserRegistry({}));
  afterEach(() => setUserRegistry({}));

  it("defaults an unknown agent id to the honest 'unverified', never a false 'preserved'", () => {
    // The safe default is the whole point: an unclassified agent must not claim
    // its conversation survives a move.
    expect(resolveAgentContinuity("no-such-agent-xyz")).toEqual({ tier: "unverified" });
  });

  it("passes a declared continuity block through unchanged", () => {
    // Compare against the source config instead of hardcoding a tier literal, so
    // this asserts passthrough behavior rather than duplicating the config value.
    for (const id of getAgentIds()) {
      const declared = getEffectiveAgentConfig(id)?.continuity;
      if (!declared) continue;
      expect(resolveAgentContinuity(id)).toEqual(declared);
    }
  });

  it("resolves every built-in agent to a structurally valid tier and never throws", () => {
    for (const id of getAgentIds()) {
      expect(VALID_TIERS).toContain(resolveAgentContinuity(id).tier);
    }
  });

  it("reads the effective registry so a user agent's continuity resolves", () => {
    setUserRegistry({
      "custom-preserved": userAgent({
        id: "custom-preserved",
        name: "Custom Preserved",
        continuity: { tier: "preserved", detail: "user agent test" },
      }),
      "custom-bare": userAgent({ id: "custom-bare", name: "Custom Bare" }),
    });

    expect(resolveAgentContinuity("custom-preserved")).toEqual({
      tier: "preserved",
      detail: "user agent test",
    });
    // A user agent that declares no continuity still gets the safe default.
    expect(resolveAgentContinuity("custom-bare")).toEqual({ tier: "unverified" });
  });

  it("declares each actionable tier on at least one built-in agent", () => {
    // Guards the config from silently collapsing to all-"unverified" (which would
    // make the preview useless) without asserting WHICH agent owns each tier.
    const declared = new Set(getAgentIds().map((id) => resolveAgentContinuity(id).tier));
    expect(declared.has("preserved")).toBe(true);
    expect(declared.has("provider-migration")).toBe(true);
    expect(declared.has("unavailable")).toBe(true);
  });
});
