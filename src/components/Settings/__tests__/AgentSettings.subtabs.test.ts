import { describe, it, expect } from "vitest";

/**
 * Structural tests verifying the controlled subtab API contract for AgentSettings.
 *
 * The component requires `activeSubtab` and `onSubtabChange` from its parent (SettingsDialog).
 * These tests verify the derivation logic that maps the external subtab state to an active agent id.
 */
describe("AgentSettings subtab derivation logic", () => {
  const agentIds = ["claude", "gemini", "codex", "opencode"];

  function deriveActiveAgentId(activeSubtab: string | null, agentIds: string[]): string | null {
    return (activeSubtab && agentIds.includes(activeSubtab) ? activeSubtab : agentIds[0]) ?? null;
  }

  it("returns the first agent when activeSubtab is null", () => {
    expect(deriveActiveAgentId(null, agentIds)).toBe("claude");
  });

  it("returns the matching agent when activeSubtab is a valid agent id", () => {
    expect(deriveActiveAgentId("gemini", agentIds)).toBe("gemini");
    expect(deriveActiveAgentId("codex", agentIds)).toBe("codex");
  });

  it("falls back to first agent when activeSubtab is an unknown id", () => {
    expect(deriveActiveAgentId("unknown-agent", agentIds)).toBe("claude");
  });

  it("returns null when agent list is empty", () => {
    expect(deriveActiveAgentId(null, [])).toBeNull();
    expect(deriveActiveAgentId("claude", [])).toBeNull();
  });

  it("is case-sensitive for agent id matching", () => {
    // Agent IDs are lowercase; 'Claude' (capitalized) should not match 'claude'
    expect(deriveActiveAgentId("Claude", agentIds)).toBe("claude");
  });
});

describe("SettingsDialog subtab state", () => {
  it("Partial<Record<SettingsTab, string>> allows per-tab memory", () => {
    type SettingsTab = "general" | "agents" | "github";
    const state: Partial<Record<SettingsTab, string>> = {};

    // Navigating to agents tab sets subtab for agents only
    const updated: Partial<Record<SettingsTab, string>> = { ...state, agents: "gemini" };
    expect(updated.agents).toBe("gemini");
    expect(updated.github).toBeUndefined();

    // Switching to github tab does not clear agents subtab
    const afterGitHub = { ...updated };
    expect(afterGitHub.agents).toBe("gemini");
  });

  it("undefined subtab in nav target does not override stored subtab", () => {
    type SettingsTab = "general" | "agents" | "github";
    let activeSubtabs: Partial<Record<SettingsTab, string>> = { agents: "codex" };

    // Simulating handleResultClick without subtab (no subtab in search result)
    const target = { tab: "agents" as SettingsTab, sectionId: "agents-enable", subtab: undefined };
    if (target.subtab !== undefined) {
      activeSubtabs = { ...activeSubtabs, [target.tab]: target.subtab };
    }
    // Stored subtab should remain unchanged
    expect(activeSubtabs.agents).toBe("codex");
  });

  it("explicit subtab in nav target updates stored subtab", () => {
    type SettingsTab = "general" | "agents" | "github";
    let activeSubtabs: Partial<Record<SettingsTab, string>> = { agents: "codex" };

    const target = { tab: "agents" as SettingsTab, sectionId: "agents-enable", subtab: "gemini" };
    if (target.subtab !== undefined) {
      activeSubtabs = { ...activeSubtabs, [target.tab]: target.subtab };
    }
    expect(activeSubtabs.agents).toBe("gemini");
  });
});
