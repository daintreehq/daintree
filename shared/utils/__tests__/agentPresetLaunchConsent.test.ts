import { describe, expect, it } from "vitest";
import type { AgentPreset } from "../../config/agentRegistry.js";
import {
  hostApprovalCoversPresetLaunch,
  pluginPresetLaunchRequest,
  presetLaunchContent,
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
    ["the inline mode", { inlineMode: "on" }],
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
  const approval = { agentId: "claude", presetId: "zai", content: "[]" };
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
