// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import type { AgentSettings } from "@shared/types/agentSettings";

vi.mock("@/store/agentSettingsStore", async () => {
  const { create } = await import("zustand");
  return {
    useAgentSettingsStore: create<{ settings: AgentSettings | null }>(() => ({ settings: null })),
  };
});
vi.mock("@/store/projectStore", async () => {
  const { create } = await import("zustand");
  return {
    useProjectStore: create<{ currentProject: { id: string } | null }>(() => ({
      currentProject: null,
    })),
  };
});
vi.mock("@/store/scratchStore", async () => {
  const { create } = await import("zustand");
  return {
    useScratchStore: create<{ currentScratch: { id: string } | null }>(() => ({
      currentScratch: null,
    })),
  };
});

const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");
const { useProjectStore } = await import("@/store/projectStore");
const { useScratchStore } = await import("@/store/scratchStore");
const { useScheduleLaunchOptions } = await import("../useScheduleLaunchOptions");

const LOADED_SETTINGS = { agents: {} } as unknown as AgentSettings;
const TEAM = { id: "team", name: "Team" };
const OTHER = { id: "other", name: "Other" };

function setProject(id: string) {
  useProjectStore.setState({ currentProject: { id } } as never);
}

beforeEach(() => {
  useAgentSettingsStore.setState({ settings: LOADED_SETTINGS } as never);
  useProjectStore.setState({ currentProject: null } as never);
  useScratchStore.setState({ currentScratch: null } as never);
  useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: true });
  useProjectPresetsStore.setState({ presetsByAgent: {}, hydratedProjectId: null });
});

describe("useScheduleLaunchOptions", () => {
  it("never lists another project's presets after a switch", () => {
    setProject("a");
    useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", null));
    expect(result.current.presets.map((p) => p.id)).toContain("team");

    act(() => setProject("b"));
    expect(result.current.presets.map((p) => p.id)).not.toContain("team");

    act(() => useProjectPresetsStore.getState().setPresetsByAgent("b", { claude: [OTHER] }));
    const ids = result.current.presets.map((p) => p.id);
    expect(ids).toContain("other");
    expect(ids).not.toContain("team");
  });

  it("doesn't treat a previous project's preset id as valid, and settles it once this project loads", () => {
    setProject("b");
    useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.preset).toBeUndefined();
    expect(result.current.presetStatus).toBe("loading");

    act(() => useProjectPresetsStore.getState().setPresetsByAgent("b", {}));
    expect(result.current.presetStatus).toBe("missing");
  });

  it("finds a project preset once the current project's snapshot lands", () => {
    setProject("a");
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.presetStatus).toBe("loading");

    act(() => useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] }));
    expect(result.current.preset?.id).toBe("team");
    expect(result.current.presetStatus).toBe("found");
  });

  it("keeps a saved id unsettled until agent settings have loaded", () => {
    setProject("a");
    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    useAgentSettingsStore.setState({ settings: null } as never);
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "user-mine"));
    expect(result.current.presetStatus).toBe("loading");
    expect(result.current.stopsAtPrompts).toBeNull();

    act(() =>
      useAgentSettingsStore.setState({
        settings: {
          agents: { claude: { customPresets: [{ id: "user-mine", name: "Mine" }] } },
        } as unknown as AgentSettings,
      } as never)
    );
    expect(result.current.presetStatus).toBe("found");
    expect(result.current.preset?.name).toBe("Mine");
  });

  it("keeps a CCR id unsettled until the CCR routes have been read", () => {
    setProject("a");
    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "ccr-route"));
    expect(result.current.presetStatus).toBe("loading");

    act(() => useCcrPresetsStore.getState().markInitialized());
    expect(result.current.presetStatus).toBe("missing");
  });

  it("settles a non-CCR id without waiting on the CCR routes", () => {
    setProject("a");
    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "gone"));
    expect(result.current.presetStatus).toBe("missing");
  });

  it("reads the snapshot as this project's once its owner changes, even with the same bucket", () => {
    setProject("b");
    const byAgent = { claude: [TEAM] };
    useProjectPresetsStore.setState({ presetsByAgent: byAgent, hydratedProjectId: "a" });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.presetStatus).toBe("loading");

    act(() => useProjectPresetsStore.setState({ hydratedProjectId: "b" }));
    expect(result.current.presetStatus).toBe("found");
  });

  it("gives a scratch workspace no project presets, and settles absence once it resolves", () => {
    useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.presetStatus).toBe("loading");

    act(() => useScratchStore.setState({ currentScratch: { id: "s" } } as never));
    expect(result.current.presets.map((p) => p.id)).not.toContain("team");
    expect(result.current.presetStatus).toBe("missing");
  });

  it("can't settle absence in a view that has resolved neither a project nor a scratch", () => {
    useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] });
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.presets.map((p) => p.id)).not.toContain("team");
    expect(result.current.presetStatus).toBe("loading");
  });

  it("calls a custom preset missing once loaded settings don't hold it", () => {
    setProject("a");
    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    useAgentSettingsStore.setState({ settings: null } as never);
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "user-gone"));
    expect(result.current.presetStatus).toBe("loading");

    act(() => useAgentSettingsStore.setState({ settings: LOADED_SETTINGS } as never));
    expect(result.current.presetStatus).toBe("missing");
    expect(result.current.stopsAtPrompts).not.toBeNull();
  });

  it("holds the permission-prompt reading while the chosen preset is still loading", () => {
    setProject("a");
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", "team"));
    expect(result.current.stopsAtPrompts).toBeNull();

    act(() => useProjectPresetsStore.getState().setPresetsByAgent("a", { claude: [TEAM] }));
    expect(result.current.stopsAtPrompts).not.toBeNull();
  });

  it("reports no preset when none is chosen", () => {
    const { result } = renderHook(() => useScheduleLaunchOptions("claude", null));
    expect(result.current.presetStatus).toBe("none");
    expect(result.current.stopsAtPrompts).not.toBeNull();
  });

  it("counts an Auto launch as not stopping, and an Auto the agent can't honour as stopping (#17435)", () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: { codex: { dangerousMode: "auto" }, gemini: { dangerousMode: "auto" } },
        globalSkipPermissions: true,
      },
    } as never);
    expect(
      renderHook(() => useScheduleLaunchOptions("codex", null)).result.current.stopsAtPrompts
    ).toBe(false);
    expect(
      renderHook(() => useScheduleLaunchOptions("gemini", null)).result.current.stopsAtPrompts
    ).toBe(true);
  });
});
