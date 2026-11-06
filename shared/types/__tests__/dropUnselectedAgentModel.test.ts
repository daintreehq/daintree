import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchCommandFromFlags,
  buildResumeCommand,
  buildResumeLatestCommand,
  dropUnselectedAgentModel,
} from "../agentSettings.js";

// Mistral Vibe takes `--model` only on a new headless run (#15569); Claude takes
// it on every launch.
const original = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: original, configurable: true });
});

describe("dropUnselectedAgentModel", () => {
  it("cleans a pane rebuilt interactive from one saved with a Vibe model, title included", () => {
    const rebuilt = {
      agentModelId: "devstral-small",
      agentLaunchFlags: ["--trust", "--model", "devstral-small"],
      callerLaunchFlags: ["--model=devstral-2"],
      command: "vibe --trust",
      title: "Mistral Vibe (Small)",
    };

    expect(dropUnselectedAgentModel("mistral", rebuilt)).toEqual({
      agentModelId: undefined,
      agentLaunchFlags: ["--trust"],
      callerLaunchFlags: undefined,
      command: "vibe --trust",
      title: "Mistral Vibe",
    });
  });

  it("takes the model out of the command too when the launch is a replay", () => {
    const saved = {
      agentModelId: "devstral-small",
      command: "vibe --trust --model 'devstral-small' 'use --model x'",
    };

    expect(dropUnselectedAgentModel("mistral", saved, { replay: true })).toEqual({
      agentModelId: undefined,
      command: "vibe --trust 'use --model x'",
    });
  });

  it("keeps a fresh headless launch's model, which its command selects", () => {
    const fresh = {
      agentModelId: "devstral-small",
      agentLaunchFlags: ["--trust"],
      command: "vibe --trust --model devstral-small --prompt 'Fix the bug'",
      title: "Mistral Vibe (Small)",
    };

    expect(dropUnselectedAgentModel("mistral", fresh)).toBe(fresh);
  });

  it("strips a headless launch's model from flags it would replay, keeping the command's", () => {
    const fresh = {
      agentModelId: "devstral-small",
      callerLaunchFlags: ["--model", "devstral-small"],
      command: "vibe --trust --model devstral-small --prompt 'Fix the bug'",
    };

    expect(dropUnselectedAgentModel("mistral", fresh)).toEqual({
      agentModelId: "devstral-small",
      callerLaunchFlags: undefined,
      command: "vibe --trust --model devstral-small --prompt 'Fix the bug'",
    });
  });

  it.each(["custom", "user"])(
    "leaves a %s title, even one spelling the generated form",
    (titleMode) => {
      const named = {
        agentModelId: "devstral-small",
        command: "vibe --trust",
        title: "Mistral Vibe (Small)",
        titleMode,
      };

      expect(dropUnselectedAgentModel("mistral", named)).toEqual({
        ...named,
        agentModelId: undefined,
      });
    }
  );

  it("resets a generated title decorated after the model, as a duplicate's is", () => {
    const copy = {
      agentModelId: "devstral-small",
      command: "vibe --trust",
      title: "Mistral Vibe (Small) (copy)",
      titleMode: "default",
    };

    expect(dropUnselectedAgentModel("mistral", copy).title).toBe("Mistral Vibe (copy)");
  });

  it("clears a model the command doesn't pass, even when it passes another", () => {
    const launch = {
      agentModelId: "devstral-small",
      command: "vibe --trust --model devstral-2 --prompt 'say --model devstral-small'",
    };

    expect(dropUnselectedAgentModel("mistral", launch).agentModelId).toBeUndefined();
  });

  it("reads a quoted id the command passes as the same model", () => {
    const launch = {
      agentModelId: "devstral-small",
      command: "vibe --trust --model 'devstral-small' --prompt 'Fix the bug'",
    };

    expect(dropUnselectedAgentModel("mistral", launch)).toBe(launch);
  });

  it("leaves agents that take a model on every launch exactly as saved", () => {
    const saved = {
      agentModelId: "opus",
      agentLaunchFlags: ["--model", "opus"],
      command: "claude",
    };

    expect(dropUnselectedAgentModel("claude", saved, { replay: true })).toBe(saved);
    expect(dropUnselectedAgentModel(undefined, saved, { replay: true })).toBe(saved);
  });

  it("returns the same object when a Vibe launch holds no model", () => {
    const saved = { agentLaunchFlags: ["--trust"], command: "vibe --trust" };
    expect(dropUnselectedAgentModel("mistral", saved, { replay: true })).toBe(saved);
  });
});

describe("replaying flags saved with a Vibe model (#15569)", () => {
  const saved = ["--trust", "--model", "devstral-small", "--agent", "accept-edits"];

  it("resumes without it, which Vibe would refuse", () => {
    expect(buildResumeCommand("mistral", "abc-123", saved)).toBe(
      "vibe --trust --agent 'accept-edits' --resume abc-123"
    );
    expect(buildResumeLatestCommand("mistral", saved)).toBe(
      "vibe --trust --agent 'accept-edits' --continue"
    );
  });

  it("starts over without it, which an interactive session ignores or rejects", () => {
    expect(buildLaunchCommandFromFlags("vibe", "mistral", saved)).toBe(
      "vibe --trust --agent 'accept-edits'"
    );
  });

  it("drops a --model saved with no value, without swallowing the -- that follows", () => {
    expect(buildResumeCommand("mistral", "s-1", ["--trust", "--model"])).toBe(
      "vibe --trust --resume s-1"
    );
    expect(buildLaunchCommandFromFlags("vibe", "mistral", ["--model", "--", "--model=local"])).toBe(
      "vibe -- --model=local"
    );
  });

  it("keeps other agents' saved model", () => {
    expect(buildLaunchCommandFromFlags("claude", "claude", ["--model", "opus"])).toBe(
      "claude --model 'opus'"
    );
  });
});
