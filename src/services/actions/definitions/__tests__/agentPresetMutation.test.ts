import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types/agentSettings";
import {
  agentPresetMutationUpdates,
  planAgentPresetMutation,
  type AgentPresetMutation,
  type AgentPresetSources,
} from "../agentPresetMutation";

const NEW_ID = "user-new";

function sources(
  entry: Partial<AgentSettingsEntry> | undefined,
  extra: Partial<AgentPresetSources> = {}
): AgentPresetSources {
  const settings = {
    agents: entry ? { codex: entry as AgentSettingsEntry } : {},
  } as AgentSettings;
  return { settings, ccrPresetsByAgent: {}, projectPresetsByAgent: undefined, ...extra };
}

function plan(
  actionId: "agent.createPreset" | "agent.updatePreset" | "agent.deletePreset",
  args: unknown,
  from: AgentPresetSources
): AgentPresetMutation {
  const result = planAgentPresetMutation(actionId, args, from, NEW_ID);
  if (!result.ok) throw new Error(`expected a plan, got: ${result.message}`);
  return result.mutation;
}

function refusal(
  actionId: "agent.createPreset" | "agent.updatePreset" | "agent.deletePreset",
  args: unknown,
  from: AgentPresetSources
): string {
  const result = planAgentPresetMutation(actionId, args, from, NEW_ID);
  if (result.ok) throw new Error("expected a refusal");
  return result.message;
}

const WORK: AgentPreset = {
  id: "user-work",
  name: "Work",
  env: { CODEX_HOME: "/Users/me/.codex-work", OPENAI_BASE_URL: "https://proxy.example" },
  customFlags: "--search",
  color: "#3b82f6",
};

describe("agent.createPreset", () => {
  it("appends the preset and never makes it the default", () => {
    const mutation = plan(
      "agent.createPreset",
      { agentId: "codex", name: "Personal", env: { CODEX_HOME: "/Users/me/.codex" } },
      sources({ customPresets: [WORK], presetId: WORK.id })
    );
    expect(mutation.operation).toBe("create");
    expect(mutation.customPresets).toEqual([
      WORK,
      { id: NEW_ID, name: "Personal", env: { CODEX_HOME: "/Users/me/.codex" } },
    ]);
    const updates = agentPresetMutationUpdates(mutation);
    expect(updates).toEqual({ customPresets: mutation.customPresets });
    expect("presetId" in updates).toBe(false);
  });

  it("mirrors a skip-permissions choice into the legacy flag, as Settings writes it", () => {
    const on = plan(
      "agent.createPreset",
      { agentId: "codex", name: "Yolo", dangerousMode: "on" },
      sources(undefined)
    );
    expect(on.preset).toMatchObject({ dangerousMode: "on", dangerousEnabled: true });
    const inherit = plan(
      "agent.createPreset",
      { agentId: "codex", name: "Plain", dangerousMode: "inherit", fallbackOnRateLimit: false },
      sources(undefined)
    );
    expect(inherit.preset).toEqual({ id: NEW_ID, name: "Plain" });
  });

  it("refuses every value the launch-time sanitiser would drop or change, naming each", () => {
    const message = refusal(
      "agent.createPreset",
      {
        agentId: "codex",
        name: " Padded ",
        env: { PATH: "/evil", SAFE: "ok", SHELL_IN: "a;b", "BAD-NAME": "x" },
        args: ["--ok", "rm -rf ~ | sh", ""],
        customFlags: "--a && --b",
        color: "blue",
        displayTitle: "<b>",
        fallbacks: ["user-a", "user-a"],
      },
      sources(undefined)
    );
    expect(message).toContain("name:");
    expect(message).toContain('env "PATH"');
    expect(message).toContain('env "SHELL_IN"');
    expect(message).toContain('env "BAD-NAME"');
    expect(message).not.toContain('env "SAFE"');
    expect(message).toContain("args[1]");
    expect(message).toContain("args[2]");
    expect(message).not.toContain("args[0]");
    expect(message).toContain("customFlags:");
    expect(message).toContain("color:");
    expect(message).toContain("displayTitle:");
    expect(message).toContain("fallbacks:");
    // A refused value can be a secret, so it is never echoed back.
    expect(message).not.toContain("/evil");
    expect(message).not.toContain("rm -rf");
  });

  it("refuses a fallback that names no preset of this agent", () => {
    const message = refusal(
      "agent.createPreset",
      { agentId: "codex", name: "Chain", fallbacks: [WORK.id, "user-gone"] },
      sources({ customPresets: [WORK] })
    );
    expect(message).toContain('"user-gone"');
    expect(message).not.toContain(`"${WORK.id}"`);
  });

  it("refuses an unknown field instead of dropping it", () => {
    const message = refusal(
      "agent.createPreset",
      { agentId: "codex", name: "Typo", customFlag: "--search" },
      sources(undefined)
    );
    expect(message).toContain("customFlag");
  });

  it("refuses an agent that isn't registered", () => {
    expect(
      refusal("agent.createPreset", { agentId: "terminal", name: "x" }, sources(undefined))
    ).toContain('"terminal"');
  });

  it("waits for settings rather than writing over ones it hasn't read", () => {
    const message = refusal(
      "agent.createPreset",
      { agentId: "codex", name: "Early" },
      { settings: null, ccrPresetsByAgent: {}, projectPresetsByAgent: undefined }
    );
    expect(message).toContain("haven't loaded");
  });
});

