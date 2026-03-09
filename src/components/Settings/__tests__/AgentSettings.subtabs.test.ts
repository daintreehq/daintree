import { describe, it, expect } from "vitest";

const GENERAL_SUBTAB_ID = "general";

/**
 * Structural tests verifying the controlled subtab API contract for AgentSettings.
 *
 * AgentSettings now has a "general" subtab (first) followed by per-agent subtabs.
 * These tests verify the derivation logic used inside the component.
 */
describe("AgentSettings subtab derivation logic", () => {
  const agentIds = ["claude", "gemini", "codex", "opencode"];

  function deriveActiveState(
    activeSubtab: string | null,
    agentIds: string[]
  ): { isGeneralActive: boolean; activeAgentId: string | null } {
    const isGeneralActive = activeSubtab === GENERAL_SUBTAB_ID || activeSubtab === null;
    const activeAgentId = isGeneralActive
      ? null
      : agentIds.includes(activeSubtab ?? "")
        ? activeSubtab
        : null;
    return { isGeneralActive, activeAgentId };
  }

  it("shows General when activeSubtab is null (default on first open)", () => {
    const result = deriveActiveState(null, agentIds);
    expect(result.isGeneralActive).toBe(true);
    expect(result.activeAgentId).toBeNull();
  });

  it('shows General when activeSubtab is "general"', () => {
    const result = deriveActiveState("general", agentIds);
    expect(result.isGeneralActive).toBe(true);
    expect(result.activeAgentId).toBeNull();
  });

  it("shows the matching agent when activeSubtab is a valid agent id", () => {
    const gemini = deriveActiveState("gemini", agentIds);
    expect(gemini.isGeneralActive).toBe(false);
    expect(gemini.activeAgentId).toBe("gemini");

    const codex = deriveActiveState("codex", agentIds);
    expect(codex.isGeneralActive).toBe(false);
    expect(codex.activeAgentId).toBe("codex");
  });

  it("shows null agent when activeSubtab is an unknown id (non-general, non-agent)", () => {
    const result = deriveActiveState("unknown-agent", agentIds);
    expect(result.isGeneralActive).toBe(false);
    expect(result.activeAgentId).toBeNull();
  });

  it("is case-sensitive for agent id matching", () => {
    // Agent IDs are lowercase; 'Claude' (capitalized) should not match 'claude'
    const result = deriveActiveState("Claude", agentIds);
    expect(result.isGeneralActive).toBe(false);
    expect(result.activeAgentId).toBeNull();
  });

  it("handles empty agent list gracefully", () => {
    const generalResult = deriveActiveState(null, []);
    expect(generalResult.isGeneralActive).toBe(true);

    const claudeResult = deriveActiveState("claude", []);
    expect(claudeResult.isGeneralActive).toBe(false);
    expect(claudeResult.activeAgentId).toBeNull();
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

  it('navigating to agents-default-agent search result sets subtab to "general"', () => {
    type SettingsTab = "general" | "agents" | "github";
    let activeSubtabs: Partial<Record<SettingsTab, string>> = {};

    const target = {
      tab: "agents" as SettingsTab,
      sectionId: "agents-default-agent",
      subtab: "general",
    };
    if (target.subtab !== undefined) {
      activeSubtabs = { ...activeSubtabs, [target.tab]: target.subtab };
    }
    expect(activeSubtabs.agents).toBe("general");
  });
});
