import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

vi.mock("../../plugin/PluginSkillRegistry.js", () => ({
  searchPluginSkills: vi.fn(() => []),
  loadPluginSkill: vi.fn(() => undefined),
}));

import { loadPluginSkill, searchPluginSkills } from "../../plugin/PluginSkillRegistry.js";
import { handleSkillsLoad, handleSkillsSearch } from "../skills.js";

const NO_PROJECT = { projectId: null };

describe("skills handler visibility (#13831)", () => {
  it("hands the session's visibility to the registry for both reads", () => {
    const visibility = { projectId: "a".repeat(64) };
    vi.mocked(searchPluginSkills).mockReturnValueOnce({ skills: [] });
    handleSkillsSearch({ query: "tdd", limit: 5 }, visibility);
    expect(searchPluginSkills).toHaveBeenLastCalledWith({ query: "tdd", limit: 5 }, visibility);

    vi.mocked(loadPluginSkill).mockReturnValueOnce({
      id: "acme.plugin.tdd",
      name: "TDD",
      description: null,
      body: "# TDD",
    });
    handleSkillsLoad({ id: " acme.plugin.tdd " }, visibility);
    expect(loadPluginSkill).toHaveBeenLastCalledWith("acme.plugin.tdd", visibility);
  });
});

describe("handleSkillsLoad unknown-id error", () => {
  it("does not reflect an unbounded id back to the caller", () => {
    // This message becomes a JSON-RPC error, which never passes through the
    // tools/call response budget — echoing the argument verbatim would let a
    // megabyte-long id produce a megabyte-long error (#11526).
    const id = "x".repeat(1_000_000);

    expect(() => handleSkillsLoad({ id }, NO_PROJECT)).toThrow(McpError);
    try {
      handleSkillsLoad({ id }, NO_PROJECT);
    } catch (err) {
      expect((err as McpError).message.length).toBeLessThan(1_000);
    }
  });

  it("still names a realistic id in full so the error stays actionable", () => {
    expect(() => handleSkillsLoad({ id: "acme.plugin.tdd" }, NO_PROJECT)).toThrow(
      /acme\.plugin\.tdd/
    );
  });
});
