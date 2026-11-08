// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_AGENT_SETTINGS, type AgentSettingsEntry } from "@shared/types";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAgentScope } from "../useAgentScope";

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

describe("useAgentScope — skip-permissions Default follows the global switch (#16414)", () => {
  function setGlobalSkip(globalSkipPermissions: boolean) {
    useAgentSettingsStore.setState({
      settings: { ...DEFAULT_AGENT_SETTINGS, globalSkipPermissions },
    });
  }
  afterEach(() => {
    useAgentSettingsStore.setState({ settings: DEFAULT_AGENT_SETTINGS });
  });

  it("resolves Default to On for agents with a bypass flag and no assistant bypass", () => {
    setGlobalSkip(true);
    for (const agentId of ["antigravity", "gemini"]) {
      const { result } = renderHook(() => useAgentScope(makeProps(agentId)));
      expect(result.current.inheritResolvesToOn, agentId).toBe(true);
      expect(result.current.effectiveSkipPerms, agentId).toBe(true);
      expect(result.current.inheritHint, agentId).toBe("Inherited from global setting");
    }
  });

  it("tracks the global switch turning off", () => {
    setGlobalSkip(true);
    const { result, rerender } = renderHook(() => useAgentScope(makeProps("antigravity")));
    expect(result.current.inheritResolvesToOn).toBe(true);

    setGlobalSkip(false);
    rerender();
    expect(result.current.inheritResolvesToOn).toBe(false);
    expect(result.current.effectiveSkipPerms).toBe(false);
    expect(result.current.inheritHint).toBe("Inherited from global setting");
  });

  it("keeps Default off and says the global doesn't apply for an agent with no bypass flag", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() => useAgentScope(makeProps("opencode")));
    expect(result.current.inheritResolvesToOn).toBe(false);
    expect(result.current.effectiveSkipPerms).toBe(false);
    expect(result.current.inheritHint).toBe("The global setting doesn't apply to this agent");
  });

  it("lets the agent's own Off veto the global switch", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() =>
      useAgentScope(makeProps("antigravity", { dangerousMode: "off" }))
    );
    expect(result.current.effectiveSkipPerms).toBe(false);
    expect(result.current.inheritResolvesToOn).toBe(true);
  });

  it("attributes a custom preset's Default to the agent default", () => {
    setGlobalSkip(true);
    const entry: AgentSettingsEntry = {
      customPresets: [{ id: "user-1", name: "My preset" }],
      presetId: "user-1",
    };
    const { result } = renderHook(() => useAgentScope(makeProps("opencode", entry)));
    expect(result.current.scopeKind).toBe("custom");
    expect(result.current.inheritHint).toBe("Inherited from agent default");
  });

  it("layers a custom preset's mode over the agent's global-inherited On", () => {
    setGlobalSkip(true);
    const withPreset = (dangerousMode?: "off" | "on"): AgentSettingsEntry => ({
      customPresets: [{ id: "user-1", name: "My preset", ...(dangerousMode && { dangerousMode }) }],
      presetId: "user-1",
    });
    const inherit = renderHook(() => useAgentScope(makeProps("gemini", withPreset())));
    expect(inherit.result.current.inheritResolvesToOn).toBe(true);
    expect(inherit.result.current.effectiveSkipPerms).toBe(true);

    const vetoed = renderHook(() => useAgentScope(makeProps("gemini", withPreset("off"))));
    expect(vetoed.result.current.dangerousMode).toBe("off");
    expect(vetoed.result.current.effectiveSkipPerms).toBe(false);
  });
});

describe("useAgentScope — rename follows the preset sanitizer's rules", () => {
  const preset = { id: "user-a", name: "Old name" };

  function renameTo(name: string) {
    const updates: Partial<AgentSettingsEntry>[] = [];
    let editing: string | null = "user-a";
    const props = {
      ...makeProps("claude", { customPresets: [preset], presetId: "user-a" }),
      editingPresetId: "user-a",
      editName: name,
      setEditingPresetId: (id: string | null) => {
        editing = id;
      },
      updateAgent: async (_id: string, patch: Partial<AgentSettingsEntry>) => {
        updates.push(patch);
      },
    };
    const { result } = renderHook(() => useAgentScope(props));
    let committed = false;
    act(() => {
      committed = result.current.handleCommitEdit();
    });
    return { committed, editing, updates, error: result.current.renameError };
  }

  // Everything `sanitizePreset` keeps must be renameable; everything it would drop
  // must be refused here, or the preset silently vanishes on the next load.
  it.each(["Greg's Bedrock", 'The "fast" one', "R&D preset"])("accepts %s", (name) => {
    const { committed, editing, updates } = renameTo(name);
    expect(committed).toBe(true);
    expect(editing).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it.each(["<script>", "  ", "x".repeat(201)])(
    "refuses %s and keeps editing with a reason",
    (name) => {
      const { committed, editing, updates, error } = renameTo(name);
      expect(committed).toBe(false);
      expect(editing).toBe("user-a");
      expect(updates).toHaveLength(0);
      expect(error).toBeTruthy();
    }
  );
});
