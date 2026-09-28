/**
 * Launch-option parity between a window's terminal launch and the host's
 * viewless one (Remote Hosts).
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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  },
}));

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

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

function spawnedEnv(): Record<string, string> | undefined {
  return spawnMock.mock.calls[0]?.[0]?.env;
}

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
