import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLeakAutoRestartDeps } from "../MemoryLeakAutoRestartService.js";

const electronMock = vi.hoisted(() => ({
  webContents: { fromId: vi.fn() },
}));
vi.mock("electron", () => electronMock);

const thawMock = vi.hoisted(() => ({
  release: () => {},
  unfreezeWebContents: vi.fn(),
}));
vi.mock("../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: thawMock.unfreezeWebContents,
}));

vi.mock("../../store.js", () => ({ store: { get: vi.fn(() => undefined) } }));

const leasesMock = vi.hoisted(() => ({
  getDriveTarget: vi.fn(),
  nextHolderEndpoint: vi.fn(() => null),
  noteSessionChange: vi.fn(),
}));
vi.mock("../DriveLeaseService.js", () => ({ getDriveLeaseService: () => leasesMock }));

const viewlessMock = vi.hoisted(() => ({
  restartTerminalWithoutViewLive: vi.fn(async () => "restarted"),
}));
vi.mock("../viewless/index.js", () => viewlessMock);

vi.mock("../pty/lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ({ currentGeneration: () => 1 }),
}));

const serviceMock = vi.hoisted(() => ({
  deps: null as MemoryLeakAutoRestartDeps | null,
  active: null as unknown,
}));
vi.mock("../MemoryLeakAutoRestartService.js", () => ({
  MemoryLeakAutoRestartService: class {
    constructor(deps: MemoryLeakAutoRestartDeps) {
      serviceMock.deps = deps;
    }
  },
  getActiveMemoryLeakAutoRestart: () => serviceMock.active,
  setActiveMemoryLeakAutoRestart: (next: unknown) => {
    serviceMock.active = next;
  },
}));

import { startMemoryLeakAutoRestart } from "../memoryLeakAutoRestartLive.js";

function makeEndpoint(kind: "local-view" | "remote-view") {
  return {
    kind,
    handle: kind === "local-view" ? 7 : -7,
    isClosed: vi.fn(() => false),
    send: vi.fn(),
  };
}

function deliverVia(endpoint: ReturnType<typeof makeEndpoint>) {
  leasesMock.getDriveTarget.mockReturnValue({ kind: "live", endpoint });
  const target = serviceMock.deps!.pickTarget("proj-1");
  if (target.kind !== "view") throw new Error(`expected a view target, got ${target.kind}`);
  return target.deliver;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("memory-leak auto-restart run by the host itself (#15918)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.active = null;
    serviceMock.deps = null;
    startMemoryLeakAutoRestart({
      on: vi.fn(),
      off: vi.fn(),
      setResourceMonitoring: vi.fn(),
      getTerminalAsync: vi.fn(),
    } as never);
  });

  it("tells the lease of the change only once the restart goes ahead", async () => {
    leasesMock.getDriveTarget.mockReturnValue({ kind: "vacant" });
    expect(serviceMock.deps!.pickTarget("proj-1")).toEqual({ kind: "host" });
    expect(leasesMock.noteSessionChange).not.toHaveBeenCalled();

    const isCurrent = () => true;
    await expect(serviceMock.deps!.restartOnHost("proj-1", "t1", isCurrent)).resolves.toBe(
      "restarted"
    );
    const [, , passedCurrent, beforeChange] = viewlessMock.restartTerminalWithoutViewLive.mock
      .calls[0] as [string, string, () => boolean, () => void];
    expect(passedCurrent).toBe(isCurrent);
    expect(leasesMock.noteSessionChange).not.toHaveBeenCalled();
    beforeChange();
    expect(leasesMock.noteSessionChange).toHaveBeenCalledWith("proj-1", null);
  });
});

describe("memory-leak auto-restart delivery to a view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.active = null;
    serviceMock.deps = null;
    thawMock.unfreezeWebContents.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          thawMock.release = resolve;
        })
    );
    startMemoryLeakAutoRestart({
      on: vi.fn(),
      off: vi.fn(),
      setResourceMonitoring: vi.fn(),
      getTerminalAsync: vi.fn(),
    } as never);
  });

  it("sends to a local view once it thaws while the decision still holds", async () => {
    electronMock.webContents.fromId.mockReturnValue({ isDestroyed: () => false });
    const endpoint = makeEndpoint("local-view");

    deliverVia(endpoint)({ terminalId: "t1", thresholdMb: 512 }, () => true);
    expect(endpoint.send).not.toHaveBeenCalled();
    thawMock.release();
    await flush();

    expect(endpoint.send).toHaveBeenCalledTimes(1);
    expect(endpoint.send.mock.calls[0]?.[0]).toMatchObject({
      args: [
        {
          name: "terminal:memory-leak-restart-requested",
          payload: { terminalId: "t1", thresholdMb: 512 },
        },
      ],
    });
  });

  it("drops the request when the terminal is relaunched during the thaw", async () => {
    electronMock.webContents.fromId.mockReturnValue({ isDestroyed: () => false });
    const endpoint = makeEndpoint("local-view");
    let current = true;

    deliverVia(endpoint)({ terminalId: "t1", thresholdMb: 512 }, () => current);
    current = false;
    thawMock.release();
    await flush();

    expect(endpoint.send).not.toHaveBeenCalled();
  });

  it("sends to a view with nothing to thaw only while the decision still holds", () => {
    const endpoint = makeEndpoint("remote-view");
    const deliver = deliverVia(endpoint);

    deliver({ terminalId: "t1", thresholdMb: 512 }, () => false);
    expect(endpoint.send).not.toHaveBeenCalled();

    deliver({ terminalId: "t1", thresholdMb: 512 }, () => true);
    expect(endpoint.send).toHaveBeenCalledTimes(1);
    expect(thawMock.unfreezeWebContents).not.toHaveBeenCalled();
  });
});
