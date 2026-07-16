// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { DEFAULT_AGENT_SETTINGS, type AgentSettingsEntry } from "@shared/types";
import { setUserRegistry, type AgentConfig } from "@shared/config/agentRegistry";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAgentScope } from "../useAgentScope";

// The alt-screen "Default (inherit)" hint attributes the resolved value to a
// source. Its correctness depends on the three-tier precedence in
// `resolveEffectiveInlineMode` (explicit → curated registry `defaultInlineMode`
// → global switch). No shipped agent sets `defaultInlineMode` (they all default
// inline via the global switch so it stays user-overridable), so the
// registry-default tier is supplied here by a registered synthetic agent. #10894.
const ALT_DEFAULT_AGENT: AgentConfig = {
  id: "alt-default-agent",
  name: "Alt Default Agent",
  command: "alt-default-agent",
  color: "#ffffff",
  iconId: "custom",
  supportsContextInjection: false,
  capabilities: {
    scrollback: 1000,
    inlineModeFlag: "--no-alt-screen",
    defaultInlineMode: false,
  },
};

function makeProps(
  agentId: string,
  activeEntry: AgentSettingsEntry = {}
): Parameters<typeof useAgentScope>[0] {
  return {
    agentId,
    activeEntry,
    ccrPresets: undefined,
    projectPresets: undefined,
    editingPresetId: null,
    setEditingPresetId: () => {},
    editName: "",
    setEditName: () => {},
    lastEditTimeRef: { current: 0 },
    setIsAddDialogOpen: () => {},
    setAddDialogAgentId: () => {},
    updateAgent: async () => {},
    onSettingsChange: () => {},
  };
}

function setGlobalAltScreen(globalUseAltScreen: boolean) {
  useAgentSettingsStore.setState({
    settings: { ...DEFAULT_AGENT_SETTINGS, globalUseAltScreen },
  });
}

describe("useAgentScope — inline-mode inherit origin label (#10894)", () => {
  beforeEach(() => {
    useAgentSettingsStore.setState({ settings: DEFAULT_AGENT_SETTINGS });
    setUserRegistry({ "alt-default-agent": ALT_DEFAULT_AGENT });
  });
  afterEach(() => {
    setUserRegistry({});
  });

  it("attributes an agent with a curated registry default to its built-in default, not the global setting", () => {
    setGlobalAltScreen(false);
    const { result } = renderHook(() => useAgentScope(makeProps("alt-default-agent")));

    expect(result.current.scopeKind).toBe("default");
    expect(result.current.inlineInheritOriginLabel).toBe("the agent's built-in default");
    // The synthetic agent's registry default is alt-screen (`defaultInlineMode: false`).
    expect(result.current.inlineInheritResolvesToInline).toBe(false);
  });

  it("keeps attributing to the built-in default even when the global alt-screen switch is on (the registry default shadows it)", () => {
    setGlobalAltScreen(true);
    const { result } = renderHook(() => useAgentScope(makeProps("alt-default-agent")));

    // Global toggle flipped, but the built-in default still decides —
    // proving the label is not merely echoing the global switch.
    expect(result.current.inlineInheritOriginLabel).toBe("the agent's built-in default");
    expect(result.current.inlineInheritResolvesToInline).toBe(false);
  });

  it("attributes Grok (no registry default anymore) to the global setting, defaulting inline", () => {
    setGlobalAltScreen(false);
    const { result, rerender } = renderHook(() => useAgentScope(makeProps("grok")));

    // Grok no longer pins a curated default — it follows the global switch, so
    // it defaults inline (global "use alt-screen" off ⇒ inline).
    expect(result.current.inlineInheritOriginLabel).toBe("global setting");
    expect(result.current.inlineInheritResolvesToInline).toBe(true);

    setGlobalAltScreen(true);
    rerender();
    expect(result.current.inlineInheritResolvesToInline).toBe(false);
  });

  it("attributes an agent without a registry default (Codex) to the global setting, and tracks the global switch", () => {
    setGlobalAltScreen(false);
    const { result, rerender } = renderHook(() => useAgentScope(makeProps("codex")));

    expect(result.current.scopeKind).toBe("default");
    expect(result.current.inlineInheritOriginLabel).toBe("global setting");
    // No registry default → resolves to `!globalUseAltScreen`.
    expect(result.current.inlineInheritResolvesToInline).toBe(true);

    setGlobalAltScreen(true);
    rerender();
    expect(result.current.inlineInheritOriginLabel).toBe("global setting");
    expect(result.current.inlineInheritResolvesToInline).toBe(false);
  });

  it("labels a custom preset scope as the agent default regardless of the registry tier", () => {
    setGlobalAltScreen(false);
    const entry: AgentSettingsEntry = {
      customPresets: [{ id: "user-1", name: "My preset" }],
      presetId: "user-1",
    };
    const { result } = renderHook(() => useAgentScope(makeProps("grok", entry)));

    expect(result.current.scopeKind).toBe("custom");
    expect(result.current.inlineInheritOriginLabel).toBe("agent default");
  });
});
