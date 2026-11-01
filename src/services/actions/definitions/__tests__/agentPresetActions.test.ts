import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AgentSettings } from "@shared/types/agentSettings";
import { UnactionableTargetError } from "../../unactionableTarget";

const store = vi.hoisted(() => ({
  settings: null as AgentSettings | null,
  initialize: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
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

function definition(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, Object.create(null) as ActionCallbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

async function run(id: string, args: unknown): Promise<unknown> {
  const def = definition(id);
  const result = await def.run(args, { dispatchSource: "agent" } as ActionContext);
  // What dispatch returns: the run's answer parsed through its own schema.
  return def.resultSchema ? def.resultSchema.parse(result) : result;
}

describe("user-preset write runs (#16047)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.settings = {
      agents: {
        codex: {
          presetId: "user-work",
          customPresets: [{ id: "user-work", name: "Work", customFlags: "--search" }],
        },
      },
    } as AgentSettings;
  });

  it("creates through updateAgent with a fresh user id, leaving the default alone", async () => {
    const result = (await run("agent.createPreset", {
      agentId: "codex",
      name: "Personal",
      env: { CODEX_HOME: "/Users/me/.codex" },
    })) as { presetId: string; name: string };

    expect(store.initialize).toHaveBeenCalled();
    expect(result.presetId).toMatch(/^user-[0-9a-f-]{36}$/);
    expect(result.name).toBe("Personal");
    expect(store.updateAgent).toHaveBeenCalledTimes(1);
    expect(store.updateAgent).toHaveBeenCalledWith("codex", {
      customPresets: [
        { id: "user-work", name: "Work", customFlags: "--search" },
        { id: result.presetId, name: "Personal", env: { CODEX_HOME: "/Users/me/.codex" } },
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

  it("patches the stored preset as it stands at the write", async () => {
    await run("agent.updatePreset", { agentId: "codex", presetId: "user-work", customFlags: null });
    expect(store.updateAgent).toHaveBeenCalledWith("codex", {
      customPresets: [{ id: "user-work", name: "Work" }],
    });
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
