// The issue's scenario through the real launch plan, registry, snapshot and
// respawn builder: two panes of one plugin agent in one worktree, each coming
// back to its own session after an abrupt end (#16470). A graceful exit hands
// back the same id; TerminalProcess.gracefulShutdown's own test follows that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "@shared/config/pluginAgentRegistry";
import type { PluginAgentContribution } from "@shared/types/plugin";
import { buildAgentLaunchPlan } from "@shared/utils/agentLaunchPlan";
import { serializePtyPanel } from "@shared/utils/ptyPanelSnapshot";
import { buildArgsForRespawn } from "../statePatcher";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logDebug: vi.fn() }));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: vi.fn(() => ({ ccrPresetsByAgent: {} })) },
}));

type Saved = Parameters<typeof buildArgsForRespawn>[0];
type AgentSettingsArg = Parameters<typeof buildArgsForRespawn>[3];
type PiResume = NonNullable<PluginAgentContribution["resume"]>;

const AGENT_SETTINGS: AgentSettingsArg = { agents: {} };

function register(resume: PiResume): void {
  registerPluginAgents("digitalfrontier.agents", [
    { id: "pi", name: "Pi", command: "pi", color: "#3366ff", iconId: "terminal", resume },
  ]);
}

async function launchPane() {
  const plan = await buildAgentLaunchPlan({
    agentId: "pi",
    agentConfig: getEffectiveAgentConfig("pi"),
    isAgent: true,
    worktreeId: "/repo",
    settings: null,
    ccrPresets: undefined,
    projectPresets: undefined,
    presetInventory: { ccr: true, project: true },
    options: undefined,
    shellDialect: "posix",
    resolveBaseCommand: (command) => command,
    getCliDetail: async () => undefined,
    getClipboardDirectory: async () => "/tmp/daintree-clipboard",
  });
  return {
    launchAgentId: "pi",
    cwd: "/repo",
    command: plan.command,
    agentSessionId: plan.assignedSessionId,
  };
}

/** Only what the last save wrote: the process is gone, and nothing else remains. */
function lastSave(id: string, pane: Parameters<typeof serializePtyPanel>[0]): Saved {
  return { id, title: "Pi", kind: "terminal", ...serializePtyPanel(pane) };
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

  it("launches each with its own id, on the command and the record", async () => {
    const [left, right] = [await launchPane(), await launchPane()];

    expect(left.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(right.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(left.agentSessionId).not.toBe(right.agentSessionId);
    expect(left.command).toContain(left.agentSessionId);
    expect(right.command).toContain(right.agentSessionId);
  });

  it("saves each pane's id before anything has ended", async () => {
    const pane = await launchPane();

    const saved = lastSave("left", pane);

    expect(saved.agentSessionId).toBe(pane.agentSessionId);
    // The id is saved apart from the command, which a restore rebuilds.
    expect(saved.command).toBe("pi");
  });

  it("restores each to its own session after an abrupt end, with no quit having run", async () => {
    const [left, right] = [await launchPane(), await launchPane()];

    const restoredLeft = respawn(lastSave("left", left));
    const restoredRight = respawn(lastSave("right", right));

    expect(restoredLeft.command).toBe(`pi --session-id ${left.agentSessionId}`);
    expect(restoredRight.command).toBe(`pi --session-id ${right.agentSessionId}`);
    expect(restoredLeft.agentSessionId).toBe(left.agentSessionId);
    expect(restoredRight.agentSessionId).toBe(right.agentSessionId);
    expect(restoredLeft.sessionLostOnRestore).toBeUndefined();
    expect(restoredRight.sessionLostOnRestore).toBeUndefined();
  });

  it("keeps the same id across a second restore", async () => {
    const pane = await launchPane();

    const once = respawn(lastSave("left", pane));
    const twice = respawn(
      lastSave("left", {
        launchAgentId: "pi",
        cwd: "/repo",
        command: once.command,
        agentSessionId: once.agentSessionId,
      })
    );

    expect(twice.agentSessionId).toBe(pane.agentSessionId);
    expect(twice.command).toBe(once.command);
  });

  it("resumes through the plugin's own flag when it has one", async () => {
    register({
      kind: "session-id",
      args: ["--session", "{sessionId}"],
      assignSessionIdArgs: ["--session-id", "{sessionId}"],
      quitCommand: "/quit",
      resumeLatestArgs: ["--continue"],
    });
    const pane = await launchPane();

    const restored = respawn(lastSave("left", pane));

    expect(restored.command).toBe(`pi --session ${pane.agentSessionId}`);
    expect(restored.agentSessionId).toBe(pane.agentSessionId);
  });

  it("restores a pane saved before the plugin declared assignment as it did then", () => {
    const restored = respawn(
      lastSave("older", { launchAgentId: "pi", cwd: "/repo", command: "pi" })
    );

    expect(restored.command).toBe("pi --continue");
    expect(restored.agentSessionId).toBeUndefined();
  });
});
