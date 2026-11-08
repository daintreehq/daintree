import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { terminalClient } from "@/clients";
import {
  resetStoreAccessorsForTesting,
  setCurrentProjectAwaitingCloneAccessor,
} from "@/store/storeAccessors";

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

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

describe("addPanel in a project still awaiting its clone (#16352)", () => {
  beforeEach(async () => {
    currentProject = { id: "p-clone", path: "/work/widgets" };
    const { reset } = usePanelStore.getState();
    await reset();
    spawnMock.mockReset();
    spawnMock.mockImplementation(async ({ id }) => id ?? "spawn-id");
  });

  afterEach(() => {
    resetStoreAccessorsForTesting();
  });

  it("puts nothing on the grid and spawns nothing while the clone runs", async () => {
    setCurrentProjectAwaitingCloneAccessor(() => true);

    const id = await usePanelStore
      .getState()
      .addPanel({ requestedId: "term-1", bypassLimits: true });
    await drainMicrotasks();

    expect(id).toBeNull();
    expect(usePanelStore.getState().panelIds).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a browser panel too, so the clone's view stays on the grid", async () => {
    setCurrentProjectAwaitingCloneAccessor(() => true);

    const id = await usePanelStore
      .getState()
      .addPanel({ kind: "browser", requestedId: "browser-1", bypassLimits: true });

    expect(id).toBeNull();
    expect(usePanelStore.getState().panelIds).toEqual([]);
  });

  it("adds a terminal as usual once the checkout has landed", async () => {
    setCurrentProjectAwaitingCloneAccessor(() => false);

    await usePanelStore.getState().addPanel({ requestedId: "term-2", bypassLimits: true });
    await drainMicrotasks();

    expect(usePanelStore.getState().panelIds).toEqual(["term-2"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
