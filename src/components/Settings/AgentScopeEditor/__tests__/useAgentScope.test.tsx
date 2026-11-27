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
    editPick: null,
    setEditPick: () => {},
    editName: "",
    setEditName: () => {},
    lastEditTimeRef: { current: 0 },
    setIsAddDialogOpen: () => {},
    setAddDialogAgentId: () => {},
    updateAgent: async () => {},
    onSettingsChange: () => {},
  };
}

describe("useAgentScope — permission Inherit follows the global switch (#16414)", () => {
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
      expect(result.current.inheritLevel, agentId).toBe("skip");
      expect(result.current.effectiveLevel, agentId).toBe("skip");
      expect(result.current.inheritHint, agentId).toBe("Inherited from global setting");
    }
  });

  it("tracks the global switch turning off", () => {
    setGlobalSkip(true);
    const { result, rerender } = renderHook(() => useAgentScope(makeProps("antigravity")));
    expect(result.current.inheritLevel).toBe("skip");

    setGlobalSkip(false);
    rerender();
    expect(result.current.inheritLevel).toBe("cli-default");
    expect(result.current.effectiveLevel).toBe("cli-default");
    expect(result.current.inheritHint).toBe("Inherited from global setting");
  });

  it("keeps Default off and says the global doesn't apply for an agent with no bypass flag", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() => useAgentScope(makeProps("opencode")));
    expect(result.current.inheritLevel).toBe("cli-default");
    expect(result.current.effectiveLevel).toBe("cli-default");
    expect(result.current.inheritHint).toBe("The global setting doesn't apply to this agent");
  });

  it("lets the agent's own Off veto the global switch", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() =>
      useAgentScope(makeProps("antigravity", { dangerousMode: "off" }))
    );
    expect(result.current.effectiveLevel).toBe("cli-default");
    expect(result.current.inheritLevel).toBe("skip");
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
    expect(inherit.result.current.inheritLevel).toBe("skip");
    expect(inherit.result.current.effectiveLevel).toBe("skip");

    const vetoed = renderHook(() => useAgentScope(makeProps("gemini", withPreset("off"))));
    expect(vetoed.result.current.dangerousMode).toBe("off");
    expect(vetoed.result.current.effectiveLevel).toBe("cli-default");
  });

  it("resolves an agent's own Auto over the global switch, naming the flags it adds (#17435)", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() =>
      useAgentScope(makeProps("codex", { dangerousMode: "auto" }))
    );
    expect(result.current.autoSupported).toBe(true);
    expect(result.current.effectiveLevel).toBe("auto");
    expect(result.current.effectivePermissionArgs).toBe("--approve-for-me");
    expect(result.current.inheritLevel).toBe("skip");
  });

  it("carries the agent's Auto down to a preset that inherits it, and lets the preset's Skip all win", () => {
    const withPreset = (dangerousMode?: "on"): AgentSettingsEntry => ({
      dangerousMode: "auto",
      customPresets: [{ id: "user-1", name: "My preset", ...(dangerousMode && { dangerousMode }) }],
      presetId: "user-1",
    });
    const inherit = renderHook(() => useAgentScope(makeProps("claude", withPreset())));
    expect(inherit.result.current.inheritLevel).toBe("auto");
    expect(inherit.result.current.effectivePermissionArgs).toBe("--permission-mode auto");

    const skip = renderHook(() => useAgentScope(makeProps("claude", withPreset("on"))));
    expect(skip.result.current.effectiveLevel).toBe("skip");
    expect(skip.result.current.effectivePermissionArgs).toBe("--dangerously-skip-permissions");
  });

  it("launches a saved Auto on the CLI default, never Skip all, for an agent with no Auto mode", () => {
    setGlobalSkip(true);
    const { result } = renderHook(() =>
      useAgentScope(makeProps("gemini", { dangerousMode: "auto" }))
    );
    expect(result.current.autoSupported).toBe(false);
    expect(result.current.dangerousMode).toBe("auto");
    expect(result.current.effectiveLevel).toBe("cli-default");
    expect(result.current.effectivePermissionArgs).toBe("");
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

describe("useAgentScope — duplicating a preset's continuation switch (#17912)", () => {
  async function duplicate(entry: AgentSettingsEntry, preset: { id: string; name: string }) {
    const writes: Array<Partial<AgentSettingsEntry>> = [];
    const props = {
      ...makeProps("codex", entry),
      updateAgent: async (_agentId: string, updates: Partial<AgentSettingsEntry>) => {
        writes.push(updates);
      },
    };
    const { result } = renderHook(() => useAgentScope(props));
    await act(async () => {
      result.current.handleDuplicatePreset({ ...preset, continueAtLimitReset: true });
    });
    return writes[0]?.customPresets?.at(-1);
  }

  it("opens the copy for editing and leaves the launch preset alone (#18278)", async () => {
    const own = { id: "user-1", name: "Mine" };
    const writes: Array<Partial<AgentSettingsEntry>> = [];
    const picks: unknown[] = [];
    const props = {
      ...makeProps("codex", { customPresets: [own], presetId: "user-1" }),
      setEditPick: (p: unknown) => picks.push(p),
      updateAgent: async (_id: string, u: Partial<AgentSettingsEntry>) => {
        writes.push(u);
      },
    };
    const { result } = renderHook(() => useAgentScope(props));
    await act(async () => {
      result.current.handleDuplicatePreset(own);
    });
    expect(writes).toHaveLength(1);
    expect("presetId" in writes[0]!).toBe(false);
    expect(picks).toHaveLength(1);
    expect((picks[0] as { id: string }).id).toMatch(/^user-/);
  });

  it("keeps it on a copy of the user's own preset", async () => {
    const own = { id: "user-1", name: "Mine", continueAtLimitReset: true };
    const copy = await duplicate({ customPresets: [own] }, own);
    expect(copy?.name).toBe("Mine (copy)");
    expect(copy?.continueAtLimitReset).toBe(true);
  });

  it("drops it when the user's own entry under that id is one the sanitiser discards", async () => {
    const discarded = { id: "team", name: "<bad>" };
    const copy = await duplicate({ customPresets: [discarded] }, { id: "team", name: "Team" });
    expect(copy?.continueAtLimitReset).toBeUndefined();
  });

  it("drops it from a copy of a repository's preset, whose switch the user never saw", async () => {
    const copy = await duplicate({ customPresets: [] }, { id: "team", name: "Team" });
    expect(copy?.name).toBe("Team (copy)");
    expect(copy?.continueAtLimitReset).toBeUndefined();
  });
});

describe("useAgentScope — editing a preset is separate from the launch preset (#18278)", () => {
  const a = { id: "user-a", name: "A" };
  const b = { id: "user-b", name: "B" };
  const entry: AgentSettingsEntry = { customPresets: [a, b], presetId: "user-a" };

  it("edits the launch preset until another is picked", () => {
    const { result } = renderHook(() => useAgentScope(makeProps("claude", entry)));
    expect(result.current.editedPresetId).toBe("user-a");
    expect(result.current.selectedPreset?.id).toBe("user-a");
  });

  it("edits the picked preset and writes nothing", () => {
    const writes: unknown[] = [];
    const props = {
      ...makeProps("claude", entry),
      editPick: { id: "user-b" },
      updateAgent: async (_id: string, u: Partial<AgentSettingsEntry>) => {
        writes.push(u);
      },
    };
    const { result } = renderHook(() => useAgentScope(props));
    expect(result.current.editedPresetId).toBe("user-b");
    expect(result.current.selectedPreset?.id).toBe("user-b");
    expect(result.current.launchPresetId).toBe("user-a");
    expect(writes).toEqual([]);
  });

  it("falls back to the launch preset when the picked one is gone", () => {
    const props = { ...makeProps("claude", entry), editPick: { id: "user-gone" } };
    const { result } = renderHook(() => useAgentScope(props));
    expect(result.current.editedPresetId).toBe("user-a");
  });

  it("only the launch control writes presetId", async () => {
    const writes: Array<Partial<AgentSettingsEntry>> = [];
    const props = {
      ...makeProps("claude", entry),
      updateAgent: async (_id: string, u: Partial<AgentSettingsEntry>) => {
        writes.push(u);
      },
    };
    const { result } = renderHook(() => useAgentScope(props));
    await act(async () => {
      result.current.handleLaunchPresetChange("user-b");
    });
    expect(writes).toEqual([{ presetId: "user-b" }]);
  });
});
