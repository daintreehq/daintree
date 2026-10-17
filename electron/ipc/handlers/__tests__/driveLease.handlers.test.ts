import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
}));

import { driveLeaseNamespace } from "../driveLease.js";
import type { IpcContext } from "../../types.js";
import type { ClientEndpoint } from "../../endpoint.js";
import { EndpointRegistryImpl } from "../../endpointRegistry.js";
import {
  DriveLeaseService,
  _resetDriveLeaseServiceForTesting,
} from "../../../services/DriveLeaseService.js";

const { get, takeOver, reportNavigation } = driveLeaseNamespace.ops;

function endpoint(
  endpointId: string,
  clientId: string,
  kind: ClientEndpoint["kind"],
  projectId = "p"
): ClientEndpoint {
  return {
    endpointId,
    clientId,
    projectId,
    kind,
    handle: kind === "local-view" ? 7 : -7,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => false,
  };
}

const ctxOf = (ep: ClientEndpoint) => ({ projectId: ep.projectId, endpoint: ep }) as IpcContext;

let registry: EndpointRegistryImpl;

beforeEach(() => {
  registry = new EndpointRegistryImpl();
  _resetDriveLeaseServiceForTesting(
    new DriveLeaseService({ registry, applyDriveLeases: () => {} })
  );
});

afterEach(() => {
  _resetDriveLeaseServiceForTesting(null);
});

describe("driveLease handlers", () => {
  it("tells each endpoint whether it holds the lease", async () => {
    const hostWindow = endpoint("local:7", "local", "local-view");
    const laptop = endpoint("s1:e1", "c1", "remote-view");
    registry.add(hostWindow);
    registry.add(laptop);
    // A remote view arriving settles the lease; a read never grants it.
    await Promise.resolve();
    await Promise.resolve();

    await expect(get.handler(ctxOf(hostWindow), { projectId: "p" })).resolves.toMatchObject({
      projectId: "p",
      holder: { endpointId: "local:7", isHostLocal: true },
      drivingHere: true,
      isHolderEndpoint: true,
      viewerIsHostLocal: true,
    });
    await expect(get.handler(ctxOf(laptop), { projectId: "p" })).resolves.toMatchObject({
      drivingHere: false,
      isHolderEndpoint: false,
      viewerIsHostLocal: false,
    });

    const taken = await takeOver.handler(ctxOf(laptop), { projectId: "p" });
    expect(taken).toMatchObject({
      holder: { endpointId: "s1:e1", clientId: "c1" },
      drivingHere: true,
      isHolderEndpoint: true,
    });
    await expect(get.handler(ctxOf(hostWindow), { projectId: "p" })).resolves.toMatchObject({
      drivingHere: false,
      viewerIsHostLocal: true,
    });
  });

  it("keeps a remote view to its own project and rejects a malformed payload", async () => {
    const laptop = endpoint("s1:e1", "c1", "remote-view");
    registry.add(laptop);

    await expect(get.handler(ctxOf(laptop), { projectId: "other" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(takeOver.handler(ctxOf(laptop), { projectId: "other" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      get.handler(ctxOf(laptop), { projectId: 3 } as unknown as { projectId: string })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps a driver's navigation for the views that read the lease", async () => {
    const hostWindow = endpoint("local:7", "local", "local-view");
    const laptop = endpoint("s1:e1", "c1", "remote-view");
    registry.add(hostWindow);
    registry.add(laptop);
    const taken = await takeOver.handler(ctxOf(laptop), { projectId: "p" });
    const navigation = {
      activeWorktreeId: "wt-1",
      focusedPanelId: "t1",
      maximize: { panelId: "t1", target: { type: "group" as const, id: "g1" } },
      focusMode: true,
    };

    await reportNavigation.handler(ctxOf(laptop), {
      projectId: "p",
      leaseId: taken.holder!.leaseId,
      navigation,
    });
    // A watcher's report is dropped, not refused.
    await reportNavigation.handler(ctxOf(hostWindow), {
      projectId: "p",
      leaseId: taken.holder!.leaseId,
      navigation: { ...navigation, activeWorktreeId: "wt-2" },
    });

    await expect(get.handler(ctxOf(hostWindow), { projectId: "p" })).resolves.toMatchObject({
      driverNavigation: navigation,
    });
  });

  it("rejects a malformed navigation report", async () => {
    const laptop = endpoint("s1:e1", "c1", "remote-view");
    registry.add(laptop);
    const valid = {
      activeWorktreeId: null,
      focusedPanelId: null,
      maximize: null,
      focusMode: false,
    };
    const bad = [
      { projectId: "other", leaseId: null, navigation: valid },
      { projectId: "p", leaseId: -1, navigation: valid },
      { projectId: "p", leaseId: null, navigation: { ...valid, focusMode: "yes" } },
      { projectId: "p", leaseId: null, navigation: { ...valid, activeWorktreeId: 4 } },
      {
        projectId: "p",
        leaseId: null,
        navigation: { ...valid, maximize: { panelId: "t1", target: { type: "x", id: "t1" } } },
      },
    ];
    for (const payload of bad) {
      await expect(
        reportNavigation.handler(
          ctxOf(laptop),
          payload as unknown as Parameters<typeof reportNavigation.handler>[1]
        )
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });
});
