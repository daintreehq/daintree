import { describe, expect, it } from "vitest";
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
