// The issue's scenario, end to end through the real registry, command builder,
// snapshot and respawn builder: two panes of one plugin agent in one worktree,
// each coming back to its own session (#16470).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "@shared/config/pluginAgentRegistry";
import { generateAgentCommand, mintAssignedSessionId } from "@shared/types";
import type { PluginAgentContribution } from "@shared/types/plugin";
import { serializePtyPanel } from "@shared/utils/ptyPanelSnapshot";
import { buildArgsForRespawn } from "../statePatcher";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logDebug: vi.fn() }));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: vi.fn(() => ({ ccrPresetsByAgent: {} })) },
}));

type Saved = Parameters<typeof buildArgsForRespawn>[0];
type PiResume = NonNullable<PluginAgentContribution["resume"]>;

const AGENT_SETTINGS = { agents: {} } as Parameters<typeof buildArgsForRespawn>[3];

function register(resume: PiResume): void {
  registerPluginAgents("digitalfrontier.agents", [
    {
      id: "pi",
      name: "Pi",
      command: "pi",
      color: "#3366ff",
      iconId: "terminal",
      resume,
    },
  ]);
}

function launchPane(id: string) {
  const agentSessionId = mintAssignedSessionId("pi");
  return {
    id,
    title: "Pi",
    cwd: "/repo",
    kind: "terminal",
    launchAgentId: "pi",
    agentSessionId,
    command: generateAgentCommand("pi", {}, "pi", { sessionId: agentSessionId }),
  };
}

/** What the last save holds when the process goes away, however it went. */
function savedSnapshot(pane: ReturnType<typeof launchPane>): Saved {
  return { ...pane, ...serializePtyPanel(pane as Parameters<typeof serializePtyPanel>[0]) } as Saved;
}

function respawn(saved: Saved) {
  return buildArgsForRespawn(saved, "terminal", "/repo", AGENT_SETTINGS, false, undefined);
}

describe("two panes of one plugin agent in one worktree (#16470)", () => {
  beforeEach(() => {
    register({
      kind: "session-id",
      args: ["--session-id", "{sessionId}"],
      assignSessionIdArgs: ["--session-id", "{sessionId}"],
      quitCommand: "/quit",
      resumeLatestArgs: ["--continue"],
    });
  });

  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("launches each with its own id, on the command and the record", () => {
    const [left, right] = [launchPane("left"), launchPane("right")];

    expect(left.agentSessionId).toBeTruthy();
    expect(left.agentSessionId).not.toBe(right.agentSessionId);
    expect(left.command).toContain(left.agentSessionId);
    expect(right.command).toContain(right.agentSessionId);
    expect(left.command).not.toContain(right.agentSessionId);
  });

  it("restores each to its own session after an abrupt end, with no quit having run", () => {
    const [left, right] = [launchPane("left"), launchPane("right")];

    const restoredLeft = respawn(savedSnapshot(left));
    const restoredRight = respawn(savedSnapshot(right));

    expect(restoredLeft.command).toContain(left.agentSessionId);
    expect(restoredLeft.command).not.toContain(right.agentSessionId);
    expect(restoredRight.command).toContain(right.agentSessionId);
    expect(restoredRight.command).not.toContain(left.agentSessionId);
    expect(restoredLeft.agentSessionId).toBe(left.agentSessionId);
    expect(restoredRight.agentSessionId).toBe(right.agentSessionId);
    expect(restoredLeft.command).not.toContain("--continue");
    expect(restoredRight.command).not.toContain("--continue");
    expect(restoredLeft.sessionLostOnRestore).toBeUndefined();
    expect(restoredRight.sessionLostOnRestore).toBeUndefined();
  });

  it("restores each after a graceful exit, whose teardown hands back the same id", () => {
    const [left, right] = [launchPane("left"), launchPane("right")];
    // TerminalProcess.gracefulShutdown returns the assigned id unchanged, which
    // its own test pins; the renderer records it on the pane it came from.
    const afterTeardown = (pane: typeof left, handedBack: string | undefined) =>
      savedSnapshot({ ...pane, agentSessionId: handedBack });

    const restoredLeft = respawn(afterTeardown(left, left.agentSessionId));
    const restoredRight = respawn(afterTeardown(right, right.agentSessionId));

    expect(restoredLeft.agentSessionId).toBe(left.agentSessionId);
    expect(restoredRight.agentSessionId).toBe(right.agentSessionId);
    expect(restoredLeft.command).toContain(left.agentSessionId);
    expect(restoredRight.command).toContain(right.agentSessionId);
  });

  it("carries the same id across a second restore", () => {
    const pane = launchPane("left");

    const once = respawn(savedSnapshot(pane));
    const twice = respawn(
      savedSnapshot({
        ...pane,
        command: once.command,
        agentSessionId: once.agentSessionId,
      })
    );

    expect(twice.agentSessionId).toBe(pane.agentSessionId);
    expect(twice.command).toContain(pane.agentSessionId);
  });

  it("resumes through the plugin's own flag when it has one", () => {
    register({
      kind: "session-id",
      args: ["--session", "{sessionId}"],
      assignSessionIdArgs: ["--session-id", "{sessionId}"],
      quitCommand: "/quit",
      resumeLatestArgs: ["--continue"],
    });
    const pane = launchPane("left");

    const restored = respawn(savedSnapshot(pane));

    expect(restored.command).toMatch(/--session '?[0-9a-f-]{36}'?/);
    expect(restored.command).toContain(pane.agentSessionId);
    expect(restored.command).not.toContain("--session-id");
    expect(restored.agentSessionId).toBe(pane.agentSessionId);
  });

  it("restores a pane saved before the plugin declared assignment as it did then", () => {
    const saved = {
      id: "older",
      title: "Pi",
      cwd: "/repo",
      kind: "terminal",
      launchAgentId: "pi",
      command: "pi",
    } as Saved;

    const restored = respawn(saved);

    expect(restored.command).toBe("pi --continue");
    expect(restored.agentSessionId).toBeUndefined();
  });
});
