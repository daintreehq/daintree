/**
 * #11079: a terminal spawned in a scratch workspace must be stamped with the
 * scratch's id, so `killByProject(scratchId)` reaches it when the scratch is
 * deleted. Capturing only `currentProject` (null in a scratch) left ownership to
 * PtyClient's global `activeProjectId` back-fill — null after a restore into a
 * scratch, and last-write-wins across windows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { terminalClient, projectClient, globalEnvClient } from "@/clients";
import { mergeTerminalLaunchEnv } from "@shared/utils/terminalLaunchOptions";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

// addPanel lazily imports the project store; drive `currentProject` per test.
let currentProject: { id: string; path: string } | null = null;
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject }) },
}));

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
  };
});

const { usePanelStore } = await import("../../../panelStore");

const spawnMock = vi.mocked(terminalClient.spawn);
const getSettingsMock = vi.mocked(projectClient.getSettings);
const globalEnvMock = vi.mocked(globalEnvClient.get);

/** Seed the view identity main stamps onto every WebContentsView at creation. */
function setViewWorkspaceId(id: string | undefined): void {
  window.__DAINTREE_INITIAL_PROJECT__ = id ? { id } : undefined;
}

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

function spawnedProjectId(): string | undefined {
  return spawnMock.mock.calls[0]?.[0]?.projectId;
}

function spawnedEnv(): Record<string, string> | undefined {
  return spawnMock.mock.calls[0]?.[0]?.env;
}