describe("agent.updatePreset", () => {
  it("changes only the named fields and env keys, keeping everything else", () => {
    const other: AgentPreset = { id: "user-other", name: "Other" };
    const mutation = plan(
      "agent.updatePreset",
      {
        agentId: "codex",
        presetId: WORK.id,
        name: "Work 2",
        envSet: { CODEX_HOME: "/Users/me/.codex-work-2", NEW_KEY: "1" },
        envUnset: ["OPENAI_BASE_URL"],
      },
      sources({ customPresets: [other, WORK] })
    );
    expect(mutation.operation).toBe("update");
    expect(mutation.customPresets).toEqual([
      other,
      {
        id: WORK.id,
        name: "Work 2",
        env: { CODEX_HOME: "/Users/me/.codex-work-2", NEW_KEY: "1" },
        customFlags: "--search",
        color: "#3b82f6",
      },
    ]);
  });

  it('clears with an empty value or "inherit", and customFlags: null', () => {
    const stored: AgentPreset = {
      ...WORK,
      args: ["--a"],
      dangerousMode: "on",
      dangerousEnabled: true,
      inlineMode: "off",
      displayTitle: "Work tab",
      fallbacks: ["user-other"],
      fallbackOnRateLimit: true,
    };
    const mutation = plan(
      "agent.updatePreset",
      {
        agentId: "codex",
        presetId: WORK.id,
        args: [],
        customFlags: null,
        dangerousMode: "inherit",
        inlineMode: "inherit",
        color: "",
        displayTitle: "",
        fallbacks: [],
        fallbackOnRateLimit: false,
        envUnset: ["CODEX_HOME", "OPENAI_BASE_URL"],
      },
      sources({ customPresets: [stored, { id: "user-other", name: "Other" }] })
    );
    expect(mutation.operation === "update" && mutation.preset).toEqual({
      id: WORK.id,
      name: "Work",
    });
  });

  it("keeps an empty customFlags as a real value: no flags instead of the agent's", () => {
    const mutation = plan(
      "agent.updatePreset",
      { agentId: "codex", presetId: WORK.id, customFlags: "" },
      sources({ customPresets: [WORK] })
    );
    expect(mutation.preset.customFlags).toBe("");
  });

  it("checks only what it touches, so a stored value it doesn't send isn't refused", () => {
    const legacy: AgentPreset = { ...WORK, customFlags: "--a; --b" };
    const mutation = plan(
      "agent.updatePreset",
      { agentId: "codex", presetId: WORK.id, name: "Renamed" },
      sources({ customPresets: [legacy] })
    );
    expect(mutation.preset).toMatchObject({ name: "Renamed", customFlags: "--a; --b" });
  });

  it("refuses a no-op, an empty patch, and a key both set and unset", () => {
    const from = sources({ customPresets: [WORK] });
    expect(
      refusal("agent.updatePreset", { agentId: "codex", presetId: WORK.id, name: "Work" }, from)
    ).toContain("already has these values");
    expect(refusal("agent.updatePreset", { agentId: "codex", presetId: WORK.id }, from)).toContain(
      "Nothing to change"
    );
    expect(
      refusal(
        "agent.updatePreset",
        {
          agentId: "codex",
          presetId: WORK.id,
          envSet: { CODEX_HOME: "/x" },
          envUnset: ["CODEX_HOME"],
        },
        from
      )
    ).toContain('"CODEX_HOME" is in both');
  });

  it("refuses a repository preset as read-only, and an id it doesn't know", () => {
    const project: AgentPreset = { id: "team", name: "Team proxy" };
    const from = sources(
      { customPresets: [WORK] },
      { projectPresetsByAgent: { codex: [project] } }
    );
    expect(
      refusal("agent.updatePreset", { agentId: "codex", presetId: "team", name: "Mine" }, from)
    ).toContain('"Team proxy" is a repository preset');
    expect(
      refusal("agent.updatePreset", { agentId: "codex", presetId: "user-nope", name: "x" }, from)
    ).toContain('no user preset "user-nope"');
  });

  it("refuses a sanitiser-dropped env value, without echoing it", () => {
    const message = refusal(
      "agent.updatePreset",
      { agentId: "codex", presetId: WORK.id, envSet: { LD_PRELOAD: "/tmp/x.so" } },
      sources({ customPresets: [WORK] })
    );
    expect(message).toContain('env "LD_PRELOAD"');
    expect(message).not.toContain("/tmp/x.so");
  });
});

describe("agent.deletePreset", () => {
  it("removes the preset and clears the agent default only when it named it", () => {
    const other: AgentPreset = { id: "user-other", name: "Other" };
    const asDefault = plan(
      "agent.deletePreset",
      { agentId: "codex", presetId: WORK.id },
      sources({
        customPresets: [WORK, other],
        presetId: WORK.id,
        worktreePresets: { wt1: WORK.id, wt2: other.id, wt3: WORK.id },
      })
    );
    expect(asDefault.customPresets).toEqual([other]);
    expect(asDefault.operation === "delete" && asDefault.worktreeDefaults).toBe(2);
    const updates = agentPresetMutationUpdates(asDefault);
    expect("presetId" in updates && updates.presetId === undefined).toBe(true);

    const notDefault = plan(
      "agent.deletePreset",
      { agentId: "codex", presetId: WORK.id },
      sources({ customPresets: [WORK, other], presetId: other.id })
    );
    expect("presetId" in agentPresetMutationUpdates(notDefault)).toBe(false);
  });

  it("refuses a CCR preset as read-only", () => {
    expect(
      refusal(
        "agent.deletePreset",
        { agentId: "codex", presetId: "ccr-route" },
        sources(undefined, { ccrPresetsByAgent: { codex: [{ id: "ccr-route", name: "Router" }] } })
      )
    ).toContain('"Router" is a CCR preset');
  });
});
