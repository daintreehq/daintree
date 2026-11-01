import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AgentSettings } from "@shared/types/agentSettings";
import { UnactionableTargetError } from "../../unactionableTarget";
import { agentPresetMutationFingerprint, planAgentPresetMutation } from "../agentPresetMutation";

const store = vi.hoisted(() => ({
  settings: null as AgentSettings | null,
  initialize: vi.fn(async () => {}),
  updateAgent: vi.fn(async (_agentId: string, _updates: unknown) => {}),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: {
    getState: () => ({
      settings: store.settings,
      initialize: store.initialize,
      updateAgent: store.updateAgent,
    }),
  },
}));
vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: {}, isInitialized: true }) },
}));
vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: { getState: () => ({ presetsByAgent: {}, hydratedProjectId: null }) },
}));

import { registerAgentActions } from "../agentActions";

const WrittenSchema = z.object({ presetId: z.string(), name: z.string() });

function definition(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = Object.create(null);
  registerAgentActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

async function run(
  id: string,
  args: unknown,
  extra: Partial<ActionContext> = {}
): Promise<unknown> {
  const def = definition(id);
  const ctx: ActionContext = { dispatchSource: "agent", ...extra };
  const result = await def.run(args, ctx);
  // What dispatch returns: the run's answer parsed through its own schema.
  return def.resultSchema ? def.resultSchema.parse(result) : result;
}

function workSettings(customFlags: string): AgentSettings {
  return {
    agents: {
      codex: {
        presetId: "user-work",
        customPresets: [{ id: "user-work", name: "Work", customFlags, color: "#abc" }],
      },
    },
  };
}

describe("user-preset write runs (#16047)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.initialize.mockImplementation(async () => {});
    store.updateAgent.mockImplementation(async () => {});
    store.settings = workSettings("--search");
  });

  it("creates through updateAgent with a fresh user id, leaving the default alone", async () => {
    const args = { agentId: "codex", name: "Personal", env: { CODEX_HOME: "/Users/me/.codex" } };
    const first = WrittenSchema.parse(await run("agent.createPreset", args));
    const second = WrittenSchema.parse(await run("agent.createPreset", args));

    expect(first.presetId).toMatch(/^user-[0-9a-f-]{36}$/);
    expect(second.presetId).not.toBe(first.presetId);
    expect(first.name).toBe("Personal");
    expect(store.updateAgent).toHaveBeenNthCalledWith(1, "codex", {
      customPresets: [
        { id: "user-work", name: "Work", customFlags: "--search", color: "#abc" },
        { id: first.presetId, name: "Personal", env: { CODEX_HOME: "/Users/me/.codex" } },
      ],
    });
  });

  it("refuses without writing, as a non-retriable target refusal", async () => {
    await expect(
      run("agent.createPreset", { agentId: "codex", name: "Bad", args: ["a; b"] })
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(
      run("agent.updatePreset", { agentId: "codex", presetId: "user-gone", name: "x" })
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    expect(store.updateAgent).not.toHaveBeenCalled();
  });

  it("plans against the settings as they stand once loading finishes", async () => {
    store.settings = null;
    // Lands a turn later, so a run that didn't wait would plan against nothing.
    store.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            store.settings = workSettings("--latest");
            resolve();
          }, 0);
        })
    );
    await run("agent.updatePreset", { agentId: "codex", presetId: "user-work", color: "#def" });
    expect(store.updateAgent).toHaveBeenCalledWith("codex", {
      customPresets: [{ id: "user-work", name: "Work", customFlags: "--latest", color: "#def" }],
    });
  });

  it("refuses a preset removed while settings loaded, writing nothing", async () => {
    store.initialize.mockImplementation(async () => {
      store.settings = { agents: { codex: { customPresets: [] } } };
    });
    await expect(
      run("agent.updatePreset", { agentId: "codex", presetId: "user-work", color: "#def" })
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    expect(store.updateAgent).not.toHaveBeenCalled();
  });

  it("writes a dialog-approved change only while it still matches what was approved", async () => {
    const args = { agentId: "codex", presetId: "user-work", color: "#def" };
    const sources = {
      settings: store.settings,
      ccrPresetsByAgent: {},
      projectPresetsByAgent: undefined,
    };
    const shown = planAgentPresetMutation("agent.updatePreset", args, sources, "user-x");
    if (!shown.ok) throw new Error(shown.message);
    const approved = agentPresetMutationFingerprint(shown.mutation);

    await run("agent.updatePreset", args, { hostApprovedPresetWrite: approved });
    expect(store.updateAgent).toHaveBeenCalledTimes(1);

    // Another view edits the preset after the approval, before the write.
    store.updateAgent.mockClear();
    store.settings = workSettings("--edited");
    await expect(
      run("agent.updatePreset", args, { hostApprovedPresetWrite: approved })
    ).rejects.toThrow("changed after the user approved");
    expect(store.updateAgent).not.toHaveBeenCalled();
  });

  it("reports a failed save instead of a written preset", async () => {
    store.updateAgent.mockRejectedValue(new Error("disk full"));
    await expect(
      run("agent.updatePreset", { agentId: "codex", presetId: "user-work", customFlags: null })
    ).rejects.toThrow("disk full");
  });

  it("removes the default preset and says the default was cleared", async () => {
    const result = await run("agent.deletePreset", { agentId: "codex", presetId: "user-work" });
    expect(result).toEqual({ presetId: "user-work", name: "Work", agentDefaultCleared: true });
    expect(store.updateAgent).toHaveBeenCalledWith("codex", {
      customPresets: [],
      presetId: undefined,
    });
  });
});
