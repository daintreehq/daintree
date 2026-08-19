// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentPreset } from "@shared/config/agentRegistry";

import { useCcrPresetsSubscription } from "../useCcrPresetsSubscription";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";

type PresetsUpdatedHandler = (payload: { agentId: string; presets: AgentPreset[] }) => void;

const getCcrPresets = vi.fn<() => Promise<AgentPreset[]>>();
const onPresetsUpdated = vi.fn<(handler: PresetsUpdatedHandler) => () => void>();
let emit: PresetsUpdatedHandler | undefined;

beforeEach(() => {
  getCcrPresets.mockReset();
  onPresetsUpdated.mockReset();
  emit = undefined;
  onPresetsUpdated.mockImplementation((handler) => {
    emit = handler;
    return () => {
      emit = undefined;
    };
  });
  useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
  (window as unknown as { electron?: unknown }).electron = {
    agentCapabilities: { getCcrPresets, onPresetsUpdated },
  };
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

/**
 * `isInitialized` is what lets a reader tell "this agent has no CCR presets"
 * from "the CCR read has not happened yet". The two are indistinguishable in
 * `ccrPresetsByAgent` itself, so these cases pin down exactly which outcomes
 * are allowed to certify the snapshot.
 */
describe("useCcrPresetsSubscription", () => {
  async function mount(): Promise<void> {
    await act(async () => {
      renderHook(() => useCcrPresetsSubscription());
    });
  }

  it("stores discovered presets and marks the snapshot proven", async () => {
    getCcrPresets.mockResolvedValue([{ id: "zai", name: "Z.AI" }]);

    await mount();

    const state = useCcrPresetsStore.getState();
    expect(state.ccrPresetsByAgent.claude?.[0]?.id).toBe("zai");
    expect(state.isInitialized).toBe(true);
  });

  it("marks a successful empty read as proven without inventing an entry", async () => {
    getCcrPresets.mockResolvedValue([]);

    await mount();

    const state = useCcrPresetsStore.getState();
    expect(state.isInitialized).toBe(true);
    // An empty array here would replace the built-in registry bucket downstream,
    // so the agent key must stay absent rather than be written as `[]`.
    expect(Object.hasOwn(state.ccrPresetsByAgent, "claude")).toBe(false);
  });

  it("leaves the snapshot unproven when the read fails", async () => {
    getCcrPresets.mockRejectedValue(new Error("no ccr"));

    await mount();

    expect(useCcrPresetsStore.getState().isInitialized).toBe(false);
  });

  it("treats a missing bridge as nothing to wait for", async () => {
    (window as unknown as { electron?: unknown }).electron = { agentCapabilities: {} };

    await mount();

    expect(useCcrPresetsStore.getState().isInitialized).toBe(true);
    expect(getCcrPresets).not.toHaveBeenCalled();
  });

  it("proves the snapshot from an update event after a failed initial read", async () => {
    getCcrPresets.mockRejectedValue(new Error("no ccr"));
    await mount();
    expect(useCcrPresetsStore.getState().isInitialized).toBe(false);

    await act(async () => {
      emit?.({ agentId: "claude", presets: [{ id: "late", name: "Late" }] });
    });

    const state = useCcrPresetsStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.ccrPresetsByAgent.claude?.[0]?.id).toBe("late");
  });

  it("keeps an update event's empty array verbatim", async () => {
    getCcrPresets.mockResolvedValue([{ id: "zai", name: "Z.AI" }]);
    await mount();

    await act(async () => {
      emit?.({ agentId: "claude", presets: [] });
    });

    // Clearing an agent's CCR presets is real data, not an absence: the empty
    // array has to survive so it keeps replacing the registry bucket.
    expect(useCcrPresetsStore.getState().ccrPresetsByAgent.claude).toEqual([]);
  });
});
