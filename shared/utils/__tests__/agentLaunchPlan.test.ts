import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffectiveAgentConfig, setUserRegistry } from "../../config/agentRegistry.js";
import type { AgentSettings } from "../../types/agentSettings.js";
import { buildAgentLaunchPlan, type AgentLaunchPlanInput } from "../agentLaunchPlan.js";

function input(overrides: Partial<AgentLaunchPlanInput> = {}): AgentLaunchPlanInput {
  return {
    agentId: "claude",
    agentConfig: getEffectiveAgentConfig("claude"),
    isAgent: true,
    worktreeId: "/repo-wt/a",
    settings: null,
    ccrPresets: undefined,
    projectPresets: undefined,
    presetInventory: { ccr: true, project: true },
    options: undefined,
    shellDialect: "posix",
    resolveBaseCommand: (command) => command,
    getCliDetail: async () => undefined,
    getClipboardDirectory: async () => "/tmp/daintree-clipboard",
    ...overrides,
  };
}

function settingsWith(entry: Record<string, unknown>): AgentSettings {
  return { agents: { claude: entry } } as unknown as AgentSettings;
}

const PRESETS = [
  { id: "global", name: "Global", env: { WHO: "global" } },
  { id: "scoped", name: "Scoped", env: { WHO: "scoped" } },
];

