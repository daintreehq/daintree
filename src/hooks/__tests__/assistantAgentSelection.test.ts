import { describe, expect, it } from "vitest";
import { getAssistantSupportedAgentIds } from "@shared/config/agentRegistry";
import {
  resolveLaunchableAssistantAgentId,
  selectInstalledAssistantAgentIds,
} from "../assistantAgentSelection";

describe("selectInstalledAssistantAgentIds", () => {
  const supported = ["claude", "codex", "gemini"];

  it("returns nothing until availability has real data", () => {
    expect(selectInstalledAssistantAgentIds(supported, { claude: "ready" }, false)).toEqual([]);
  });

  it("keeps supported agents whose CLI is on disk, blocked and unauthenticated included", () => {
    expect(
      selectInstalledAssistantAgentIds(
        supported,
        { claude: "ready", codex: "blocked", gemini: "missing" },
        true
      )
    ).toEqual(["claude", "codex"]);
    expect(
      selectInstalledAssistantAgentIds(supported, { gemini: "unauthenticated" }, true)
    ).toEqual(["gemini"]);
  });

  it("ignores installed CLIs the assistant doesn't support", () => {
    expect(
      selectInstalledAssistantAgentIds(["claude"], { claude: "ready", codex: "ready" }, true)
    ).toEqual(["claude"]);
  });

  it("treats an agent with no availability entry as not installed", () => {
    expect(selectInstalledAssistantAgentIds(supported, {}, true)).toEqual([]);
  });
});

describe("resolveLaunchableAssistantAgentId", () => {
  it("prefers the saved agent over the installed set", () => {
    expect(resolveLaunchableAssistantAgentId("codex", ["claude"])).toBe("codex");
    expect(resolveLaunchableAssistantAgentId("codex", ["claude", "codex"])).toBe("codex");
    expect(resolveLaunchableAssistantAgentId("codex", [])).toBe("codex");
  });

  it("falls back to the only installed agent when nothing is saved", () => {
    expect(resolveLaunchableAssistantAgentId(null, ["claude"])).toBe("claude");
    expect(resolveLaunchableAssistantAgentId(null, ["codex"])).toBe("codex");
  });

  it("has no target with none or several installed and nothing saved", () => {
    expect(resolveLaunchableAssistantAgentId(null, [])).toBeNull();
    expect(resolveLaunchableAssistantAgentId(null, ["claude", "codex"])).toBeNull();
  });
});

describe("Antigravity against the real registry (#16815)", () => {
  it("is offered once agy is installed, and launches alone without asking", () => {
    const installed = selectInstalledAssistantAgentIds(
      getAssistantSupportedAgentIds(),
      { antigravity: "ready", copilot: "ready" },
      true
    );
    // Copilot is wired but experimental, so only Antigravity is a choice.
    expect(installed).toEqual(["antigravity"]);
    expect(resolveLaunchableAssistantAgentId(null, installed)).toBe("antigravity");

    const several = selectInstalledAssistantAgentIds(
      getAssistantSupportedAgentIds(),
      { antigravity: "ready", codex: "ready" },
      true
    );
    expect(resolveLaunchableAssistantAgentId(null, several)).toBeNull();
    expect(resolveLaunchableAssistantAgentId("antigravity", several)).toBe("antigravity");
  });
});
