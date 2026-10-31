import { describe, expect, it } from "vitest";
import { dropRetiredAgentModel } from "../agentSettings.js";

// Copilot declares `claude-opus-4.6` and `gpt-5.4` retired, and still offers
// `claude-sonnet-5.5`.
describe("dropRetiredAgentModel", () => {
  it("cleans every place a saved launch keeps a retired model", () => {
    const { launch, droppedModelIds } = dropRetiredAgentModel("copilot", {
      agentModelId: "claude-opus-4.6",
      agentLaunchFlags: ["--model", "claude-opus-4.6", "--allow-all-tools", "--model=gpt-5.4"],
      callerLaunchFlags: ["--model=gpt-5.4"],
      command: "copilot --model 'claude-opus-4.6' --allow-all-tools --model=gpt-5.4",
      title: "GitHub Copilot",
    });

    expect(launch).toEqual({
      agentModelId: undefined,
      agentLaunchFlags: ["--allow-all-tools"],
      callerLaunchFlags: undefined,
      command: "copilot --allow-all-tools",
      title: "GitHub Copilot",
    });
    expect(droppedModelIds).toEqual(["claude-opus-4.6", "gpt-5.4"]);
  });

  it("finds a retired model the launch saved only in its flags or command", () => {
    expect(
      dropRetiredAgentModel("copilot", { command: "copilot --model gpt-5.4 -i 'go'" })
    ).toEqual({ launch: { command: "copilot -i 'go'" }, droppedModelIds: ["gpt-5.4"] });
  });

  it("cleans the caller's own flags when only they carry it", () => {
    expect(
      dropRetiredAgentModel("copilot", { callerLaunchFlags: ["--model", "gpt-5.4", "--yolo"] })
    ).toEqual({ launch: { callerLaunchFlags: ["--yolo"] }, droppedModelIds: ["gpt-5.4"] });
  });

  it.each([
    [
      "an offered model",
      { agentModelId: "claude-sonnet-5.5", command: "copilot --model claude-sonnet-5.5" },
    ],
    [
      "a model the bundled list doesn't name",
      { agentModelId: "claude-sonnet-6", command: "copilot --model claude-sonnet-6" },
    ],
    ["no model", { agentLaunchFlags: ["--allow-all-tools"], command: "copilot" }],
  ])("leaves %s exactly as saved", (_label, saved) => {
    const result = dropRetiredAgentModel("copilot", saved);
    expect(result.launch).toBe(saved);
    expect(result.droppedModelIds).toEqual([]);
  });

  it("only drops what the launch's own agent retired", () => {
    const saved = { agentModelId: "claude-opus-4.6", command: "claude --model claude-opus-4.6" };
    expect(dropRetiredAgentModel("claude", saved).launch).toBe(saved);
    expect(dropRetiredAgentModel(undefined, saved).launch).toBe(saved);
  });

  it("never reaches into a quoted prompt or past --", () => {
    const saved = {
      command: "copilot -i 'switch to --model claude-opus-4.6 please'",
      agentLaunchFlags: ["--", "--model", "claude-opus-4.6"],
    };
    expect(dropRetiredAgentModel("copilot", saved).launch).toBe(saved);
  });

  it("is settled after one pass", () => {
    const once = dropRetiredAgentModel("copilot", {
      agentModelId: "gpt-5.4",
      agentLaunchFlags: ["--model", "gpt-5.4"],
    }).launch;
    const twice = dropRetiredAgentModel("copilot", once);
    expect(twice.launch).toBe(once);
    expect(twice.droppedModelIds).toEqual([]);
  });
});
