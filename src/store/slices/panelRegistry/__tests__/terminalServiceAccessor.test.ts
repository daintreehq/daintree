/**
 * The panel-registry slices reach the terminal service through its lazy
 * accessor (#14261). Creating a terminal and waiting on one must load the
 * service when it isn't up yet, rather than skipping the call as an
 * instance-gated peek() would.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSpawn = vi.fn().mockResolvedValue({ id: "t-1" });

const accessor = vi.hoisted(() => {
  const service = {
    prewarmTerminal: vi.fn().mockResolvedValue(undefined),
    waitForInstance: vi.fn().mockResolvedValue(undefined),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
  };
  let resolveLoad: (value: typeof service) => void = () => {};
  const load = vi.fn(
    () =>
      new Promise<typeof service>((resolve) => {
        resolveLoad = resolve;
      })
  );
  return {
    service,
    load,
    resolveLoad: () => resolveLoad(service),
  };
});

vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () => null,
  load: accessor.load,
  with: vi.fn(),
  onReady: vi.fn(() => () => {}),
  register: vi.fn(),
  setGpuHardwareAvailable: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: mockSpawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    updateTitle: vi.fn(),
    gracefulKill: vi.fn().mockResolvedValue(null),
    submit: vi.fn().mockResolvedValue(undefined),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
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
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/store/restartExitSuppression", () => ({
  markTerminalRestarting: vi.fn(),
  unmarkTerminalRestarting: vi.fn(),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { id: "proj-1" } }),
  },
}));

vi.mock("@/utils/terminalValidation", () => ({
  validateTerminalConfig: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("../../../panelStore");

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("panel registry terminal service accessor (#14261)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { window?: unknown }).window = {
      electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
    };
    await usePanelStore.getState().reset();
  });

  it("loads the service before prewarming when it isn't up yet", async () => {
    const adding = usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "t-1",
      cwd: "/tmp",
      location: "background",
    });

    await vi.waitFor(() => expect(accessor.load).toHaveBeenCalled());
    await flushMicrotasks();
    expect(accessor.service.prewarmTerminal).not.toHaveBeenCalled();

    accessor.resolveLoad();
    await adding;

    expect(accessor.service.prewarmTerminal).toHaveBeenCalledWith(
      "t-1",
      undefined,
      expect.any(Object),
      expect.objectContaining({ offscreen: false })
    );
  });

  it("loads the service before waiting on the restarted instance", async () => {
    usePanelStore.setState({
      panelsById: {
        "t-1": {
          id: "t-1",
          kind: "terminal",
          title: "Shell",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["t-1"],
    });

    const restarting = usePanelStore.getState().restartTerminal("t-1");

    await vi.waitFor(() => expect(accessor.load).toHaveBeenCalled());
    await flushMicrotasks();
    expect(accessor.service.waitForInstance).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    accessor.resolveLoad();
    await restarting;

    expect(accessor.service.waitForInstance).toHaveBeenCalledWith("t-1", { timeoutMs: 5000 });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
