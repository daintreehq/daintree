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
import { createProcessesNamespace, registerProcessesHandlers } from "../processes.js";
import {
  DriveLeaseService,
  _resetDriveLeaseServiceForTesting,
} from "../../../services/DriveLeaseService.js";
import type { IpcContext } from "../../types.js";
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

describe("ending a closed terminal's processes under drive leases", () => {
  const closed = (pid: number, projectId?: string) => ({
    pid,
    startTime: `t${pid}`,
    comm: "node",
    memoryKb: null,
    cpuPercent: null,
    origin: { kind: "terminal" as const, id: `term-${pid}`, ...(projectId ? { projectId } : {}) },
    closedAt: 1,
  });

  function setup() {
    const killClosedTerminalProcesses = vi.fn(async () => ({
      ended: 1,
      stillRunning: 0,
      unchecked: 0,
      notTracked: 0,
    }));
    const ptyClient = {
      killClosedTerminalProcesses,
      getProcessInventory: vi.fn(async () => ({
        inventories: [
          {
            terminals: [],
            closedTerminalProcesses: [closed(101, "proj-a"), closed(202)],
            pidSamples: {},
            available: true,
            sampledAt: 1,
          },
        ],
        shardsTotal: 1,
        shardsFailed: 0,
      })),
    };
    const ns = createProcessesNamespace({ ptyClient } as never);
    const kill = ns.ops.killClosedTerminalProcesses.handler as (
      ctx: IpcContext,
      targets: unknown
    ) => Promise<unknown>;
    return { kill, killClosedTerminalProcesses };
  }

  const ctxFor = (endpointId: string, clientId: string) =>
    ({ endpoint: { endpointId, clientId } }) as unknown as IpcContext;

  afterEach(() => _resetDriveLeaseServiceForTesting(null));

  it("checks nothing when no lease service runs", async () => {
    const { kill, killClosedTerminalProcesses } = setup();
    await kill(ctxFor("e1", "client-b"), [{ pid: 101, startTime: "t101" }]);
    expect(killClosedTerminalProcesses).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller who doesn't drive the project a target was recorded under", async () => {
    const lease = new DriveLeaseService();
    _resetDriveLeaseServiceForTesting(lease);
    const isDriving = vi
      .spyOn(lease, "isDriving")
      .mockImplementation((_projectId, endpoint) => endpoint.endpointId === "driver");
    const { kill, killClosedTerminalProcesses } = setup();

    await expect(
      kill(ctxFor("observer", "client-c"), [{ pid: 101, startTime: "t101" }])
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(killClosedTerminalProcesses).not.toHaveBeenCalled();
    expect(isDriving).toHaveBeenCalledWith(
      "proj-a",
      expect.objectContaining({ endpointId: "observer" })
    );

    await kill(ctxFor("driver", "client-b"), [{ pid: 101, startTime: "t101" }]);
    // A process recorded with no project, or one the request does not name, has no lease to consult.
    await kill(ctxFor("observer", "client-c"), [{ pid: 202, startTime: "t202" }]);
    expect(killClosedTerminalProcesses).toHaveBeenCalledTimes(2);
  });
});
