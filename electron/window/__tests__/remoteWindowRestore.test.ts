import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({ getActiveShutdown: () => null }));
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: () => {},
}));

import { AppError } from "../../utils/errorTypes.js";
import { CHANNELS } from "../../ipc/channels.js";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../remote/runtime.js";
import {
  clearPendingRemoteRestore,
  getPendingRemoteRestore,
  resetOpenWindowsTrackerForTests,
} from "../openWindowsTracker.js";
import {
  REMOTE_RESTORE_RETRY_CHANNEL,
  forgetRemoteWindowRestore,
  noteRemoteWindowRestore,
  remoteWindowReady,
  resetRemoteWindowRestoreForTests,
  restoreRemoteWindows,
  type RemoteWindowRestoreDeps,
} from "../remoteWindowRestore.js";

const PROJECT = "a".repeat(64);
const KEY = `studio-01:${PROJECT}`;

function fakeClient(switchImpl: (...args: unknown[]) => Promise<unknown>) {
  const client = {
    list: vi.fn(() => [{ descriptor: { id: "studio-01", name: "Studio" } }]),
    switchWindowToHostProject: vi.fn(switchImpl),
  };
  registerRemoteService("remoteHostsClient", client as never);
  return client;
}

function deps(waitingWindows: Set<number>) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const view = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  };
  const onRestored = vi.fn();
  const d: RemoteWindowRestoreDeps = {
    isWindowWaiting: (windowId) => waitingWindows.has(windowId),
    viewOf: () => view as never,
    onRestored,
  };
  return { d, sent, onRestored };
}

beforeEach(() => {
  resetOpenWindowsTrackerForTests();
  resetRemoteWindowRestoreForTests();
  _resetRemoteServicesForTest();
});

afterEach(() => {
  _resetRemoteServicesForTest();
});

describe("restoreRemoteWindows", () => {
  it("puts a restored window back on its host's project", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d, onRestored } = deps(new Set([3]));
    await restoreRemoteWindows(d);
    expect(client.switchWindowToHostProject).toHaveBeenCalledWith(
      3,
      "studio-01",
      PROJECT,
      expect.any(Function)
    );
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("leaves a window alone once the person has opened something in it", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d } = deps(new Set());
    await restoreRemoteWindows(d);
    expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
  });

  it("asks the switch to give way if the person opens something while the host connects", async () => {
    const waiting = new Set([3]);
    let stillWanted: (() => boolean) | undefined;
    fakeClient(async (_w, _h, _p, wanted) => {
      stillWanted = wanted as () => boolean;
      return { outcome: "superseded" };
    });
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    await restoreRemoteWindows(deps(waiting).d);
    expect(stillWanted?.()).toBe(true);
    waiting.delete(3);
    expect(stillWanted?.()).toBe(false);
  });

  it("keeps the window here with a Retry, and its place on the host, when the host is down", async () => {
    fakeClient(async () => {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: "Host studio-01 did not connect (timeout)",
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d, sent } = deps(new Set([3]));
    await restoreRemoteWindows(d);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(CHANNELS.NOTIFICATION_SHOW_TOAST);
    expect(sent[0]!.payload).toMatchObject({
      type: "error",
      title: "Couldn't reopen this window on Studio",
      message: expect.stringContaining("Couldn't reach this host."),
      action: {
        label: "Retry",
        ipcChannel: REMOTE_RESTORE_RETRY_CHANNEL,
        data: JSON.stringify({ hostId: "studio-01", projectId: PROJECT }),
      },
    });
    expect(getPendingRemoteRestore(3)).toBe(KEY);
    warn.mockRestore();
  });

  it("drops the intent for a host removed from this device, without dialling anything", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    client.list.mockReturnValue([]);
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    await restoreRemoteWindows(deps(new Set([3])).d);
    expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
    expect(getPendingRemoteRestore(3)).toBeNull();
  });

  it("forgets a window that closed before Remote Hosts came up", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    forgetRemoteWindowRestore(3);
    await restoreRemoteWindows(deps(new Set([3])).d);
    expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
  });

  it("restores a window that finishes setting up after Remote Hosts came up (a crash recovery's fleet)", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    const { d, onRestored } = deps(new Set([4]));
    await restoreRemoteWindows(d);
    noteRemoteWindowRestore(4, KEY);
    expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
    remoteWindowReady(4);
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(client.switchWindowToHostProject).toHaveBeenCalledWith(
      4,
      "studio-01",
      PROJECT,
      expect.any(Function)
    );
  });

  it("waits for a window still setting up when the pass runs", async () => {
    const client = fakeClient(async () => ({ outcome: "switched" }));
    noteRemoteWindowRestore(5, KEY);
    await restoreRemoteWindows(deps(new Set([5])).d);
    expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
    remoteWindowReady(5);
    await vi.waitFor(() => expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(1));
  });

  it("keeps the window's place on the host when a save during the failed load spent it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeClient(async () => {
      // The view showed the host's project long enough for a save, then rolled back.
      clearPendingRemoteRestore(3);
      throw new Error("view failed to load");
    });
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    await restoreRemoteWindows(deps(new Set([3])).d);
    expect(getPendingRemoteRestore(3)).toBe(KEY);
    warn.mockRestore();
  });

  it("does nothing where Remote Hosts never started", async () => {
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    await expect(restoreRemoteWindows(deps(new Set([3])).d)).resolves.toBeUndefined();
    expect(getPendingRemoteRestore(3)).toBe(KEY);
  });
});
