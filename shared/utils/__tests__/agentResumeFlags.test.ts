import { describe, expect, it } from "vitest";
import type { AgentSettings } from "../../types/agentSettings.js";
import { reconcileResumeLaunchFlagsWith } from "../agentResumeFlags.js";

const BYPASS = "--dangerously-skip-permissions";

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return { agents: {}, ...overrides } as AgentSettings;
}

describe("reconcileResumeLaunchFlagsWith", () => {
  it("drops a captured bypass flag the settings no longer resolve", () => {
    const flags = reconcileResumeLaunchFlagsWith(
      { agentId: "claude", agentLaunchFlags: ["--model", "opus", BYPASS] },
      settings({ globalSkipPermissions: false })
    );
    expect(flags).toContain("--model");
    expect(flags).toContain("opus");
    expect(flags).not.toContain(BYPASS);
  });

  it("adds the bypass flag a global switch turns on, even with nothing captured", () => {
    expect(
      reconcileResumeLaunchFlagsWith({ agentId: "claude" }, settings({ globalSkipPermissions: true }))
    ).toContain(BYPASS);
  });

  it("re-appends the caller's verbatim tail after the reconciled flags", () => {
    const flags = reconcileResumeLaunchFlagsWith(
      {
        agentId: "claude",
        agentLaunchFlags: [BYPASS, "--verbose"],
        callerLaunchFlags: ["--verbose"],
      },
      settings({ globalSkipPermissions: false })
    );
    expect(flags).not.toContain(BYPASS);
    expect(flags.at(-1)).toBe("--verbose");
  });

  it("reconciles with no settings at all", () => {
    expect(
      reconcileResumeLaunchFlagsWith({ agentId: "claude", agentLaunchFlags: ["--model", "opus"] }, null)
    ).toEqual(expect.arrayContaining(["--model", "opus"]));
  });
});
