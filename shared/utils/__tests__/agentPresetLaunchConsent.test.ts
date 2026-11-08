import { describe, expect, it } from "vitest";
import type { AgentPreset } from "../../config/agentRegistry.js";
import {
  hostApprovalCoversPresetLaunch,
  pluginPresetLaunchRequest,
  presetLaunchContent,
  presetLaunchMatchesApproval,
  resolvePresetLaunchParts,
  type HostApprovedPluginPresetLaunch,
} from "../agentPresetLaunchConsent.js";

const preset: AgentPreset = {
  id: "zai",
  name: "Z.ai",
  args: ["--model", "glm"],
  env: { B_TOKEN: "b", A_URL: "a" },
  dangerousMode: "inherit",
  fallbacks: ["other"],
};

describe("presetLaunchContent", () => {
  it("does not depend on the order env keys were written in", () => {
    const reordered = { ...preset, env: { A_URL: "a", B_TOKEN: "b" } };
    expect(presetLaunchContent(reordered)).toBe(presetLaunchContent(preset));
  });

  it.each<[string, Partial<AgentPreset>]>([
    ["an env value", { env: { B_TOKEN: "changed", A_URL: "a" } }],
    ["an env name", { env: { B_TOKEN: "b", A_URL2: "a" } }],
    ["the argument order", { args: ["glm", "--model"] }],
    ["one argument split in two", { args: ["--model glm"] }],
    ["the bypass mode", { dangerousMode: "on" }],
    ["the legacy bypass switch", { dangerousEnabled: true }],
    ["the extra flags, even blank", { customFlags: "" }],
    ["the account pin", { accountId: "work" }],
    ["the fallback chain", { fallbacks: ["other", "third"] }],
    ["the rate-limit fallback switch", { fallbackOnRateLimit: true }],
    ["keeping the conversation", { keepConversationOnRateLimit: true }],
    ["the name", { name: "Z.ai (work)" }],
    ["the description", { description: "routes to Z.ai" }],
    ["the title", { displayTitle: "Z" }],
    ["the colour", { color: "#123456" }],
  ])("changes when %s changes", (_label, change) => {
    expect(presetLaunchContent({ ...preset, ...change })).not.toBe(presetLaunchContent(preset));
  });

  it("ignores keys the preset type doesn't define", () => {
    const withStray = { ...preset, stray: "ignored" } as AgentPreset;
    expect(presetLaunchContent(withStray)).toBe(presetLaunchContent(preset));
  });

  it("keeps the encoding a grant made while presets had a screen mode still matches (#16356)", () => {
    // What version 1 wrote for this preset, the retired inline mode's slot
    // included: a grant stored then must still match it.
    expect(presetLaunchContent(preset)).toBe(
      JSON.stringify([
        1,
        "zai",
        "Z.ai",
        null,
        ["--model", "glm"],
        [
          ["A_URL", "a"],
          ["B_TOKEN", "b"],
        ],
        null,
        "inherit",
        null,
        null,
        null,
        null,
        ["other"],
        null,
        null,
        null,
      ])
    );
    // A stored screen mode no longer reaches a launch, so it is no part of one.
    const withLegacyMode = { ...preset, inlineMode: "off" } as AgentPreset;
    expect(presetLaunchContent(withLegacyMode)).toBe(presetLaunchContent(preset));
  });
});

