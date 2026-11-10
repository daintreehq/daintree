import { describe, expect, it } from "vitest";
import type { AgentSettings } from "../../types/agentSettings.js";
import { reconcileResumeLaunchFlagsWith } from "../agentResumeFlags.js";

const BYPASS = "--dangerously-skip-permissions";

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return { agents: {}, ...overrides } as AgentSettings;
}

describe("reconcileResumeLaunchFlagsWith", () => {
  it("resumes inline whatever alt-screen choice an older build saved (#16356)", () => {
    const saved = { agents: { grok: { inlineMode: "off" } }, globalUseAltScreen: true };
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "grok", agentLaunchFlags: ["--model", "grok-build", "--fullscreen"] },
        settings(saved as Partial<AgentSettings>)
      )
    ).toEqual(["--model", "grok-build", "--no-alt-screen"]);
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "codex" },
        settings(saved as Partial<AgentSettings>)
      )
    ).toContain("--no-alt-screen");
  });

  it("drops a captured bypass flag the settings no longer resolve", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "claude", agentLaunchFlags: ["--model", "opus", BYPASS] },
        settings({ globalSkipPermissions: false })
      )
    ).toEqual(["--model", "opus"]);
  });

  it("adds the bypass flag a global switch turns on, even with nothing captured", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "claude" },
        settings({ globalSkipPermissions: true })
      )
    ).toEqual([BYPASS]);
  });

  it("keeps the caller's verbatim tail, even a flag reconcile would drop, once and last", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        {
          agentId: "claude",
          agentLaunchFlags: ["--model", "opus", BYPASS, BYPASS],
          callerLaunchFlags: [BYPASS],
        },
        settings({ globalSkipPermissions: false })
      )
    ).toEqual(["--model", "opus", BYPASS]);
  });

  it("strips a plugin agent's recorded bypass flag with its declaration absent (#16374)", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "hermes", agentLaunchFlags: ["--yolo", "--fast"] },
        settings({
          globalSkipPermissions: true,
          agents: { hermes: { dangerousMode: "off" } },
          pluginBypassArgHistory: { hermes: [["--yolo"]] },
        })
      )
    ).toEqual(["--fast"]);
  });

  it("reconciles with no settings at all, adding nothing", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "claude", agentLaunchFlags: ["--model", "opus"] },
        null
      )
    ).toEqual(["--model", "opus"]);
  });
});
