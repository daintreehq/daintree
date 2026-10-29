import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { presetInventoryState, waitForLaunchPresets } from "../presetInventory";

vi.mock("@/store/agentSettingsStore", async () => {
  const { create } = await import("zustand");
  return { useAgentSettingsStore: create(() => ({ settings: null })) };
});

describe("presetInventoryState", () => {
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

describe("waitForLaunchPresets", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    useProjectPresetsStore.setState({ presetsByAgent: {}, hydratedProjectId: null });
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
