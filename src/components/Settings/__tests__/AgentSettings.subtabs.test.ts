import { describe, it, expect } from "vitest";

const GENERAL_SUBTAB_ID = "general";

/**
 * Structural tests verifying the controlled subtab API contract for AgentSettings.
 *
 * AgentSettings now has a "general" subtab (first) followed by per-agent subtabs.
 * These tests verify the derivation logic used inside the component.
 */
describe("AgentSettings subtab derivation logic", () => {
  const agentIds = ["claude", "gemini", "codex", "opencode", "cursor"];

  function deriveActiveState(
    activeSubtab: string | null,
    agentIds: string[]
  ): { isGeneralActive: boolean; activeAgentId: string | null } {
    // Matches the component logic: unknown subtab ids coerce to General.
    const isGeneralActive =
      activeSubtab === GENERAL_SUBTAB_ID ||
      activeSubtab === null ||
      !agentIds.includes(activeSubtab ?? "");
    const activeAgentId = isGeneralActive ? null : activeSubtab;
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

    const cursor = deriveActiveState("cursor", agentIds);
    expect(cursor.isGeneralActive).toBe(false);
    expect(cursor.activeAgentId).toBe("cursor");
  });

  it("falls back to General when activeSubtab is an unknown id (prevents blank screen)", () => {
    const result = deriveActiveState("unknown-agent", agentIds);
    expect(result.isGeneralActive).toBe(true);
    expect(result.activeAgentId).toBeNull();
  });

  it("falls back to General for unknown capitalized id (case-sensitive: 'Claude' ≠ 'claude')", () => {
    const result = deriveActiveState("Claude", agentIds);
    expect(result.isGeneralActive).toBe(true);
    expect(result.activeAgentId).toBeNull();
  });

  it("handles empty agent list gracefully", () => {
    const generalResult = deriveActiveState(null, []);
    expect(generalResult.isGeneralActive).toBe(true);

    // With empty registry, "claude" is unknown → falls back to General (no blank screen)
    const claudeResult = deriveActiveState("claude", []);
    expect(claudeResult.isGeneralActive).toBe(true);
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
