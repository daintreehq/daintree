import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types/agentSettings";
import {
  agentPresetMutationFingerprint,
  agentPresetMutationUpdates,
  planAgentPresetMutation,
  type AgentPresetMutation,
  type AgentPresetSources,
} from "../agentPresetMutation";

const NEW_ID = "user-new";
const TOKEN = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

type PresetActionId = "agent.createPreset" | "agent.updatePreset" | "agent.deletePreset";

function sources(
  entry: AgentSettingsEntry | undefined,
  extra: Partial<AgentPresetSources> = {}
): AgentPresetSources {
  const settings: AgentSettings = { agents: entry ? { codex: entry } : {} };
  return { settings, ccrPresetsByAgent: {}, projectPresetsByAgent: undefined, ...extra };
}

function plan(actionId: PresetActionId, args: unknown, from: AgentPresetSources) {
  const result = planAgentPresetMutation(actionId, args, from, NEW_ID);
  if (!result.ok) throw new Error(`expected a plan, got: ${result.message}`);
  return result.mutation;
}

function refusal(actionId: PresetActionId, args: unknown, from: AgentPresetSources): string {
  const result = planAgentPresetMutation(actionId, args, from, NEW_ID);
  if (result.ok) throw new Error("expected a refusal");
  return result.message;
}

function updated(mutation: AgentPresetMutation): AgentPreset {
  if (mutation.operation !== "update")
    throw new Error(`expected an update, got ${mutation.operation}`);
  return mutation.preset;
}

