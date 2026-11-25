import { describe, expect, it } from "vitest";
import { launchChoiceForRecord } from "../sessionLaunchChoice.js";

describe("launchChoiceForRecord", () => {
  it("names the account and preset of the run Daintree launched", () => {
    expect(launchChoiceForRecord({ agentAccountId: "work", agentPresetId: "zai" })).toEqual({
      agentAccountId: "work",
      agentPresetId: "zai",
    });
    expect(launchChoiceForRecord({})).toEqual({});
  });

  it("names neither once another agent run has taken the terminal over", () => {
    expect(
      launchChoiceForRecord({ agentAccountId: "work", agentPresetId: "zai", agentIncarnation: 1 })
    ).toEqual({});
  });

  it("drops an id that isn't one", () => {
    expect(
      launchChoiceForRecord({ agentAccountId: "work/../x", agentPresetId: "", agentIncarnation: 0 })
    ).toEqual({});
    expect(launchChoiceForRecord({ agentAccountId: 7, agentPresetId: { id: "zai" } })).toEqual({});
  });
});
