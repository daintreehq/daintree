import { describe, it, expect } from "vitest";
import { resolveAgentIcon, AGENT_ICON_MAP } from "../agentIcons";

describe("agentIcons", () => {
  it("falls back for unknown iconId", () => {
    const fallback = resolveAgentIcon("nonexistent");
    expect(fallback).toBeDefined();
    expect(typeof fallback).toBe("function");
    expect(fallback).toBe(resolveAgentIcon("claude"));
  });

  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "treats the inherited key %s as an unknown iconId",
    (iconId) => {
      // `iconId` reaches here from plugin manifests; a bare index lookup would
      // return an `Object.prototype` member and render it as a component.
      expect(resolveAgentIcon(iconId)).toBe(resolveAgentIcon("claude"));
    }
  );

  it("AGENT_ICON_MAP contains all expected agent icons", () => {
    expect(AGENT_ICON_MAP["claude"]).toBeDefined();
    expect(AGENT_ICON_MAP["gemini"]).toBeDefined();
    expect(AGENT_ICON_MAP["antigravity"]).toBeDefined();
    expect(AGENT_ICON_MAP["codex"]).toBeDefined();
    expect(AGENT_ICON_MAP["opencode"]).toBeDefined();
    expect(AGENT_ICON_MAP["cursor"]).toBeDefined();
    expect(AGENT_ICON_MAP["kiro"]).toBeDefined();
    expect(AGENT_ICON_MAP["copilot"]).toBeDefined();
    expect(AGENT_ICON_MAP["goose"]).toBeDefined();
    expect(AGENT_ICON_MAP["crush"]).toBeDefined();
    expect(AGENT_ICON_MAP["qwen"]).toBeDefined();
    expect(AGENT_ICON_MAP["interpreter"]).toBeDefined();
    expect(AGENT_ICON_MAP["kimi"]).toBeDefined();
    expect(AGENT_ICON_MAP["amp"]).toBeDefined();
  });
});