describe("addPanel workspace ownership (#11079)", () => {
  beforeEach(async () => {
    currentProject = null;
    const { reset } = usePanelStore.getState();
    await reset();

    spawnMock.mockReset();
    spawnMock.mockImplementation(async ({ id }) => id ?? "spawn-id");
    getSettingsMock.mockClear();
  });

  it("stamps the scratch id on a terminal spawned in a scratch view", async () => {
    currentProject = null; // switching to a scratch clears the project pointer
    setViewWorkspaceId("scratch-uuid");

    await usePanelStore.getState().addPanel({ requestedId: "term-1", bypassLimits: true });
    await drainMicrotasks();

    expect(spawnedProjectId()).toBe("scratch-uuid");
  });

  it("does not fetch project settings for a scratch workspace", async () => {
    currentProject = null;
    setViewWorkspaceId("scratch-uuid");

    await usePanelStore.getState().addPanel({ requestedId: "term-2", bypassLimits: true });
    await drainMicrotasks();

    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("prefers the current project over the view id when a project is active", async () => {
    // The view id and the project agree in practice; assert precedence explicitly so
    // a project view can never adopt some other workspace's id.
    currentProject = { id: "project-abc", path: "/repo" };
    setViewWorkspaceId("project-abc");

    await usePanelStore.getState().addPanel({ requestedId: "term-3", bypassLimits: true });
    await drainMicrotasks();

    expect(spawnedProjectId()).toBe("project-abc");
    expect(getSettingsMock).toHaveBeenCalledWith("project-abc");
  });

  it("leaves the terminal unowned when the view has no workspace identity", async () => {
    currentProject = null;
    setViewWorkspaceId(undefined);

    await usePanelStore.getState().addPanel({ requestedId: "term-4", bypassLimits: true });
    await drainMicrotasks();

    expect(spawnedProjectId()).toBeUndefined();
  });
});

describe("addPanel launch context (#12486)", () => {
  beforeEach(async () => {
    currentProject = { id: "project-abc", path: "/repo" };
    setViewWorkspaceId("project-abc");
    const { reset } = usePanelStore.getState();
    await reset();

    spawnMock.mockReset();
    spawnMock.mockImplementation(async ({ id }) => id ?? "spawn-id");
  });

  it("sends a Claude launch the context its MCP session replays, naming the pane itself", async () => {
    await usePanelStore.getState().addPanel({
      requestedId: "claude-1",
      launchAgentId: "claude",
      command: "claude",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(spawnMock.mock.calls[0]?.[0]?.actionContext).toMatchObject({
      focusedTerminalId: "claude-1",
      focusedTerminalKind: "terminal",
    });
  });

  it("keeps a context the caller supplied", async () => {
    const supplied = { projectId: "project-abc", activeWorktreeId: "wt-supplied" };

    await usePanelStore.getState().addPanel({
      requestedId: "claude-2",
      launchAgentId: "claude",
      command: "claude",
      bypassLimits: true,
      actionContext: supplied,
    });
    await drainMicrotasks();

    expect(spawnMock.mock.calls[0]?.[0]?.actionContext).toEqual(supplied);
  });

  it("sends no context for a plain terminal", async () => {
    await usePanelStore.getState().addPanel({ requestedId: "term-5", bypassLimits: true });
    await drainMicrotasks();

    // Premise first: a spawn that never happened would also carry no context.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]!.actionContext).toBeUndefined();
  });

  // #15977: the pane and the host's record both name a scheduled run, and a
  // run reference never rides another source.
  it("keeps a scheduled run's ids on the pane and hands them to the host", async () => {
    const run = { scheduleId: "schedule-1", runId: "run-1" };
    await usePanelStore.getState().addPanel({
      requestedId: "claude-run",
      launchAgentId: "claude",
      command: "claude",
      bypassLimits: true,
      spawnedBy: "schedule",
      scheduledRun: run,
    });
    await usePanelStore.getState().addPanel({
      requestedId: "claude-mcp",
      launchAgentId: "claude",
      command: "claude",
      bypassLimits: true,
      spawnedBy: "mcp",
      scheduledRun: run,
    });
    await drainMicrotasks();

    const panels = usePanelStore.getState().panelsById;
    expect(panels["claude-run"]).toMatchObject({ spawnedBy: "schedule", scheduledRun: run });
    expect(panels["claude-mcp"]).toMatchObject({ spawnedBy: "mcp" });
    expect(panels["claude-mcp"]).not.toHaveProperty("scheduledRun");
    const byId = new Map(spawnMock.mock.calls.map(([options]) => [options.id, options]));
    expect(byId.get("claude-run")?.scheduledRun).toEqual(run);
    expect(byId.get("claude-mcp")?.scheduledRun).toBeUndefined();
  });
});

const GLOBAL = { TOOL_HOME: "/g", SHARED: "global", ONLY_GLOBAL: "1" };
const PROJECT = { SHARED: "project", ONLY_PROJECT: "1" };
const LAUNCH = { SHARED: "launch" };

/**
 * The window's launch and the host's viewless launch merge the environment
 * through one shared function, so a terminal gets the same tool paths whether
 * or not a window asked for it. This pins the window's side to it.
 */
describe("addPanel launch environment parity", () => {
  beforeEach(async () => {
    currentProject = { id: "project-abc", path: "/repo" };
    window.__DAINTREE_INITIAL_PROJECT__ = { id: "project-abc" };
    const { reset } = usePanelStore.getState();
    await reset();

    spawnMock.mockReset();
    spawnMock.mockImplementation(async ({ id }) => id ?? "spawn-id");
    globalEnvMock.mockResolvedValue(GLOBAL);
    getSettingsMock.mockResolvedValue({ runCommands: [], environmentVariables: PROJECT });
  });

  it("layers global under project under the caller's env, as the shared merge does", async () => {
    await usePanelStore
      .getState()
      .addPanel({ requestedId: "env-1", bypassLimits: true, env: LAUNCH });
    await drainMicrotasks();

    expect(spawnedEnv()).toEqual(mergeTerminalLaunchEnv(GLOBAL, PROJECT, LAUNCH));
    expect(spawnedEnv()).toEqual({
      TOOL_HOME: "/g",
      ONLY_GLOBAL: "1",
      ONLY_PROJECT: "1",
      SHARED: "launch",
    });
  });

  it("passes the caller's env through untouched when nothing is configured", async () => {
    globalEnvMock.mockResolvedValue({});
    getSettingsMock.mockResolvedValue({ runCommands: [] });

    await usePanelStore.getState().addPanel({ requestedId: "env-2", bypassLimits: true });
    await drainMicrotasks();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnedEnv()).toBeUndefined();
    expect(mergeTerminalLaunchEnv({}, {}, undefined)).toBeUndefined();
  });
});