describe("pluginPresetLaunchRequest", () => {
  const base = { agentId: "claude", presetId: "zai", prompt: "hello" };

  it("accepts a launch that names a preset and gives a task", () => {
    expect(pluginPresetLaunchRequest("agent.launch", base)).toEqual({
      agentId: "claude",
      presetId: "zai",
    });
  });

  it("keeps the empty forms of the other options eligible, as the refusal does", () => {
    expect(
      pluginPresetLaunchRequest("agent.launch", {
        ...base,
        agentLaunchFlags: [],
        env: {},
        systemPrompt: "  ",
      })
    ).not.toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["presetId: null", { presetId: null }],
    ["an empty presetId", { presetId: "" }],
    ["no presetId", { presetId: undefined }],
    ["flags", { agentLaunchFlags: ["--yolo"] }],
    ["env", { env: { X: "1" } }],
    ["a system prompt", { systemPrompt: "be bold" }],
    ["an option-like prompt", { prompt: "--dangerously-skip-permissions" }],
    ["an option-like model", { model: "-x" }],
  ])("refuses %s", (_label, change) => {
    const args: Record<string, unknown> = { ...base, ...change };
    if (change.presetId === undefined && "presetId" in change) delete args.presetId;
    expect(pluginPresetLaunchRequest("agent.launch", args)).toBeNull();
  });

  it("is only ever about agent.launch", () => {
    expect(pluginPresetLaunchRequest("terminal.new", base)).toBeNull();
  });
});

describe("hostApprovalCoversPresetLaunch", () => {
  const approval: HostApprovedPluginPresetLaunch = {
    agentId: "claude",
    presetId: "zai",
    source: "custom",
    content: "[]",
    fallbacks: [],
  };
  const args = { agentId: "claude", presetId: "zai" };

  it("covers the launch it was made for", () => {
    expect(hostApprovalCoversPresetLaunch(approval, "agent.launch", args)).toBe(true);
  });

  it("covers no other preset, agent, or a launch that adds configuration", () => {
    expect(
      hostApprovalCoversPresetLaunch(approval, "agent.launch", { ...args, presetId: "other" })
    ).toBe(false);
    expect(
      hostApprovalCoversPresetLaunch(approval, "agent.launch", { ...args, agentId: "codex" })
    ).toBe(false);
    expect(
      hostApprovalCoversPresetLaunch(approval, "agent.launch", { ...args, env: { X: "1" } })
    ).toBe(false);
    expect(hostApprovalCoversPresetLaunch(undefined, "agent.launch", args)).toBe(false);
  });
});

describe("resolvePresetLaunchParts / presetLaunchMatchesApproval", () => {
  const other: AgentPreset = { id: "other", name: "Other", env: { WHO: "other" } };
  const approve = (custom?: AgentPreset[], project?: AgentPreset[]) => {
    const parts = resolvePresetLaunchParts("claude", "zai", custom, undefined, project)!;
    const approval: HostApprovedPluginPresetLaunch = {
      agentId: "claude",
      presetId: parts.preset.id,
      source: parts.source,
      content: parts.content,
      fallbacks: parts.fallbacks,
    };
    return { parts, approval };
  };

  it("names the layer that won and carries each fallback's content in chain order", () => {
    const { parts } = approve([preset, other]);
    expect(parts.source).toBe("custom");
    expect(parts.fallbacks.map(([id]) => id)).toEqual(["other"]);
    expect(parts.fallbacks[0]![1]).toBe(presetLaunchContent(parts.merged[1]!));
  });

  it("matches the same presets and nothing that changed", () => {
    const { approval } = approve([preset, other]);
    const again = resolvePresetLaunchParts("claude", "zai", [preset, other], undefined, undefined);
    expect(presetLaunchMatchesApproval(approval, again)).toBe(true);

    const editedFallback = resolvePresetLaunchParts(
      "claude",
      "zai",
      [preset, { ...other, env: { WHO: "someone else" } }],
      undefined,
      undefined
    );
    expect(presetLaunchMatchesApproval(approval, editedFallback)).toBe(false);
    expect(presetLaunchMatchesApproval(approval, undefined)).toBe(false);
  });

  it("does not let the same content from another source answer for the approved one", () => {
    const { approval } = approve([preset, other]);
    // The custom copy is gone; the repo holds identical presets.
    const fromRepo = resolvePresetLaunchParts("claude", "zai", [], undefined, [preset, other]);
    expect(fromRepo?.content).toBe(approval.content);
    expect(fromRepo?.source).toBe("project");
    expect(presetLaunchMatchesApproval(approval, fromRepo)).toBe(false);
  });
});
