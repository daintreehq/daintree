import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/user-data"), on: vi.fn(), isPackaged: false },
  session: { defaultSession: { clearCache: vi.fn(() => Promise.resolve()) } },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => undefined), getAllWebContents: () => [] },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}));

// The real helper, so its origin filter is what these pushes go through.
vi.mock("../../ipc/handlers.js", async () => ({
  sendToRenderer: (await import("../../ipc/utils.js")).sendToRenderer,
}));
vi.mock("../../menu.js", () => ({ createApplicationMenu: vi.fn() }));
vi.mock("../../setup/environment.js", () => ({ isDemoMode: false }));
vi.mock("../../services/PtyClient.js", () => ({ PtyClient: class {} }));
vi.mock("../../services/CliAvailabilityService.js", () => ({ CliAvailabilityService: class {} }));
vi.mock("../../services/AgentVersionService.js", () => ({ AgentVersionService: class {} }));
vi.mock("../../services/AgentModelCatalogService.js", () => ({
  AgentModelCatalogService: class {},
}));
vi.mock("../../services/AgentUpdateHandler.js", () => ({ AgentUpdateHandler: class {} }));
vi.mock("../../services/PortalManager.js", () => ({ PortalManager: class {} }));
vi.mock("../../services/EventBuffer.js", () => ({ EventBuffer: class {} }));
vi.mock("../../services/ProjectSwitchService.js", () => ({ ProjectSwitchService: class {} }));
vi.mock("../../services/NotificationService.js", () => ({ notificationService: {} }));
vi.mock("../../services/ProjectStore.js", () => ({ projectStore: {} }));
vi.mock("../portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
  releaseAllTerminalWorkerPorts: vi.fn(),
}));

vi.mock("../webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webContentsRegistry.js")>();
  return { ...actual, getAppWebContents: vi.fn((win: { wc: unknown }) => win.wc) };
});

import { wireWatchdogDisabledBroadcast } from "../perWindowInit.js";
import {
  getEndpointRegistry,
  _resetEndpointRegistryForTesting,
} from "../../ipc/endpointRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import { setRemoteBoundViewFilter } from "../../ipc/utils.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import type { MainProcessWatchdogClient } from "../../services/MainProcessWatchdogClient.js";
import type { WindowRegistry } from "../WindowRegistry.js";

function remoteEndpoint(handle: number) {
  const endpoint: ClientEndpoint = {
    endpointId: `remote:${handle}`,
    clientId: "client-b",
    projectId: "proj-1",
    kind: "remote-view",
    handle,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
  return endpoint;
}

describe("watchdog:disabled push", () => {
  let fire: (payload: unknown) => void;
  const client = {
    onDisabled: (cb: (payload: unknown) => void) => {
      fire = cb;
    },
  } as unknown as MainProcessWatchdogClient;

  beforeEach(() => {
    _resetEndpointRegistryForTesting();
  });

  it("reaches this machine's windows and every view attached over a link", () => {
    const wc = { isDestroyed: () => false, send: vi.fn() };
    const registry = {
      all: () => [{ browserWindow: { isDestroyed: () => false, wc } }],
    } as unknown as WindowRegistry;
    const remote = remoteEndpoint(-1);
    getEndpointRegistry().add(remote);
    wireWatchdogDisabledBroadcast(client, registry);

    fire({ reason: "cap" });

    const event = { name: "watchdog:disabled", payload: { reason: "cap" } };
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, event);
    expect(remote.send).toHaveBeenCalledWith({
      type: "event",
      channel: CHANNELS.EVENTS_PUSH,
      args: [event],
    });
  });

  it("never reaches a window here that is attached to a remote host", () => {
    const remoteBound = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const local = { id: 2, isDestroyed: () => false, send: vi.fn() };
    const registry = {
      all: () => [
        { browserWindow: { isDestroyed: () => false, wc: remoteBound } },
        { browserWindow: { isDestroyed: () => false, wc: local } },
      ],
    } as unknown as WindowRegistry;
    const uninstall = setRemoteBoundViewFilter((webContentsId) => webContentsId !== 1);
    wireWatchdogDisabledBroadcast(client, registry);

    fire({ reason: "cap" });
    uninstall();

    expect(remoteBound.send).not.toHaveBeenCalled();
    expect(local.send).toHaveBeenCalledTimes(1);
  });

  it("still reaches remote views on a host with no window registry", () => {
    const remote = remoteEndpoint(-2);
    getEndpointRegistry().add(remote);
    wireWatchdogDisabledBroadcast(client, undefined);

    fire({ reason: "cap" });

    expect(remote.send).toHaveBeenCalledTimes(1);
  });
});
