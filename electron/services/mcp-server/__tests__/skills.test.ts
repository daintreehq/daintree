import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

vi.mock("../../plugin/PluginSkillRegistry.js", () => ({
  searchPluginSkills: vi.fn(() => []),
  loadPluginSkill: vi.fn(() => undefined),
}));

import { handleSkillsLoad } from "../skills.js";

describe("handleSkillsLoad unknown-id error", () => {
  it("does not reflect an unbounded id back to the caller", () => {
    // This message becomes a JSON-RPC error, which never passes through the
    // tools/call response budget — echoing the argument verbatim would let a
    // megabyte-long id produce a megabyte-long error (#11526).
    const id = "x".repeat(1_000_000);

    expect(() => handleSkillsLoad({ id })).toThrow(McpError);
    try {
      handleSkillsLoad({ id });
    } catch (err) {
      expect((err as McpError).message.length).toBeLessThan(1_000);
    }
  });

  it("still names a realistic id in full so the error stays actionable", () => {
    expect(() => handleSkillsLoad({ id: "acme.plugin.tdd" })).toThrow(/acme\.plugin\.tdd/);
  });
});
