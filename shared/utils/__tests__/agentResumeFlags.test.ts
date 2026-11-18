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

  it("swaps a captured bypass flag for the Auto args an agent's Auto setting asks for (#17435)", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        {
          agentId: "codex",
          agentLaunchFlags: ["--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox"],
        },
        settings({
          globalSkipPermissions: true,
          agents: { codex: { dangerousMode: "auto" } },
        })
      )
    ).toEqual(["--no-alt-screen", "--approve-for-me", "-c", "tui.whimsy=false"]);
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "claude", agentLaunchFlags: ["--permission-mode", "auto", "--model", "opus"] },
        settings({ agents: { claude: { dangerousMode: "off" } } })
      )
    ).toEqual(["--model", "opus"]);
  });

  it("keeps Auto args the agent's own custom flags carry when the setting is off", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "codex", agentLaunchFlags: ["--no-alt-screen", "--approve-for-me"] },
        settings({ agents: { codex: { dangerousMode: "off", customFlags: "--approve-for-me" } } })
      )
    ).toEqual(["--no-alt-screen", "--approve-for-me", "-c", "tui.whimsy=false"]);
  });

  it("resumes on the session's own preset, so its Auto beats the agent's Skip all", () => {
    const flags = ["--no-alt-screen", "--approve-for-me"];
    const all = settings({ agents: { codex: { dangerousMode: "on" } } });
    expect(
      reconcileResumeLaunchFlagsWith({ agentId: "codex", agentLaunchFlags: flags }, all, {
        id: "reviewed",
        name: "Reviewed",
        dangerousMode: "auto",
      })
    ).toEqual([...flags, "-c", "tui.whimsy=false"]);
    // With no preset to read, the agent's own Skip all wins, as before.
    expect(
      reconcileResumeLaunchFlagsWith({ agentId: "codex", agentLaunchFlags: flags }, all)
    ).toEqual([
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "tui.whimsy=false",
    ]);
  });

  it("keeps the captured permission args when the session's preset can't be read", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        { agentId: "codex", agentLaunchFlags: ["--no-alt-screen", "--approve-for-me"] },
        settings({ agents: { codex: { dangerousMode: "on" } } }),
        null
      )
    ).toEqual(["--no-alt-screen", "--approve-for-me", "-c", "tui.whimsy=false"]);
  });

  it("adds no Auto copy beside one the caller's tail carries", () => {
    expect(
      reconcileResumeLaunchFlagsWith(
        {
          agentId: "codex",
          agentLaunchFlags: ["--no-alt-screen", "--approve-for-me"],
          callerLaunchFlags: ["--approve-for-me"],
        },
        settings({ agents: { codex: { dangerousMode: "auto" } } })
      )
    ).toEqual(["--no-alt-screen", "-c", "tui.whimsy=false", "--approve-for-me"]);
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
