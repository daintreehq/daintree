import { describe, it, expect, vi } from "vitest";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

/**
 * Tests for the agent navigation callback contract in GeneralTab.
 *
 * GeneralTab.onNavigateToAgents accepts an optional agentId string.
 * When called with an agentId, SettingsDialog sets both the active tab
 * to "agents" and the agents subtab to that specific agent.
 * When called with no argument, it just navigates to the Agents tab.
 */
describe("onNavigateToAgents callback contract", () => {
  function createSettingsDialogCallback() {
    const setActiveTab = vi.fn<(tab: string) => void>();
    const setActiveSubtabs =
      vi.fn<(updater: (prev: Record<string, string>) => Record<string, string>) => void>();

    const onNavigateToAgents = (agentId?: string) => {
      setActiveTab("agents");
      if (agentId) {
        setActiveSubtabs((prev) => ({ ...prev, agents: agentId }));
      }
    };

    return { onNavigateToAgents, setActiveTab, setActiveSubtabs };
  }

  it("sets activeTab to agents when called with an agentId", () => {
    const { onNavigateToAgents, setActiveTab } = createSettingsDialogCallback();
    onNavigateToAgents("claude");
    expect(setActiveTab).toHaveBeenCalledWith("agents");
  });

  it("sets agents subtab to the provided agentId", () => {
    const { onNavigateToAgents, setActiveSubtabs } = createSettingsDialogCallback();
    onNavigateToAgents("claude");
    expect(setActiveSubtabs).toHaveBeenCalledTimes(1);

    const updater = setActiveSubtabs.mock.calls[0][0];
    const result = updater({});
    expect(result).toEqual({ agents: "claude" });
  });

  it("preserves existing subtabs when setting agents subtab", () => {
    const { onNavigateToAgents, setActiveSubtabs } = createSettingsDialogCallback();
    onNavigateToAgents("gemini");

    const updater = setActiveSubtabs.mock.calls[0][0];
    const result = updater({ general: "overview", keyboard: "shortcuts" });
    expect(result).toEqual({ general: "overview", keyboard: "shortcuts", agents: "gemini" });
  });

  it("sets activeTab to agents when called without an agentId", () => {
    const { onNavigateToAgents, setActiveTab } = createSettingsDialogCallback();
    onNavigateToAgents();
    expect(setActiveTab).toHaveBeenCalledWith("agents");
  });

  it("does not set agents subtab when called without an agentId", () => {
    const { onNavigateToAgents, setActiveSubtabs } = createSettingsDialogCallback();
    onNavigateToAgents();
    expect(setActiveSubtabs).not.toHaveBeenCalled();
  });

  it("works with all built-in agent IDs", () => {
    for (const id of BUILT_IN_AGENT_IDS) {
      const { onNavigateToAgents, setActiveSubtabs } = createSettingsDialogCallback();
      onNavigateToAgents(id);

      const updater = setActiveSubtabs.mock.calls[0][0];
      expect(updater({})).toEqual({ agents: id });
    }
  });
});
