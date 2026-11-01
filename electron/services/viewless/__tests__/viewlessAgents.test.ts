import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { AgentSettings } from "../../../../shared/types/agentSettings.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { runAgentLaunch } from "../viewlessAgents.js";
import {
  makeDeps,
  makeHosts,
  makePty,
  makeWorktree,
  PROJECT,
  request,
} from "./viewlessTestDeps.js";

const WORKTREE = makeWorktree({
  id: "/repo-wt/feature",
  worktreeId: "/repo-wt/feature",
  path: "/repo-wt/feature",
  branch: "feature",
  isMainWorktree: false,
  isCurrent: false,
});

function launchDeps(overrides: Parameters<typeof makeDeps>[0] = {}) {
  return makeDeps(
    { getPtyReader: () => makePty(), getWorkspaceHosts: () => makeHosts(), ...overrides },
    { worktrees: [makeWorktree(), WORKTREE] }
  );
}

type SpawnPayload = Record<string, unknown> & { id: string; command?: string };

function spawned(invoke: ReturnType<typeof makeDeps>["invoke"]): SpawnPayload {
  const call = invoke.mock.calls.find(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN);
  if (!call) throw new Error("nothing was spawned");
  return call[2][0] as SpawnPayload;
}

describe("agent.launch with no frontend", () => {
  it("spawns the agent in the named worktree and records it as a view would", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", {
        agentId: "claude",
        worktreeId: "/repo-wt/feature",
        prompt: "Run the tests",
        name: "Claude: tests",
      }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        launched: true,
        location: "grid",
        spawnStatus: null,
        worktreeId: "/repo-wt/feature",
        worktreePath: "/repo-wt/feature",
        branch: "feature",
        cwd: "/repo-wt/feature",
        cwdOutsideWorktree: false,
      },
    });
    const payload = spawned(invoke);
    const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
    expect(payload).toMatchObject({
      id: terminalId,
      kind: "terminal",
      projectId: PROJECT.id,
      cwd: "/repo-wt/feature",
      launchAgentId: "claude",
      worktreeId: "/repo-wt/feature",
      title: "Claude: tests",
      titleMode: "custom",
    });
    expect(payload.command).toContain("claude");
    expect(payload.agentSessionId).toEqual(expect.any(String));
    // Claude's MCP session replays the pane's own launch context.
    expect(payload.actionContext).toMatchObject({
      projectId: PROJECT.id,
      activeWorktreeId: "/repo-wt/feature",
      focusedTerminalId: terminalId,
    });

    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === terminalId);
    expect(snapshot).toMatchObject({
      kind: "terminal",
      launchAgentId: "claude",
      title: "Claude: tests",
      titleMode: "custom",
      worktreeId: "/repo-wt/feature",
      location: "grid",
      cwd: "/repo-wt/feature",
      agentSessionId: payload.agentSessionId,
      spawnedBy: "mcp",
    });
    // The one-use session id never rides a persisted command.
    expect(snapshot?.command ?? "").not.toContain(String(payload.agentSessionId));
    // Detected state is observed later, never invented at launch.
    expect(snapshot).not.toHaveProperty("agentState");
  });

  it("resolves the user's saved preset as a view's launcher does", async () => {
    const settings = {
      agents: {
        claude: {
          presetId: "zai",
          customPresets: [
            {
              id: "zai",
              name: "Z.ai",
              env: { ANTHROPIC_BASE_URL: "https://z.example" },
              color: "#123456",
            },
          ],
        },
      },
    } as unknown as AgentSettings;
    const { deps, invoke, store } = launchDeps();
    deps.agents.getSettings = async () => settings;

    await executeViewlessAction(request("agent.launch", { agentId: "claude" }), deps);

    const payload = spawned(invoke);
    expect(payload).toMatchObject({
      title: "Claude [Z.ai]",
      titleMode: "custom",
      agentPresetId: "zai",
      agentPresetColor: "#123456",
      env: { ANTHROPIC_BASE_URL: "https://z.example" },
    });
    expect(store.read()?.terminals[0]).toMatchObject({
      agentPresetId: "zai",
      originalPresetId: "zai",
      env: { ANTHROPIC_BASE_URL: "https://z.example" },
    });
  });

  it("refuses rather than launch without a saved preset whose project presets failed to read (#15025)", async () => {
    const settings = {
      agents: { claude: { presetId: "team", customPresets: [{ id: "zai", name: "Z.ai" }] } },
    } as unknown as AgentSettings;
    const { deps, invoke, store } = launchDeps();
    deps.agents.getSettings = async () => settings;
    deps.agents.getProjectPresets = async () => {
      throw new Error("EACCES");
    };

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { launched: false, spawnStatus: "presets-loading", terminalId: null },
    });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(
      false
    );
    expect(store.read()?.terminals ?? []).toEqual([]);
  });

  it("refuses a saved CCR route when the routes failed to read, but not a pick CCR could never hold", async () => {
    const failCcr = (presetId: string) => {
      const { deps, invoke } = launchDeps();
      deps.agents.getSettings = async () =>
        ({ agents: { claude: { presetId } } }) as unknown as AgentSettings;
      deps.agents.getCcrPresets = async () => {
        throw new Error("EACCES");
      };
      return { deps, invoke };
    };
    const route = failCcr("ccr-opus");
    const gone = failCcr("user-gone");

    const routeResult = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      route.deps
    );
    const goneResult = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      gone.deps
    );

    expect(routeResult).toMatchObject({
      result: { launched: false, spawnStatus: "presets-loading" },
    });
    expect(goneResult).toMatchObject({ result: { launched: true, spawnStatus: null } });
    expect(spawned(gone.invoke).title).toBe("Claude");
  });

  it("launches a custom preset even when the project's presets failed to read", async () => {
    const { deps, invoke } = launchDeps();
    deps.agents.getSettings = async () =>
      ({
        agents: { claude: { presetId: "zai", customPresets: [{ id: "zai", name: "Z.ai" }] } },
      }) as unknown as AgentSettings;
    deps.agents.getProjectPresets = async () => {
      throw new Error("EACCES");
    };

    await executeViewlessAction(request("agent.launch", { agentId: "claude" }), deps);

    expect(spawned(invoke)).toMatchObject({ agentPresetId: "zai" });
  });

  it("launches against the bare agent when asked for no preset", async () => {
    const settings = {
      agents: { claude: { presetId: "zai", customPresets: [{ id: "zai", name: "Z.ai" }] } },
    } as unknown as AgentSettings;
    const { deps, invoke } = launchDeps();
    deps.agents.getSettings = async () => settings;

    await executeViewlessAction(
      request("agent.launch", { agentId: "claude", presetId: null }),
      deps
    );

    expect(spawned(invoke)).not.toHaveProperty("agentPresetId", "zai");
    expect(spawned(invoke).title).toBe("Claude");
  });

  it("files under the layout's active worktree when none is named", async () => {
    const { deps, invoke } = makeDeps(
      { getPtyReader: () => makePty(), getWorkspaceHosts: () => makeHosts() },
      {
        worktrees: [makeWorktree(), WORKTREE],
        state: {
          projectId: PROJECT.id,
          sidebarWidth: 350,
          terminals: [],
          activeWorktreeId: WORKTREE.id,
        },
      }
    );

    await executeViewlessAction(request("agent.launch", { agentId: "claude" }), deps);

    expect(spawned(invoke)).toMatchObject({ worktreeId: WORKTREE.id, cwd: WORKTREE.path });
  });

  it("reports a CLI that cannot launch, and starts nothing", async () => {
    const { deps, invoke, store } = launchDeps();
    deps.agents.getCliDetail = async () => ({ state: "missing" }) as never;

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { launched: false, spawnStatus: "missing-cli", terminalId: null },
    });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(
      false
    );
    expect(store.read()).toBeNull();
  });

  it("holds the launch to the hard panel limit a fresh view would apply", async () => {
    const records: Record<string, Record<string, unknown>> = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [`t-${i}`, { kind: "terminal" }])
    );
    const { deps, invoke } = launchDeps({ getPtyReader: () => makePty(records) });
    deps.hostPlatform = { ...deps.hostPlatform, totalMemoryBytes: 8 * 1024 ** 3 };

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        launched: false,
        spawnStatus: "panel-limit",
        panelLimit: { count: 24, tier: "hard" },
      },
    });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(
      false
    );
  });

  it("counts what a view counts: not the assistant's terminal, not a saved panel twice", async () => {
    const records: Record<string, Record<string, unknown>> = Object.fromEntries(
      Array.from({ length: 23 }, (_, i) => [`t-${i}`, { kind: "terminal" }])
    );
    records["t-help"] = { kind: "terminal", isAssistantTerminal: true };
    const { deps, invoke } = makeDeps(
      { getPtyReader: () => makePty(records), getWorkspaceHosts: () => makeHosts() },
      {
        worktrees: [makeWorktree(), WORKTREE],
        state: {
          projectId: PROJECT.id,
          sidebarWidth: 350,
          terminals: [{ id: "t-0", kind: "terminal", title: "Saved", location: "grid" }],
        },
      }
    );
    deps.hostPlatform = { ...deps.hostPlatform, totalMemoryBytes: 8 * 1024 ** 3 };

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      deps
    );

    expect(result).toMatchObject({ ok: true, result: { launched: true } });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(true);
  });

  it("launches past what the host's RAM once allowed, with no host limit in the answer (#14810)", async () => {
    const records: Record<string, Record<string, unknown>> = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `t-${i}`,
        { kind: "terminal", launchAgentId: "claude" },
      ])
    );
    const { deps, invoke } = launchDeps({ getPtyReader: () => makePty(records) });
    deps.hostPlatform = { ...deps.hostPlatform, totalMemoryBytes: 8 * 1024 ** 3 };
    // The dependency the ceiling was read through, full: a check restored here
    // would decline the launch on it.
    const readHostAgentLimit = vi.fn(() => ({ host: "Studio", count: 12, limit: 2 }));
    Object.assign(deps, { readHostAgentLimit });

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude" }),
      deps
    );

    expect(result).toMatchObject({ ok: true, result: { launched: true, spawnStatus: null } });
    expect((result as { result: object }).result).not.toHaveProperty("hostAgentLimit");
    expect(readHostAgentLimit).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(true);
  });

  it("parks an agent launched into the background and records its grid restore target", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude", location: "background" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { launched: true, location: "background", spawnStatus: null },
    });
    const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
    expect(spawned(invoke).id).toBe(terminalId);
    expect(store.read()?.terminals.find((t) => t.id === terminalId)).toMatchObject({
      location: "background",
      backgroundRestoreLocation: "grid",
    });
  });

  it("writes no restore target for a launch to the dock", async () => {
    const { deps, store } = launchDeps();

    await executeViewlessAction(
      request("agent.launch", { agentId: "claude", location: "dock" }),
      deps
    );

    const snapshot = store.read()?.terminals[0];
    expect(snapshot?.location).toBe("dock");
    expect(snapshot).not.toHaveProperty("backgroundRestoreLocation");
  });

  it("records the worktree's stable handle so restore follows a worktree move", async () => {
    const moved = makeWorktree({ ...WORKTREE, gitDir: "/repo/.git/worktrees/feature" });
    const { deps, store } = makeDeps(
      { getPtyReader: () => makePty(), getWorkspaceHosts: () => makeHosts() },
      { worktrees: [makeWorktree(), moved] }
    );

    await executeViewlessAction(
      request("agent.launch", { agentId: "claude", worktreeId: moved.id }),
      deps
    );

    expect(store.read()?.terminals[0]).toMatchObject({
      worktreeId: moved.id,
      worktreeGitDir: "/repo/.git/worktrees/feature",
    });
  });

  it("names the worktrees there are when the one asked for is not one", async () => {
    const { deps } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude", worktreeId: "/repo-wt/gone" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
    expect((result as { error: { message: string } }).error.message).toContain("/repo-wt/feature");
  });

  it("refuses a requested id a panel already holds", async () => {
    const { deps } = launchDeps({
      getPtyReader: () => makePty({ "t-taken": { kind: "terminal" } }),
    });

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude", requestedId: "t-taken" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });

  it.each([
    ["a browser panel", { agentId: "browser" }],
    ["an overlay", { agentId: "claude", location: "overlay" }],
    ["a panel hidden from persistence", { agentId: "claude", excludeFromPersistence: true }],
    ["a panel removed on exit", { agentId: "claude", removeOnExit: true }],
    ["a handback with no prompt", { agentId: "claude", handback: true }],
    ["a notice from an unregistered agent", { agentId: "anti-gravity", notify: true }],
    ["an interactive Vibe launch with a model", { agentId: "mistral", model: "devstral-small" }],
  ])("refuses %s before anything launches", async (_label, args) => {
    const { deps, invoke } = launchDeps();

    const result = await executeViewlessAction(request("agent.launch", args), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(
      false
    );
  });

  it("records a headless Vibe run's model where its command selects it (#15569)", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", {
        agentId: "mistral",
        worktreeId: "/repo-wt/feature",
        model: "devstral-small",
        prompt: "Fix the bug",
        interactive: false,
      }),
      deps
    );

    const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
    const payload = spawned(invoke);
    expect(payload.command).toContain("--model devstral-small --prompt");
    expect(payload).toMatchObject({
      agentModelId: "devstral-small",
      title: "Mistral Vibe (Small)",
    });
    expect(payload.agentLaunchFlags).not.toContain("--model");
    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === terminalId);
    expect(snapshot?.agentModelId).toBe("devstral-small");
  });

  it("records the prompt as the caller wrote it, without the handback instruction (#14592)", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", {
        agentId: "claude",
        worktreeId: "/repo-wt/feature",
        prompt: "Fix the flaky test\nthen push",
        handback: true,
      }),
      deps
    );

    const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
    // The spawn still carries the instruction; only the record goes without it.
    expect(spawned(invoke).command).toContain("DAINTREE-DONE-");
    // The prompt is the run's first, so none of its sends is offered (#15521).
    expect(spawned(invoke).hasFirstPrompt).toBe(true);
    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === terminalId);
    expect(snapshot?.firstPrompt).toEqual({
      text: "Fix the flaky test\nthen push",
      via: "launch",
      at: expect.any(Number),
    });
    // Never handed back to the caller.
    expect(JSON.stringify(result)).not.toContain("Fix the flaky test");
  });

  it("writes no record for a launch with no prompt (#14592)", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "claude", worktreeId: "/repo-wt/feature" }),
      deps
    );

    const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === terminalId);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty("firstPrompt");
    // Its first send written becomes the record instead (#15521).
    expect(spawned(invoke)).not.toHaveProperty("hasFirstPrompt");
  });

  it("opens a plain shell for the terminal id", async () => {
    const { deps, invoke } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", { agentId: "terminal" }),
      deps
    );

    expect(result).toMatchObject({ ok: true, result: { launched: true } });
    expect(spawned(invoke)).not.toHaveProperty("launchAgentId");
    expect(spawned(invoke).title).toBe("Terminal");
  });
});

