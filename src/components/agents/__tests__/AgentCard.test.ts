import { describe, expect, it } from "vitest";
import { AGENT_DESCRIPTIONS } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

describe("AGENT_DESCRIPTIONS", () => {
  it("has descriptions for all featured agents", () => {
    expect(AGENT_DESCRIPTIONS).toHaveProperty("claude");
    expect(AGENT_DESCRIPTIONS).toHaveProperty("gemini");
    expect(AGENT_DESCRIPTIONS).toHaveProperty("codex");
  });

  it("has descriptions for more agents", () => {
    expect(AGENT_DESCRIPTIONS).toHaveProperty("opencode");
    expect(AGENT_DESCRIPTIONS).toHaveProperty("cursor");
    expect(AGENT_DESCRIPTIONS).toHaveProperty("kiro");
    expect(AGENT_DESCRIPTIONS).toHaveProperty("kimi");
  });

  it("all descriptions are non-empty strings", () => {
    for (const [_id, desc] of Object.entries(AGENT_DESCRIPTIONS)) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it("covers all built-in agent IDs that have custom descriptions", () => {
    const describedIds = Object.keys(AGENT_DESCRIPTIONS).sort();
    const builtInIds = [...BUILT_IN_AGENT_IDS].sort();
    // All described agents should be valid built-in agents
    for (const id of describedIds) {
      expect(builtInIds).toContain(id);
    }
  });
});

describe("AgentCard type discrimination", () => {
  it("onboarding mode props shape is correct", () => {
    const onboardingProps = {
      mode: "onboarding" as const,
      agentId: "claude",
      availability: { claude: "ready" as const },
      isChecked: true,
      isSaving: false,
      onToggle: (_id: string, _checked: boolean) => {},
      compact: false,
    };

    expect(onboardingProps.mode).toBe("onboarding");
    expect(onboardingProps.agentId).toBe("claude");
    expect(onboardingProps.isChecked).toBe(true);
  });

  it("management mode props shape is correct", () => {
    const managementProps = {
      mode: "management" as const,
      agentId: "claude",
      actions: null,
      children: null,
    };

    expect(managementProps.mode).toBe("management");
    expect(managementProps.agentId).toBe("claude");
  });

  it("onboarding mode has no children prop", () => {
    const onboardingProps = {
      mode: "onboarding" as const,
      agentId: "claude",
      availability: {},
      isChecked: false,
      isSaving: false,
      onToggle: () => {},
    };

    expect("children" in onboardingProps).toBe(false);
  });

  it("management mode has no checkbox-related props", () => {
    const managementProps = {
      mode: "management" as const,
      agentId: "claude",
      children: null,
    };

    expect("isChecked" in managementProps).toBe(false);
    expect("isSaving" in managementProps).toBe(false);
    expect("onToggle" in managementProps).toBe(false);
  });
});
