// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AgentPreset } from "@/config/agents";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types";
import type { PresetInventoryState } from "@shared/utils/agentPresets";
import { useStaleAgentPresetCleanup } from "../useStaleAgentPresetCleanup";

const updateAgent =
  vi.fn<(agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>>();
const onSettingsChange = vi.fn<() => void>();

const EMPTY: Record<string, AgentPreset[]> = {};

function settingsWith(presetId: string): AgentSettings {
  return { agents: { claude: { presetId } } };
}

function renderCleanup(presetId: string, presetInventory: PresetInventoryState) {
  const settings = settingsWith(presetId);
  return renderHook(
    ({ inventory, projectPresetsByAgent }) =>
      useStaleAgentPresetCleanup({
        agentId: "claude",
        settings,
        ccrPresetsByAgent: EMPTY,
        projectPresetsByAgent,
        presetInventory: inventory,
        updateAgent,
        onSettingsChange,
      }),
    { initialProps: { inventory: presetInventory, projectPresetsByAgent: EMPTY } }
  );
}

describe("useStaleAgentPresetCleanup (#15025)", () => {
  beforeEach(() => {
    updateAgent.mockReset().mockResolvedValue(undefined);
    onSettingsChange.mockReset();
  });

  it("keeps a pick the unread project presets could hold, then clears it once they load without it", async () => {
    const { rerender } = renderCleanup("team", { ccr: true, project: false });
    expect(updateAgent).not.toHaveBeenCalled();

    // Only the readiness flag moves: the empty map keeps its identity.
    rerender({ inventory: { ccr: true, project: true }, projectPresetsByAgent: EMPTY });
    await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledOnce());
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith("claude", { presetId: undefined });

    rerender({ inventory: { ccr: true, project: true }, projectPresetsByAgent: EMPTY });
    expect(updateAgent).toHaveBeenCalledOnce();
  });

  it("keeps a CCR pick until the routes have been read", async () => {
    const { rerender } = renderCleanup("ccr-opus", { ccr: false, project: true });
    expect(updateAgent).not.toHaveBeenCalled();

    rerender({ inventory: { ccr: true, project: true }, projectPresetsByAgent: EMPTY });
    await vi.waitFor(() =>
      expect(updateAgent).toHaveBeenCalledExactlyOnceWith("claude", { presetId: undefined })
    );
  });

  it("leaves a pick alone when its preset arrives with the load", () => {
    const { rerender } = renderCleanup("team", { ccr: true, project: false });

    rerender({
      inventory: { ccr: true, project: true },
      projectPresetsByAgent: { claude: [{ id: "team", name: "Team" }] },
    });

    expect(updateAgent).not.toHaveBeenCalled();
  });
});
