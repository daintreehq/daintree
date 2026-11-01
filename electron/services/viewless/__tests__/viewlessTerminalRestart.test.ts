import { describe, expect, it, vi } from "vitest";
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

    // Told once, before the kill (#15918).
    const beforeChange = vi.fn(() => expect(invoke).not.toHaveBeenCalled());
    await expect(
      restartTerminalWithoutView(PROJECT.id, "t1", deps, () => true, beforeChange)
    ).resolves.toBe("restarted");

    expect(beforeChange).toHaveBeenCalledTimes(1);
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
    expect(spawn.actionContext).toMatchObject({ projectId: PROJECT.id, focusedTerminalId: "t1" });
  });

  it("records the resumed session for the pane's next restore", async () => {
    const { deps, store } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude", agentSessionId: "old" },
      { agentState: "working" },
      "sess-123"
    );

    await restartTerminalWithoutView(PROJECT.id, "t1", deps);

    expect(store.read()?.terminals[0]?.agentSessionId).toBe("sess-123");
  });

  it("relaunches the saved command when no session was captured", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude --model opus" },
      { agentState: "working" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("restarted");
    expect(spawned(invoke).command).toBe("claude --model opus");
  });

  it("leaves a pane saved with a retired model for a view to restart (#15652)", async () => {
    const { deps, invoke } = setup(
      {
        id: "t1",
        launchAgentId: "copilot",
        command: "copilot --model claude-opus-4.6",
        agentModelId: "claude-opus-4.6",
        agentLaunchFlags: ["--model", "claude-opus-4.6"],
      },
      { agentState: "working", launchAgentId: "copilot" },
      "sess-123"
    );

    const beforeChange = vi.fn();
    await expect(
      restartTerminalWithoutView(PROJECT.id, "t1", deps, () => true, beforeChange)
    ).resolves.toBe("unsupported");
    expect(invoke).not.toHaveBeenCalled();
    // Nothing changed, so nothing is told (#15918).
    expect(beforeChange).not.toHaveBeenCalled();
  });

  it("leaves a pane holding a Vibe model a restart can't select for a view to restart (#15569)", async () => {
    const { deps, invoke } = setup(
      {
        id: "t1",
        launchAgentId: "mistral",
        title: "Mistral Vibe (Small)",
        command: "vibe --trust --model devstral-small",
        agentModelId: "devstral-small",
        agentLaunchFlags: ["--trust"],
      },
      { agentState: "working", launchAgentId: "mistral" },
      "sess-123"
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("unsupported");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("relaunches a Vibe pane that holds no model", async () => {
    const { deps, invoke } = setup(
      {
        id: "t1",
        launchAgentId: "mistral",
        command: "vibe --trust",
        agentLaunchFlags: ["--trust"],
      },
      { agentState: "working", launchAgentId: "mistral" },
      null
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("restarted");
    expect(spawned(invoke).command).toBe("vibe --trust");
  });

  it("relaunches a pane on a model Copilot still offers (#15652)", async () => {
    const { deps, invoke } = setup(
      {
        id: "t1",
        launchAgentId: "copilot",
        command: "copilot --model gpt-6.1-sol",
        agentModelId: "gpt-6.1-sol",
      },
      { agentState: "working", launchAgentId: "copilot" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("restarted");
    expect(spawned(invoke)).toMatchObject({
      command: "copilot --model gpt-6.1-sol",
      agentModelId: "gpt-6.1-sol",
    });
  });

  it("keeps the run's first prompt across a resume (#15521)", async () => {
    const firstPrompt = { text: "Fix the login bug", via: "send" as const, at: 5 };
    const { deps, invoke, store } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude", firstPrompt },
      { agentState: "working" },
      "sess-123"
    );

    await restartTerminalWithoutView(PROJECT.id, "t1", deps);

    expect(spawned(invoke).hasFirstPrompt).toBe(true);
    expect(store.read()?.terminals[0]?.firstPrompt).toEqual(firstPrompt);
  });

  it("drops a sent first prompt when the restart starts a new conversation (#15521)", async () => {
    const { deps, invoke, store } = setup(
      {
        id: "t1",
        launchAgentId: "claude",
        command: "claude",
        firstPrompt: { text: "Fix the login bug", via: "send", at: 5 },
      },
      { agentState: "working" }
    );

    await restartTerminalWithoutView(PROJECT.id, "t1", deps);

    // The new run offers its own first send instead.
    expect(spawned(invoke)).not.toHaveProperty("hasFirstPrompt");
    expect(store.read()?.terminals[0]).not.toHaveProperty("firstPrompt");
  });

  it.each([
    ["keeps it when the restart resumes that run", "sess-123", true],
    ["drops it when the restart starts a new conversation", null, false],
  ])(
    "for a first prompt the old run took while being stopped, %s (#15521)",
    async (_when, captured, kept) => {
      const firstPrompt = { text: "Fix the login bug", via: "send" as const, at: 5 };
      const { deps, invoke, store } = setup(
        { id: "t1", launchAgentId: "claude", command: "claude" },
        { agentState: "working" },
        captured
      );
      // Its Enter lands, and main saves the record, while the quit is under way.
      const quit = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (projectId, channel, args) => {
        if (channel === CHANNELS.TERMINAL_GRACEFUL_KILL) {
          await store.enqueueProjectStateUpdate(projectId, (state) => ({
            ...state!,
            terminals: state!.terminals.map((t) => ({ ...t, firstPrompt })),
          }));
        }
        return quit(projectId, channel, args);
      });

      await restartTerminalWithoutView(PROJECT.id, "t1", deps);

      expect(store.read()?.terminals[0]?.firstPrompt).toEqual(kept ? firstPrompt : undefined);
      // A kept record is the resumed run's, so none of its sends is offered.
      expect(spawned(invoke).hasFirstPrompt).toBe(kept ? true : undefined);
    }
  );

  it("keeps a launch prompt when the restart replays the command that carries it", async () => {
    const firstPrompt = { text: "Fix the login bug", via: "launch" as const, at: 5 };
    const { deps, invoke, store } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude 'Fix the login bug'", firstPrompt },
      { agentState: "working" }
    );

    await restartTerminalWithoutView(PROJECT.id, "t1", deps);

    expect(spawned(invoke).hasFirstPrompt).toBe(true);
    expect(store.read()?.terminals[0]?.firstPrompt).toEqual(firstPrompt);
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

  it("stops before the kill when the terminal was relaunched during its checks", async () => {
    const { deps, invoke } = setup({ id: "t2", command: "npm run dev" }, {});

    await expect(restartTerminalWithoutView(PROJECT.id, "t2", deps, () => false)).resolves.toBe(
      "stale"
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("doesn't respawn when the terminal was relaunched or the policy stopped during the kill", async () => {
    const { deps, invoke, store } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude", agentSessionId: "kept" },
      { agentState: "working" },
      "sess-123"
    );
    let current = true;
    const kill = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (projectId, channel, args) => {
      const answer = await kill(projectId, channel, args);
      if (channel === CHANNELS.TERMINAL_GRACEFUL_KILL) current = false;
      return answer;
    });

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps, () => current)).resolves.toBe(
      "stale"
    );
    expect(channels(invoke)).toEqual([CHANNELS.TERMINAL_GRACEFUL_KILL]);
    expect(store.read()?.terminals[0]?.agentSessionId).toBe("kept");
  });

  it("leaves an agent that already quit to its shell alone", async () => {
    const { deps, invoke } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude" },
      { agentState: "exited" }
    );

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("unsupported");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing for a live terminal the project's saved layout doesn't hold", async () => {
    const { deps, invoke } = setup({ id: "t1", command: "npm run dev" }, {});
    const pty = makePty({ t1: { projectId: PROJECT.id }, other: { projectId: PROJECT.id } });
    deps.getPtyReader = () => pty;

    await expect(restartTerminalWithoutView(PROJECT.id, "other", deps)).resolves.toBe("gone");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the captured session when the relaunch fails after the quit", async () => {
    const { deps, invoke, store } = setup(
      { id: "t1", launchAgentId: "claude", command: "claude", agentSessionId: "old" },
      { agentState: "working" },
      "sess-123"
    );
    const kill = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (projectId, channel, args) => {
      if (channel === CHANNELS.TERMINAL_SPAWN) {
        throw new Error("spawn failed");
      }
      return kill(projectId, channel, args);
    });

    await expect(restartTerminalWithoutView(PROJECT.id, "t1", deps)).resolves.toBe("failed");
    expect(channels(invoke)).toEqual([CHANNELS.TERMINAL_GRACEFUL_KILL, CHANNELS.TERMINAL_SPAWN]);
    const kept = store.read()?.terminals[0];
    expect(kept).toMatchObject({ id: "t1", launchAgentId: "claude", command: "claude" });
    expect(kept?.agentSessionId).toBe("sess-123");
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
