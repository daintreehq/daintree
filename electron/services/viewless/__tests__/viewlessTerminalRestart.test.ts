import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { ProjectState, TerminalSnapshot } from "../../../../shared/types/project.js";
import type { ViewlessTerminalRecord } from "../ViewlessActionExecutor.js";
import { restartTerminalWithoutView } from "../viewlessTerminalRestart.js";
import { makeDeps, makePty, PROJECT } from "./viewlessTestDeps.js";

function stateWith(terminal: Partial<TerminalSnapshot> & { id: string }): ProjectState {
  return {
    projectId: PROJECT.id,
    sidebarWidth: 300,
    terminals: [
      { title: "Agent", location: "grid", cwd: "/repo", ...terminal } as TerminalSnapshot,
    ],
    terminalSizes: { [terminal.id]: { cols: 120, rows: 40 } },
  };
}

function setup(
  terminal: Partial<TerminalSnapshot> & { id: string },
  record: ViewlessTerminalRecord,
  killAnswer: string | null = null
) {
  const pty = makePty({ [terminal.id]: { projectId: PROJECT.id, cwd: "/repo", ...record } });
  const made = makeDeps({ getPtyReader: () => pty }, { state: stateWith(terminal) });
  made.invoke.mockImplementation(async (_projectId, channel, args) => {
    if (channel === CHANNELS.TERMINAL_GRACEFUL_KILL) return killAnswer;
    if (channel === CHANNELS.TERMINAL_SPAWN) return (args[0] as { id: string }).id;
    return undefined;
  });
  return made;
}

function channels(invoke: ReturnType<typeof makeDeps>["invoke"]): string[] {
  return invoke.mock.calls.map(([, channel]) => channel);
}

function spawned(invoke: ReturnType<typeof makeDeps>["invoke"]): Record<string, unknown> {
  const call = invoke.mock.calls.find(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN);
  if (!call) throw new Error("nothing was spawned");
  return call[2][0] as Record<string, unknown>;
}

describe("restartTerminalWithoutView", () => {
  it("quits an agent gracefully and relaunches the same id resuming its captured session", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude", agentLaunchFlags: [] },
      { agentState: "working", launchAgentId: "claude" },
      "sess-123"
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("restarted");

    expect(channels(invoke)).toEqual([CHANNELS.TERMINAL_GRACEFUL_KILL, CHANNELS.TERMINAL_SPAWN]);
    expect(invoke.mock.calls[0]?.[2]).toEqual(["t1", { forRestart: true }]);
    const spawn = spawned(invoke);
    expect(spawn).toMatchObject({
      id: "t1",
      projectId: PROJECT.id,
      cwd: "/repo",
      cols: 120,
      rows: 40,
      launchAgentId: "claude",
    });
    expect(String(spawn.command)).toContain("sess-123");
  });

  it("relaunches the saved command when no session was captured", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude --model opus" },
      { agentState: "working" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("restarted");
    expect(spawned(invoke).command).toBe("claude --model opus");
  });

  it("kills and respawns a plain terminal with its command", async () => {
    const { deps, invoke } = setup({ id: "t2", title: "Dev", command: "npm run dev" }, {});

    await expect(restartTerminalWithoutView(PROJECT.id, "t2", deps)).resolves.toBe("restarted");
    expect(channels(invoke)).toEqual([CHANNELS.TERMINAL_KILL, CHANNELS.TERMINAL_SPAWN]);
    expect(spawned(invoke)).toMatchObject({ id: "t2", command: "npm run dev" });
    expect(spawned(invoke)).not.toHaveProperty("launchAgentId");
  });

  it("leaves a terminal waiting for input alone", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude" },
      { agentState: "waiting" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("waiting");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves a terminal locked against input alone", async () => {
    const { deps, invoke } = setup(
      { id: "t1", command: "npm run dev", isInputLocked: true } as Partial<TerminalSnapshot> & {
        id: string;
      },
      {}
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("input-locked");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves an agent that already quit to its shell alone", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude" },
      { agentState: "exited" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("unsupported");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing for a terminal the project's saved layout doesn't hold", async () => {
    const { deps, invoke } = setup({ id: "t1", command: "npm run dev" }, {});

    await expect(restartTerminalWithoutView(PROJECT.id, "other", deps)).resolves.toBe("gone");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("doesn't spawn when the terminal couldn't be stopped", async () => {
    const { deps, invoke } = setup({ id: "t2", command: "npm run dev" }, {});
    invoke.mockImplementation(async (_projectId, channel) => {
      if (channel === CHANNELS.TERMINAL_KILL) throw new Error("host gone");
      return undefined;
    });

    await expect(restartTerminalWithoutView(PROJECT.id, "t2", deps)).resolves.toBe("failed");
    expect(channels(invoke)).toEqual([CHANNELS.TERMINAL_KILL]);
  });
});
