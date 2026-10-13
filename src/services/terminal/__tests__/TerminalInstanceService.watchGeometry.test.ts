// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResizeResult } from "@shared/types/pty-host";
import type { TerminalInfoPayload } from "@shared/types/ipc/terminal";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import type { ManagedTerminal } from "../types";

let capturedResizeResultCb: ((id: string, result: TerminalResizeResult) => void) | null = null;

const { getInfo, resize } = vi.hoisted(() => ({
  getInfo: vi.fn<(id: string) => Promise<TerminalInfoPayload>>(),
  resize: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onResizeResult: vi.fn((cb: (id: string, result: TerminalResizeResult) => void) => {
      capturedResizeResultCb = cb;
      return vi.fn();
    }),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    getInfo,
    resize,
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    getPortAckGeneration: vi.fn(() => 0),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

type WatchTestService = {
  instances: Map<string, ManagedTerminal>;
  prewarmTerminal: (id: string, type: string, options: Record<string, unknown>) => unknown;
  holdGeometry: (id: string) => () => void;
  runResizePass: (ids: string[], options?: { immediate?: boolean }) => void;
  destroy: (id: string) => void;
  dispose: () => void;
  resizeController: {
    isResizeLocked: (id: string) => boolean;
    sendPtyResize: (id: string, cols: number, rows: number) => void;
  };
};

type InputGate = typeof import("../inputGate");

function lease(overrides: Partial<DriveLeaseView> = {}): DriveLeaseView {
  return {
    projectId: "proj-1",
    holder: { clientName: "Studio", leaseId: 7 },
    drivingHere: false,
    isHolderEndpoint: false,
    viewerIsHostLocal: false,
    ...overrides,
  } as unknown as DriveLeaseView;
}

const laptopLease = () =>
  lease({ holder: { clientName: "Laptop", leaseId: 8 } } as unknown as Partial<DriveLeaseView>);

function info(id: string, ptyCols?: number, ptyRows?: number): TerminalInfoPayload {
  return { id, ptyCols, ptyRows } as TerminalInfoPayload;
}

/** Answers each info read from `grids`, by id. */
function answerFrom(grids: Record<string, [number, number]>): void {
  getInfo.mockImplementation(async (id) => {
    const grid = grids[id];
    return grid ? info(id, grid[0], grid[1]) : info(id);
  });
}

/** The next info read waits until the returned function answers it. */
function deferredInfo(): (value: TerminalInfoPayload) => void {
  let answer!: (value: TerminalInfoPayload) => void;
  getInfo.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  return (value) => answer(value);
}

function echo(cols: number, rows: number): TerminalResizeResult {
  return {
    launchGeneration: 1,
    requestedCols: cols,
    requestedRows: rows,
    appliedCols: cols,
    appliedRows: rows,
    outcome: "applied",
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("TerminalInstanceService — watching a project another frontend drives (#13282)", () => {
  let service: WatchTestService;
  let gate: InputGate;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedResizeResultCb = null;
    getInfo.mockReset();
    answerFrom({});

    gate = (await import("../inputGate")) as InputGate;
    gate.setDriveLeaseSnapshot(null);
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: WatchTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.dispose();
    gate.setDriveLeaseSnapshot(null);
  });

  const grid = (id: string) => {
    const { cols, rows } = service.instances.get(id)!.terminal;
    return [cols, rows];
  };
  const locked = (id: string) => service.resizeController.isResizeLocked(id);

  it("leaves a view that drives alone: no hold, no info read", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    gate.setDriveLeaseSnapshot(lease({ drivingHere: true }));
    await settle();

    expect(locked("t1")).toBe(false);
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("holds every pane at the grid the PTY reports once another frontend drives", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    await service.prewarmTerminal("t2", "terminal", {});
    answerFrom({ t1: [200, 50], t2: [90, 30] });

    gate.setDriveLeaseSnapshot(lease());
    await settle();

    expect(getInfo.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"]);
    expect(locked("t1")).toBe(true);
    expect(grid("t1")).toEqual([200, 50]);
    expect(grid("t2")).toEqual([90, 30]);

    // The pane's own box can no longer reach the PTY.
    service.resizeController.sendPtyResize("t1", 100, 30);
    expect(resize).not.toHaveBeenCalled();
  });

  it("follows the driver's resizes", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    capturedResizeResultCb!("t1", echo(150, 45));

    expect(grid("t1")).toEqual([150, 45]);
    expect(resize).not.toHaveBeenCalled();
  });

  it("ignores a PTY echo while this view drives, even for a pane Canopy holds", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    service.holdGeometry("t1");
    gate.setDriveLeaseSnapshot(lease({ drivingHere: true }));
    const before = grid("t1");

    expect(capturedResizeResultCb).toBeTypeOf("function");
    capturedResizeResultCb!("t1", echo(150, 45));

    expect(grid("t1")).toEqual(before);
  });

  it("keeps the grid through a failed resize's echo", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    answerFrom({ t1: [200, 50] });
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    capturedResizeResultCb!("t1", {
      ...echo(150, 45),
      appliedCols: null,
      appliedRows: null,
      outcome: "failed",
    });

    expect(grid("t1")).toEqual([200, 50]);
  });

  it("holds and seeds a terminal created while watching", async () => {
    gate.setDriveLeaseSnapshot(lease());
    answerFrom({ late: [132, 43] });

    await service.prewarmTerminal("late", "terminal", {});
    await settle();

    expect(locked("late")).toBe(true);
    expect(grid("late")).toEqual([132, 43]);
  });

  it("lets a newer echo win over an info read already in flight", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    const answer = deferredInfo();

    gate.setDriveLeaseSnapshot(lease());
    await settle();
    capturedResizeResultCb!("t1", echo(150, 45));
    answer(info("t1", 200, 50));
    await settle();

    expect(grid("t1")).toEqual([150, 45]);
  });

  it("re-fits every watched pane in one pass on taking the project over", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    await service.prewarmTerminal("t2", "terminal", {});
    answerFrom({ t1: [100, 30], t2: [200, 50] });
    gate.setDriveLeaseSnapshot(lease());
    await settle();
    const pass = vi.spyOn(service, "runResizePass").mockImplementation(() => {});
    for (const id of ["t1", "t2"]) {
      service.instances.get(id)!.ptyCols = 100;
      service.instances.get(id)!.ptyRows = 30;
    }

    gate.setDriveLeaseSnapshot(lease({ drivingHere: true, isHolderEndpoint: true }));

    expect(locked("t1")).toBe(false);
    expect(locked("t2")).toBe(false);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith(["t1", "t2"], { immediate: true });
    // The PTY was last sized by the other frontend, so the re-fit must send
    // even where the pane's grid is the one xterm already holds.
    for (const id of ["t1", "t2"]) {
      expect(service.instances.get(id)!.ptyCols).toBeUndefined();
      expect(service.instances.get(id)!.reassertPtyGrid).toBe(true);
    }
  });

  it("drops a read from before the take-over once watching starts again", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    vi.spyOn(service, "runResizePass").mockImplementation(() => {});
    const answerOld = deferredInfo();
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    gate.setDriveLeaseSnapshot(lease({ drivingHere: true }));
    const answerNew = deferredInfo();
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    expect(getInfo).toHaveBeenCalledTimes(2);
    answerNew(info("t1", 150, 45));
    await settle();
    answerOld(info("t1", 200, 50));
    await settle();

    expect(grid("t1")).toEqual([150, 45]);
  });

  it("drops a read meant for an instance since replaced under the same id", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    const answerOld = deferredInfo();
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    service.destroy("t1");
    const answerNew = deferredInfo();
    await service.prewarmTerminal("t1", "terminal", {});
    await settle();
    answerNew(info("t1", 150, 45));
    await settle();
    answerOld(info("t1", 200, 50));
    await settle();

    expect(locked("t1")).toBe(true);
    expect(grid("t1")).toEqual([150, 45]);
  });

  it("retries a failed read on the next lease answer", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    getInfo.mockRejectedValueOnce(new Error("link down"));
    gate.setDriveLeaseSnapshot(lease());
    await settle();
    expect(grid("t1")).not.toEqual([200, 50]);

    answerFrom({ t1: [200, 50] });
    gate.setDriveLeaseSnapshot(laptopLease());
    await settle();

    expect(grid("t1")).toEqual([200, 50]);
  });

  it("takes one hold per pane however often the lease changes hands", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    vi.spyOn(service, "runResizePass").mockImplementation(() => {});
    gate.setDriveLeaseSnapshot(lease());
    gate.setDriveLeaseSnapshot(laptopLease());
    await settle();

    capturedResizeResultCb!("t1", echo(150, 45));
    expect(grid("t1")).toEqual([150, 45]);

    gate.setDriveLeaseSnapshot(null);
    expect(locked("t1")).toBe(false);
  });

  it("keeps Canopy's hold when the watch ends, and re-fits only once both let go", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    const releaseCanopy = service.holdGeometry("t1");
    gate.setDriveLeaseSnapshot(lease());
    await settle();
    const pass = vi.spyOn(service, "runResizePass").mockImplementation(() => {});

    gate.setDriveLeaseSnapshot(null);
    expect(locked("t1")).toBe(true);
    expect(pass).not.toHaveBeenCalled();

    releaseCanopy();
    expect(locked("t1")).toBe(false);
    expect(pass).toHaveBeenCalledWith(["t1"]);
  });

  it("releases a destroyed terminal's hold so its reused id starts clean", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    service.destroy("t1");

    expect(locked("t1")).toBe(false);
  });
});
