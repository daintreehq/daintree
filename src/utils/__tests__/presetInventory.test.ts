import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import {
  ownedProjectPresets,
  presetInventoryState,
  readLaunchPresetSources,
  waitForLaunchPresets,
} from "../presetInventory";

const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");

vi.mock("@/store/agentSettingsStore", async () => {
  const { create } = await import("zustand");
  return {
    useAgentSettingsStore: create<{ settings: { agents: Record<string, never> } | null }>(() => ({
      settings: null,
    })),
  };
});

describe("presetInventoryState", () => {
  it("passes the CCR read through whatever the project's state", () => {
    const scope = { projectId: "a", scratchId: undefined };
    expect(presetInventoryState(false, "a", scope)).toEqual({ ccr: false, project: true });
    expect(presetInventoryState(true, null, scope)).toEqual({ ccr: true, project: false });
  });

  it("counts a project's presets as loaded only when the snapshot is that project's", () => {
    const scope = { projectId: "a", scratchId: undefined };
    expect(presetInventoryState(true, "a", scope).project).toBe(true);
    expect(presetInventoryState(true, "b", scope).project).toBe(false);
    expect(presetInventoryState(true, null, scope).project).toBe(false);
  });

  it("has nothing to wait for in a scratch workspace, and can't tell in an unresolved view", () => {
    expect(presetInventoryState(true, null, { projectId: undefined, scratchId: "s" }).project).toBe(
      true
    );
    expect(
      presetInventoryState(true, null, { projectId: undefined, scratchId: undefined }).project
    ).toBe(false);
  });
});

describe("ownedProjectPresets", () => {
  const presets = [{ id: "team", name: "Team" }];

  it("hands a snapshot only to the project that owns it", () => {
    expect(ownedProjectPresets(presets, "a", { projectId: "a", scratchId: undefined })).toBe(
      presets
    );
    expect(
      ownedProjectPresets(presets, "a", { projectId: "b", scratchId: undefined })
    ).toBeUndefined();
    expect(
      ownedProjectPresets(presets, null, { projectId: "a", scratchId: undefined })
    ).toBeUndefined();
  });

  it("never hands one to a scratch, though a scratch has no project presets to wait for", () => {
    const scope = { projectId: undefined, scratchId: "s" };
    expect(presetInventoryState(true, "a", scope).project).toBe(true);
    expect(ownedProjectPresets(presets, "a", scope)).toBeUndefined();
  });
});

describe("readLaunchPresetSources", () => {
  it("hands over a project snapshot only to the project it belongs to", () => {
    useProjectPresetsStore.setState({
      presetsByAgent: { claude: [{ id: "team", name: "Team" }] },
      hydratedProjectId: "a",
    });

    expect(
      readLaunchPresetSources("claude", { projectId: "a", scratchId: undefined }).projectPresets
    ).toEqual([{ id: "team", name: "Team" }]);
    expect(
      readLaunchPresetSources("claude", { projectId: "b", scratchId: undefined })
    ).toMatchObject({ projectPresets: undefined, presetInventory: { project: false } });
    expect(
      readLaunchPresetSources("claude", { projectId: undefined, scratchId: "s" }).projectPresets
    ).toBeUndefined();
    expect(
      readLaunchPresetSources("claude", { projectId: undefined, scratchId: undefined })
        .projectPresets
    ).toBeUndefined();
  });
});

describe("waitForLaunchPresets", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    useProjectPresetsStore.setState({ presetsByAgent: {}, hydratedProjectId: null });
    useAgentSettingsStore.setState({ settings: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at once, arming nothing, when the check already holds", async () => {
    await expect(waitForLaunchPresets(() => true)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when a store change makes the check hold, and stops listening", async () => {
    const isSettled = vi.fn(() => useProjectPresetsStore.getState().hydratedProjectId === "a");
    const wait = waitForLaunchPresets(isSettled);

    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    await expect(wait).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const calls = isSettled.mock.calls.length;
    useCcrPresetsStore.getState().markInitialized();
    expect(isSettled).toHaveBeenCalledTimes(calls);
  });

  it("wakes on the CCR routes alone", async () => {
    const wait = waitForLaunchPresets(() => useCcrPresetsStore.getState().isInitialized);

    useCcrPresetsStore.getState().markInitialized();

    await expect(wait).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes when the agent settings change, as when a different preset is chosen", async () => {
    const wait = waitForLaunchPresets(() => useAgentSettingsStore.getState().settings !== null);

    useAgentSettingsStore.setState({ settings: { agents: {} } });

    await expect(wait).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening to every store once it settles", async () => {
    let settled = false;
    const isSettled = vi.fn(() => settled);
    const wait = waitForLaunchPresets(isSettled);
    settled = true;
    useCcrPresetsStore.getState().markInitialized();
    await expect(wait).resolves.toBe(true);

    const calls = isSettled.mock.calls.length;
    useCcrPresetsStore.setState({ isInitialized: false });
    useProjectPresetsStore.getState().setPresetsByAgent("b", {});
    useAgentSettingsStore.setState({ settings: { agents: {} } });
    expect(isSettled).toHaveBeenCalledTimes(calls);
  });

  it("gives up at the deadline when nothing ever loads, and stops listening", async () => {
    const isSettled = vi.fn(() => useCcrPresetsStore.getState().isInitialized);
    const wait = waitForLaunchPresets(isSettled, 3_000);

    await vi.advanceTimersByTimeAsync(2_999);
    useProjectPresetsStore.getState().setPresetsByAgent("a", {});
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBe(false);

    const calls = isSettled.mock.calls.length;
    useCcrPresetsStore.getState().markInitialized();
    expect(isSettled).toHaveBeenCalledTimes(calls);
  });
});