describe("a scheduled run's agent launched with no frontend (#15977)", () => {
  const RUN = { scheduleId: "schedule-1", runId: "run-1" };

  it("marks the PTY and the saved panel with the schedule and its run", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await runAgentLaunch(
      request("agent.launch", { agentId: "claude", prompt: "Nightly triage" }),
      PROJECT,
      deps,
      { scheduledRun: RUN }
    );

    expect(result).toMatchObject({ ok: true, result: { launched: true } });
    const payload = spawned(invoke);
    expect(payload.scheduledRun).toEqual(RUN);
    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === payload.id);
    expect(snapshot).toMatchObject({ spawnedBy: "schedule", scheduledRun: RUN });
  });

  it("never takes the schedule from the arguments, so an MCP caller can't claim it", async () => {
    const { deps, invoke, store } = launchDeps();

    const result = await executeViewlessAction(
      request("agent.launch", {
        agentId: "claude",
        spawnedBy: "schedule",
        scheduledRun: RUN,
      }),
      deps
    );

    expect(result).toMatchObject({ ok: true, result: { launched: true } });
    const payload = spawned(invoke);
    expect(payload).not.toHaveProperty("scheduledRun");
    const snapshot = store.read()?.terminals.find((terminal) => terminal.id === payload.id);
    expect(snapshot?.spawnedBy).toBe("mcp");
    expect(snapshot).not.toHaveProperty("scheduledRun");
  });
});

