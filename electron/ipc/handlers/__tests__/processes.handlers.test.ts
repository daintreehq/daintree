import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppMetrics: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getAllProjectIdentities: vi.fn(() => [{ id: "p1", path: "/p1", name: "Cedar" }]),
  },
}));

vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: {
    getAllScratches: vi.fn(() => [{ id: "s1", path: "/s1", name: "Scratch one" }]),
  },
}));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listManagedProcesses: vi.fn(() => []),
    getWorkerGovernanceSnapshots: vi.fn(() => []),
  },
}));

import { ipcMain } from "electron";
import { registerProcessesHandlers } from "../processes.js";
import type { HandlerDependencies } from "../../types.js";
import type { ProcessInventorySnapshot } from "../../../../shared/types/processes.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const EVENT = {} as Electron.IpcMainInvokeEvent;

let dispose: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("processes IPC (#13175)", () => {
  it("lists terminals from every project, named, whichever view asks", async () => {
    const getProcessInventory = vi.fn(async () => ({
      inventories: [
        {
          terminals: [
            {
              id: "t1",
              projectId: "p1",
              cwd: "/p1",
              isAssistantTerminal: false,
              spawnedAt: 1,
              isTrashed: false,
              rootPid: 10,
              sample: null,
            },
            {
              id: "t2",
              projectId: "s1",
              cwd: "/s1",
              isAssistantTerminal: false,
              spawnedAt: 2,
              isTrashed: false,
              rootPid: 11,
              sample: null,
            },
          ],
          pidSamples: {},
          available: true,
          sampledAt: 1_000,
        },
      ],
      shardsTotal: 1,
      shardsFailed: 0,
    }));
    dispose = registerProcessesHandlers({
      ptyClient: { getProcessInventory },
    } as unknown as HandlerDependencies);

    const snapshot = (await getHandler("processes:get-snapshot")(
      EVENT
    )) as ProcessInventorySnapshot;

    expect(getProcessInventory).toHaveBeenCalledWith([]);
    expect(snapshot.terminals.map((t) => [t.id, t.projectName])).toEqual([
      ["t1", "Cedar"],
      ["t2", "Scratch one"],
    ]);
    expect(snapshot.complete).toBe(true);
  });

  it("reports an incomplete list when the terminal backend is missing", async () => {
    dispose = registerProcessesHandlers({} as HandlerDependencies);

    const snapshot = (await getHandler("processes:get-snapshot")(
      EVENT
    )) as ProcessInventorySnapshot;

    expect(snapshot.terminals).toEqual([]);
    expect(snapshot.complete).toBe(false);
  });

  it("removes its handler on dispose", () => {
    dispose = registerProcessesHandlers({} as HandlerDependencies);
    dispose();
    dispose = null;

    expect(ipcMain.removeHandler).toHaveBeenCalledWith("processes:get-snapshot");
  });
});