const WORK: AgentPreset = {
  id: "user-work",
  name: "Work",
  env: { CODEX_HOME: "/Users/me/.codex-work", OPENAI_BASE_URL: "https://proxy.example" },
  customFlags: "--search",
  color: "#3b82f6",
};
const OTHER: AgentPreset = { id: "user-other", name: "Other" };

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

  it("stores every field Settings edits when each is valid", () => {
    const mutation = plan(
      "agent.createPreset",
      {
        agentId: "codex",
        name: "Full",
        env: { CODEX_HOME: "/x" },
        args: ["-c", "model_reasoning_effort=high"],
        customFlags: "--search",
        dangerousMode: "off",
        inlineMode: "on",
        color: "#abc",
        displayTitle: "Full tab",
        fallbacks: [WORK.id],
        fallbackOnRateLimit: true,
      },
      sources({ customPresets: [WORK] })
    );
    expect(mutation.preset).toEqual({
      id: NEW_ID,
      name: "Full",
      env: { CODEX_HOME: "/x" },
      args: ["-c", "model_reasoning_effort=high"],
      customFlags: "--search",
      // The legacy boolean mirrors the mode, as Settings' editor writes it.
      dangerousMode: "off",
      dangerousEnabled: false,
      inlineMode: "on",
      color: "#abc",
      displayTitle: "Full tab",
      fallbacks: [WORK.id],
      fallbackOnRateLimit: true,
    });
  });

  it("mirrors skip permissions on as true, and stores nothing for inherit or false", () => {
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
    // A refused value can be a secret, so it is never echoed back.
    expect(message).not.toContain("/evil");
    expect(message).not.toContain("rm -rf");
  });

  it("refuses a repeated fallback even when the preset it names exists", () => {
    const from = sources({ customPresets: [WORK, OTHER] });
    expect(
      refusal(
        "agent.createPreset",
        { agentId: "codex", name: "C", fallbacks: [WORK.id, WORK.id] },
        from
      )
    ).toContain("distinct preset ids");
    expect(
      plan(
        "agent.createPreset",
        { agentId: "codex", name: "C", fallbacks: [WORK.id, OTHER.id] },
        from
      ).preset.fallbacks
    ).toEqual([WORK.id, OTHER.id]);
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

  it("counts a repository preset as a fallback only when its snapshot is this project's", () => {
    const team: AgentPreset = { id: "team", name: "Team" };
    const args = { agentId: "codex", name: "Chain", fallbacks: ["team"] };
    expect(
      plan(
        "agent.createPreset",
        args,
        sources(undefined, { projectPresetsByAgent: { codex: [team] } })
      ).preset.fallbacks
    ).toEqual(["team"]);
    expect(refusal("agent.createPreset", args, sources(undefined))).toContain('"team"');
  });

  it("refuses a `__proto__` env key, which the schema parse would otherwise drop", () => {
    const args: unknown = JSON.parse(
      '{"agentId":"codex","name":"P","env":{"__proto__":"x","SAFE":"ok"}}'
    );
    expect(refusal("agent.createPreset", args, sources(undefined))).toContain('env "__proto__"');
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
    const stored: AgentPreset = {
      ...WORK,
      env: { ...WORK.env, OPENAI_API_KEY: TOKEN, KEEP: "same" },
    };
    const snapshot = structuredClone(stored);
    const mutation = plan(
      "agent.updatePreset",
      {
        agentId: "codex",
        presetId: WORK.id,
        name: "Work 2",
        envSet: { CODEX_HOME: "/Users/me/.codex-work-2", NEW_KEY: "1" },
        envUnset: ["OPENAI_BASE_URL"],
      },
      sources({ customPresets: [OTHER, stored] })
    );
    expect(mutation.customPresets).toEqual([
      OTHER,
      {
        id: WORK.id,
        name: "Work 2",
        env: {
          CODEX_HOME: "/Users/me/.codex-work-2",
          OPENAI_API_KEY: TOKEN,
          KEEP: "same",
          NEW_KEY: "1",
        },
        customFlags: "--search",
        color: "#3b82f6",
      },
    ]);
    expect(stored).toEqual(snapshot);
  });

  it('clears with an empty value or "inherit", and customFlags: null', () => {
    const stored: AgentPreset = {
      ...WORK,
      args: ["--a"],
      dangerousMode: "on",
      dangerousEnabled: true,
      inlineMode: "off",
      displayTitle: "Work tab",
      fallbacks: [OTHER.id],
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
      sources({ customPresets: [stored, OTHER] })
    );
    expect(updated(mutation)).toEqual({ id: WORK.id, name: "Work" });
  });

  it("keeps an empty customFlags as a real value: no flags instead of the agent's", () => {
    const mutation = plan(
      "agent.updatePreset",
      { agentId: "codex", presetId: WORK.id, customFlags: "" },
      sources({ customPresets: [WORK] })
    );
    expect(updated(mutation).customFlags).toBe("");
  });

  it("checks only what it touches, so a stored value it doesn't send isn't refused", () => {
    const legacy: AgentPreset = { ...WORK, customFlags: "--a; --b" };
    const mutation = plan(
      "agent.updatePreset",
      { agentId: "codex", presetId: WORK.id, name: "Renamed" },
      sources({ customPresets: [legacy] })
    );
    expect(updated(mutation)).toMatchObject({ name: "Renamed", customFlags: "--a; --b" });
  });

  it("asks for a name when the stored one is missing, and accepts the repair", () => {
    const nameless: AgentPreset = JSON.parse('{"id":"user-a"}');
    const from = sources({ customPresets: [nameless] });
    expect(
      refusal("agent.updatePreset", { agentId: "codex", presetId: "user-a", color: "#abc" }, from)
    ).toContain("set a new one in the same call");
    expect(
      updated(
        plan(
          "agent.updatePreset",
          { agentId: "codex", presetId: "user-a", color: "#abc", name: "Named" },
          from
        )
      )
    ).toEqual({ id: "user-a", name: "Named", color: "#abc" });
  });

  it("refuses a fallback that names the preset itself", () => {
    expect(
      refusal(
        "agent.updatePreset",
        { agentId: "codex", presetId: WORK.id, fallbacks: [WORK.id] },
        sources({ customPresets: [WORK, OTHER] })
      )
    ).toContain("not this preset's own");
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

  it("refuses an id several stored presets share, rather than guess which launches", () => {
    const shadowed: AgentPreset = { id: WORK.id, name: "", env: { OPENAI_BASE_URL: "https://x" } };
    expect(
      refusal(
        "agent.updatePreset",
        { agentId: "codex", presetId: WORK.id, name: "Renamed" },
        sources({ customPresets: [shadowed, WORK] })
      )
    ).toContain(`2 user presets with the id "${WORK.id}"`);
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
    const asDefault = plan(
      "agent.deletePreset",
      { agentId: "codex", presetId: WORK.id },
      sources({
        customPresets: [WORK, OTHER],
        presetId: WORK.id,
        worktreePresets: { wt1: WORK.id, wt2: OTHER.id, wt3: WORK.id },
      })
    );
    expect(asDefault.customPresets).toEqual([OTHER]);
    expect(asDefault.operation === "delete" && asDefault.worktreeDefaults).toBe(2);
    const updates = agentPresetMutationUpdates(asDefault);
    expect("presetId" in updates && updates.presetId === undefined).toBe(true);

    const notDefault = plan(
      "agent.deletePreset",
      { agentId: "codex", presetId: WORK.id },
      sources({ customPresets: [WORK, OTHER], presetId: OTHER.id })
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

describe("agentPresetMutationFingerprint", () => {
  it("tells apart what an approval covers, ignoring a create's id and the rest of the list", () => {
    const args = { agentId: "codex", presetId: WORK.id };
    const shown = plan("agent.deletePreset", args, sources({ customPresets: [WORK] }));
    const siblingAdded = plan(
      "agent.deletePreset",
      args,
      sources({ customPresets: [WORK, OTHER] })
    );
    const madeDefault = plan(
      "agent.deletePreset",
      args,
      sources({ customPresets: [WORK], presetId: WORK.id })
    );
    const edited = plan(
      "agent.deletePreset",
      args,
      sources({ customPresets: [{ ...WORK, customFlags: "--other" }] })
    );
    const print = agentPresetMutationFingerprint;
    expect(print(siblingAdded)).toBe(print(shown));
    expect(print(madeDefault)).not.toBe(print(shown));
    expect(print(edited)).not.toBe(print(shown));

    const createArgs = { agentId: "codex", name: "New" };
    const first = planAgentPresetMutation(
      "agent.createPreset",
      createArgs,
      sources(undefined),
      "user-1"
    );
    const second = planAgentPresetMutation(
      "agent.createPreset",
      createArgs,
      sources(undefined),
      "user-2"
    );
    if (!first.ok || !second.ok) throw new Error("expected plans");
    expect(print(first.mutation)).toBe(print(second.mutation));
  });
});