describe("buildAgentLaunchPlan", () => {
  it("prefers the worktree's saved preset over the agent default", async () => {
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({
          presetId: "global",
          worktreePresets: { "/repo-wt/a": "scoped" },
          customPresets: PRESETS,
        }),
      })
    );

    expect(plan.preset?.id).toBe("scoped");
    expect(plan.env).toEqual({ WHO: "scoped" });
    expect(plan.title).toBe("Claude [Scoped]");
    expect(plan.titleMode).toBe("custom");
  });

  it("falls back to the agent default when the worktree's pick is gone, and reports the stale slot first", async () => {
    const events: string[] = [];
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({
          presetId: "global",
          worktreePresets: { "/repo-wt/a": "deleted" },
          customPresets: PRESETS,
        }),
        onStalePreset: (scope) => events.push(`stale:${scope}`),
        getCliDetail: async () => {
          events.push("probe");
          return undefined;
        },
      })
    );

    expect(plan.preset?.id).toBe("global");
    // Cleared before the probe's await, so a selection made meanwhile survives.
    expect(events).toEqual(["stale:worktree", "probe"]);
  });

  it("reports a stale agent-level default", async () => {
    const onStalePreset = vi.fn();
    await buildAgentLaunchPlan(
      input({
        settings: settingsWith({ presetId: "deleted", customPresets: PRESETS }),
        onStalePreset,
      })
    );

    expect(onStalePreset).toHaveBeenCalledExactlyOnceWith("agent");
  });

  describe("a preset whose inventory hasn't loaded (#15025)", () => {
    const TEAM = { id: "team", name: "Team", env: { WHO: "team" } };

    it("refuses before any fallback, cleanup or probe while the project's presets are unread", async () => {
      const onStalePreset = vi.fn();
      const getCliDetail = vi.fn(async () => undefined);
      const plan = await buildAgentLaunchPlan(
        input({
          settings: settingsWith({
            presetId: "global",
            worktreePresets: { "/repo-wt/a": "team" },
            customPresets: PRESETS,
          }),
          presetInventory: { ccr: true, project: false },
          onStalePreset,
          getCliDetail,
        })
      );

      expect(plan.unloadedPresetId).toBe("team");
      expect(plan.command).toBeUndefined();
      expect(plan.preset).toBeUndefined();
      expect(onStalePreset).not.toHaveBeenCalled();
      expect(getCliDetail).not.toHaveBeenCalled();
    });

    it("resolves the same pick once the project's presets arrive", async () => {
      const plan = await buildAgentLaunchPlan(
        input({
          settings: settingsWith({ worktreePresets: { "/repo-wt/a": "team" } }),
          projectPresets: [TEAM],
          presetInventory: { ccr: true, project: false },
        })
      );

      expect(plan.unloadedPresetId).toBeUndefined();
      expect(plan.preset?.id).toBe("team");
      expect(plan.env).toEqual({ WHO: "team" });
    });

    it("holds an explicitly requested id the unread inventory might still hold", async () => {
      const plan = await buildAgentLaunchPlan(
        input({ options: { presetId: "team" }, presetInventory: { ccr: true, project: false } })
      );

      expect(plan.unloadedPresetId).toBe("team");
    });

    it("waits on unread CCR routes only for a CCR id", async () => {
      const onStalePreset = vi.fn();
      const unread = { ccr: false, project: true };
      const ccrPick = await buildAgentLaunchPlan(
        input({ settings: settingsWith({ presetId: "ccr-opus" }), presetInventory: unread })
      );
      const customPick = await buildAgentLaunchPlan(
        input({
          settings: settingsWith({ presetId: "user-gone", customPresets: PRESETS }),
          presetInventory: unread,
          onStalePreset,
        })
      );

      expect(ccrPick.unloadedPresetId).toBe("ccr-opus");
      expect(customPick.unloadedPresetId).toBeUndefined();
      expect(onStalePreset).toHaveBeenCalledExactlyOnceWith("agent");
    });

    it("holds a stale worktree pick whose agent-default fallback is still unread", async () => {
      const onStalePreset = vi.fn();
      const plan = await buildAgentLaunchPlan(
        input({
          settings: settingsWith({
            presetId: "ccr-opus",
            worktreePresets: { "/repo-wt/a": "user-gone" },
          }),
          presetInventory: { ccr: false, project: true },
          onStalePreset,
        })
      );

      expect(plan.unloadedPresetId).toBe("ccr-opus");
      expect(onStalePreset).not.toHaveBeenCalled();
    });

    it("never holds a launch that asks for no preset", async () => {
      const plan = await buildAgentLaunchPlan(
        input({
          settings: settingsWith({ presetId: "team" }),
          options: { presetId: null },
          presetInventory: { ccr: false, project: false },
        })
      );

      expect(plan.unloadedPresetId).toBeUndefined();
      expect(plan.command).toBeDefined();
    });
  });

  it("launches the bare agent for an explicit null, ignoring every saved pick", async () => {
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({ presetId: "global", customPresets: PRESETS }),
        options: { presetId: null },
      })
    );

    expect(plan.preset).toBeUndefined();
    expect(plan.title).toBe("Claude");
    expect(plan.titleMode).toBeUndefined();
  });

  it("launches the bare agent from a worktree saved as null while other worktrees inherit (#15054)", async () => {
    const onStalePreset = vi.fn();
    const settings = settingsWith({
      presetId: "global",
      worktreePresets: { "/repo-wt/a": null },
      customPresets: PRESETS,
    });

    const bare = await buildAgentLaunchPlan(input({ settings, onStalePreset }));
    expect(bare.preset).toBeUndefined();
    expect(bare.env).toBeUndefined();
    expect(bare.title).toBe("Claude");
    // A deliberate bare pick is not a vanished preset.
    expect(onStalePreset).not.toHaveBeenCalled();

    const inheriting = await buildAgentLaunchPlan(
      input({ settings, worktreeId: "/repo-wt/b", onStalePreset })
    );
    expect(inheriting.preset?.id).toBe("global");
  });

  describe("with a registry default preset", () => {
    const AGENT_ID = "registry-default-agent";
    afterEach(() => setUserRegistry({}));

    it("keeps the registry default out of a worktree saved as null", async () => {
      const config = {
        ...getEffectiveAgentConfig("claude")!,
        id: AGENT_ID,
        name: "Registry Agent",
        presets: [{ id: "registry", name: "Registry", env: { WHO: "registry" } }],
        defaultPresetId: "registry",
      };
      setUserRegistry({ [AGENT_ID]: config });
      const launch = (worktreeId: string) =>
        buildAgentLaunchPlan(
          input({
            agentId: AGENT_ID,
            agentConfig: config,
            worktreeId,
            settings: {
              agents: { [AGENT_ID]: { worktreePresets: { "/repo-wt/a": null } } },
            },
          })
        );

      // An inheriting worktree with nothing saved gets the registry default...
      expect((await launch("/repo-wt/b")).preset?.id).toBe("registry");
      // ...and the worktree that chose the bare agent does not.
      const bare = await launch("/repo-wt/a");
      expect(bare.preset).toBeUndefined();
      expect(bare.env).toBeUndefined();
    });
  });

  it("lets an explicitly named preset override a worktree saved as null", async () => {
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({
          presetId: "global",
          worktreePresets: { "/repo-wt/a": null },
          customPresets: PRESETS,
        }),
        options: { presetId: "scoped" },
      })
    );

    expect(plan.preset?.id).toBe("scoped");
  });

  it("layers the caller's environment over the agent's and the preset's", async () => {
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({
          presetId: "global",
          customPresets: PRESETS,
          globalEnv: { BASE: "1", WHO: "agent" },
        }),
        options: { env: { WHO: "caller" } },
      })
    );

    expect(plan.env).toEqual({ BASE: "1", WHO: "caller" });
  });

  it("appends the caller's flags last, and records them apart for resume", async () => {
    const plan = await buildAgentLaunchPlan(
      input({ options: { agentLaunchFlags: ["--model", "opus"] } })
    );

    expect(plan.command?.endsWith("--model opus")).toBe(true);
    expect(plan.launchFlags?.slice(-2)).toEqual(["--model", "opus"]);
    expect(plan.callerLaunchFlags).toEqual(["--model", "opus"]);
  });

  it("mints a fresh session id per launch and runs the command it was resolved to", async () => {
    const resolveBaseCommand = vi.fn(() => "'/opt/claude'");
    const first = await buildAgentLaunchPlan(input({ resolveBaseCommand }));
    const second = await buildAgentLaunchPlan(input({ resolveBaseCommand }));

    expect(first.command?.startsWith("'/opt/claude'")).toBe(true);
    expect(first.assignedSessionId).toEqual(expect.any(String));
    expect(first.assignedSessionId).not.toBe(second.assignedSessionId);
  });

  it("pins a caller's name as the title, with control characters stripped", async () => {
    const plan = await buildAgentLaunchPlan(input({ options: { name: "Claude:\n tests\x1b" } }));

    expect(plan.title).toBe("Claude: tests");
    expect(plan.titleMode).toBe("custom");
  });

  it("plans nothing to run for a plain terminal", async () => {
    const plan = await buildAgentLaunchPlan(
      input({ agentId: "terminal", agentConfig: undefined, isAgent: false })
    );

    expect(plan.command).toBeUndefined();
    expect(plan.assignedSessionId).toBeUndefined();
    expect(plan.title).toBe("Terminal");
  });
});
