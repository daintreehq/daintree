import { describe, expect, it } from "vitest";
import { launchChoiceForRecord } from "../sessionLaunchChoice.js";

describe("launchChoiceForRecord", () => {
  it("names the account and preset of the run Daintree launched", () => {
    expect(
      launchChoiceForRecord({ agentAccountId: "work", agentPresetId: "zai", agentIncarnation: 0 })
    ).toEqual({ agentAccountId: "work", agentPresetId: "zai" });
    expect(launchChoiceForRecord({ agentAccountId: "work", agentPresetId: "zai" })).toEqual({
      agentAccountId: "work",
      agentPresetId: "zai",
    });
    expect(launchChoiceForRecord({})).toEqual({});
  });

  it("names neither for a later run started by hand in the shell", () => {
    expect(
      launchChoiceForRecord({
        agentAccountId: "work",
        agentPresetId: "zai",
        agentIncarnation: 1,
        launchAgentId: "claude",
        detectedAgentId: "claude",
      })
    ).toEqual({});
  });

  it("names no account while another CLI is the one detected in the terminal", () => {
    expect(
      launchChoiceForRecord({
        agentAccountId: "work",
        agentPresetId: "zai",
        launchAgentId: "claude",
        detectedAgentId: "codex",
      })
    ).toEqual({ agentPresetId: "zai" });
  });

  it("drops an id that isn't one", () => {
    expect(
      launchChoiceForRecord({ agentAccountId: "work/../x", agentPresetId: "", agentIncarnation: 0 })
    ).toEqual({});
    expect(launchChoiceForRecord({ agentPresetId: "line\nbreak" })).toEqual({});
    expect(launchChoiceForRecord({ agentPresetId: "x".repeat(101) })).toEqual({});
    expect(launchChoiceForRecord({ agentAccountId: 7, agentPresetId: { id: "zai" } })).toEqual({});
  });
});