describe("agent.listAvailable with no frontend", () => {
  it("reports the registry with the host's own probe", async () => {
    const { deps } = makeDeps();
    deps.agents.getAvailability = async () => ({ availability: { claude: "ready" }, live: true });

    const result = await executeViewlessAction(request("agent.listAvailable", undefined), deps);

    const listing = (result as { result: { agents: Array<{ id: string; launchable?: boolean }> } })
      .result;
    expect(listing.agents.find((agent) => agent.id === "claude")).toMatchObject({
      launchable: true,
      source: "built-in",
    });
  });

  it("reports this machine's toolbar pins, not the agent settings (#14702)", async () => {
    const { deps } = makeDeps();
    deps.agents.getAvailability = async () => ({
      availability: { claude: "ready", gemini: "missing", codex: "ready" },
      live: true,
    });
    deps.agents.getToolbarPins = async () => ({ gemini: true, codex: false });

    const result = await executeViewlessAction(request("agent.listAvailable", undefined), deps);

    const agents = (
      result as {
        result: { agents: Array<{ id: string; pinned?: boolean; toolbarVisible?: boolean }> };
      }
    ).result.agents;
    const byId = (id: string) => agents.find((agent) => agent.id === id);
    expect(byId("gemini")).toMatchObject({ pinned: true, toolbarVisible: true });
    expect(byId("codex")).toMatchObject({ pinned: false, toolbarVisible: false });
    expect(byId("claude")).not.toHaveProperty("pinned");
    expect(byId("claude")).toMatchObject({ toolbarVisible: true });
  });
});
