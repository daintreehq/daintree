// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResizeResult } from "@shared/types/pty-host";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import type { ManagedTerminal } from "../types";

let capturedResizeResultCb: ((id: string, result: TerminalResizeResult) => void) | null = null;

const { getForProject, resize } = vi.hoisted(() => ({
  getForProject: vi.fn<(projectId: string) => Promise<BackendTerminalInfo[]>>(),
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
    getForProject,
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

function info(id: string, ptyCols: number, ptyRows: number): BackendTerminalInfo {
  return { id, cwd: "/", spawnedAt: 0, ptyCols, ptyRows } as BackendTerminalInfo;
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalInstanceService — watching a project another frontend drives (#13282)", () => {
  let service: WatchTestService;
  let gate: InputGate;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedResizeResultCb = null;
    getForProject.mockResolvedValue([]);

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

  const cols = (id: string) => service.instances.get(id)!.terminal.cols;
  const rows = (id: string) => service.instances.get(id)!.terminal.rows;
  const locked = (id: string) => service.resizeController.isResizeLocked(id);

  it("leaves ordinary local use alone: no lease, no hold, no inventory read", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    gate.setDriveLeaseSnapshot(lease({ drivingHere: true }));
    await settle();

    expect(locked("t1")).toBe(false);
    expect(getForProject).not.toHaveBeenCalled();
  });

  it("holds every pane at the grid the PTY reports once another frontend drives", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    await service.prewarmTerminal("t2", "terminal", {});
    getForProject.mockResolvedValue([info("t1", 200, 50), info("t2", 90, 30)]);

    gate.setDriveLeaseSnapshot(lease());
    await settle();

    expect(getForProject).toHaveBeenCalledTimes(1);
    expect(getForProject).toHaveBeenCalledWith("proj-1");
    expect(locked("t1")).toBe(true);
    expect([cols("t1"), rows("t1")]).toEqual([200, 50]);
    expect([cols("t2"), rows("t2")]).toEqual([90, 30]);

    // The pane's own box can no longer reach the PTY.
    service.resizeController.sendPtyResize("t1", 100, 30);
    expect(resize).not.toHaveBeenCalled();
  });

  it("follows the driver's resizes", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    gate.setDriveLeaseSnapshot(lease());
    await settle();

    capturedResizeResultCb?.("t1", echo(150, 45));

    expect([cols("t1"), rows("t1")]).toEqual([150, 45]);
    expect(resize).not.toHaveBeenCalled();
  });

  it("ignores a driver's echo while this view drives", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    const before = [cols("t1"), rows("t1")];

    capturedResizeResultCb?.("t1", echo(150, 45));

    expect([cols("t1"), rows("t1")]).toEqual(before);
  });

  it("holds and seeds a terminal created while watching", async () => {
    gate.setDriveLeaseSnapshot(lease());
    getForProject.mockResolvedValue([info("late", 132, 43)]);

    await service.prewarmTerminal("late", "terminal", {});
    await settle();

    expect(locked("late")).toBe(true);
    expect([cols("late"), rows("late")]).toEqual([132, 43]);
  });

  it("lets a newer echo win over an inventory read already in flight", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    let answer!: (infos: BackendTerminalInfo[]) => void;
    getForProject.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    gate.setDriveLeaseSnapshot(lease());
    await settle();
    capturedResizeResultCb?.("t1", echo(150, 45));
    answer([info("t1", 200, 50)]);
    await settle();

    expect([cols("t1"), rows("t1")]).toEqual([150, 45]);
  });

  it("re-fits every watched pane in one pass on taking the project over", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    await service.prewarmTerminal("t2", "terminal", {});
    gate.setDriveLeaseSnapshot(lease());
    await settle();
    const pass = vi.spyOn(service, "runResizePass").mockImplementation(() => {});
    service.instances.get("t1")!.ptyCols = 100;
    service.instances.get("t1")!.ptyRows = 30;

    gate.setDriveLeaseSnapshot(lease({ drivingHere: true, isHolderEndpoint: true }));

    expect(locked("t1")).toBe(false);
    expect(locked("t2")).toBe(false);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith(["t1", "t2"], { immediate: true });
    // The PTY was last sized by the other frontend, so the re-fit must send.
    expect(service.instances.get("t1")!.ptyCols).toBeUndefined();
  });

  it("drops an inventory read that answers after the take-over", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    let answer!: (infos: BackendTerminalInfo[]) => void;
    getForProject.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    gate.setDriveLeaseSnapshot(lease());
    await settle();
    vi.spyOn(service, "runResizePass").mockImplementation(() => {});
    const before = [cols("t1"), rows("t1")];

    gate.setDriveLeaseSnapshot(null);
    answer([info("t1", 200, 50)]);
    await settle();

    expect([cols("t1"), rows("t1")]).toEqual(before);
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
