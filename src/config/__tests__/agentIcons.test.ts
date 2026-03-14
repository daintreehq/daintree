import { describe, it, expect } from "vitest";
import { resolveAgentIcon, AGENT_ICON_MAP } from "../agentIcons";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry";

describe("agentIcons", () => {
  it("resolves all built-in agent iconIds", () => {
    for (const config of Object.values(AGENT_REGISTRY)) {
      const icon = resolveAgentIcon(config.iconId);
      expect(icon).toBeDefined();
      expect(typeof icon).toBe("function");
    }
  });

  it("falls back for unknown iconId", () => {
    const fallback = resolveAgentIcon("nonexistent");
    expect(fallback).toBeDefined();
    expect(typeof fallback).toBe("function");
    expect(fallback).toBe(resolveAgentIcon("claude"));
  });

  it("AGENT_ICON_MAP contains all expected agent icons", () => {
    expect(AGENT_ICON_MAP["claude"]).toBeDefined();
    expect(AGENT_ICON_MAP["gemini"]).toBeDefined();
    expect(AGENT_ICON_MAP["codex"]).toBeDefined();
    expect(AGENT_ICON_MAP["opencode"]).toBeDefined();
    expect(AGENT_ICON_MAP["cursor"]).toBeDefined();
  });

  it("normalizes icon filenames to lowercase iconIds", () => {
    for (const key of Object.keys(AGENT_ICON_MAP)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
