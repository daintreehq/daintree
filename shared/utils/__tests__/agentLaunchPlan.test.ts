import { describe, expect, it, vi } from "vitest";
import { getEffectiveAgentConfig } from "../../config/agentRegistry.js";
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

  it("falls back to the agent default when the worktree's pick is gone, and reports the stale slot", async () => {
    const plan = await buildAgentLaunchPlan(
      input({
        settings: settingsWith({
          presetId: "global",
          worktreePresets: { "/repo-wt/a": "deleted" },
          customPresets: PRESETS,
        }),
      })
    );

    expect(plan.preset?.id).toBe("global");
    expect(plan.stalePresetScope).toBe("worktree");
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
