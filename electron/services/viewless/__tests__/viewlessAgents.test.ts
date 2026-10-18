import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { AgentSettings } from "../../../../shared/types/agentSettings.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
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
  ])("refuses %s before anything launches", async (_label, args) => {
    const { deps, invoke } = launchDeps();

    const result = await executeViewlessAction(request("agent.launch", args), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)).toBe(
      false
    );
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
});
