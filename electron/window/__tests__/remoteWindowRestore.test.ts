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
  REMOTE_RESTORE_REDIAL_MAX_MS,
  REMOTE_RESTORE_REDIAL_MS,
  REMOTE_RESTORE_RETRY_CHANNEL,
  forgetRemoteRestoresForHost,
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
  type State = { status: string; [key: string]: unknown };
  const listeners = new Set<(hostId: string, state: State) => void>();
  const client = {
    list: vi.fn(() => [{ descriptor: { id: "studio-01", name: "Studio" } }]),
    switchWindowToHostProject: vi.fn(switchImpl),
    connect: vi.fn(() => ({ status: "connecting" })),
    hasPendingSwitch: vi.fn((_windowId: number) => false),
    onConnectionChange: vi.fn((listener: (hostId: string, state: State) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    /** Test hook: the host's connection changed. */
    changed: (hostId: string, state: string | State) => {
      const next = typeof state === "string" ? { status: state } : state;
      for (const listener of [...listeners]) listener(hostId, next);
    },
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

  it("lets go of a window's place on the host when another window has that project by now", async () => {
    fakeClient(async () => ({
      outcome: "focused-elsewhere",
      hostId: "studio-01",
      projectId: PROJECT,
      targetWindowId: 9,
    }));
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d, onRestored, sent } = deps(new Set([3]));
    await restoreRemoteWindows(d);
    expect(getPendingRemoteRestore(3)).toBeNull();
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
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
      hostSwitchFailure: { hostId: "studio-01", projectId: PROJECT, code: "HOST_DISCONNECTED" },
    });
    expect(getPendingRemoteRestore(3)).toBe(KEY);
    warn.mockRestore();
  });

  describe("a window whose host couldn't be reached (#13389 follow-up)", () => {
    const unreachable = () =>
      new AppError({
        code: "HOST_MODE_OFF",
        message: "Daintree isn't running on studio-01",
        userMessage: "Daintree isn't running on that host.",
      });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("moves back by itself once the host connects, saying so once", async () => {
      let attempts = 0;
      const client = fakeClient(async () => {
        attempts++;
        if (attempts === 1) throw unreachable();
        return { outcome: "switched" };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      const { d, sent, onRestored } = deps(new Set([3]));
      await restoreRemoteWindows(d);
      expect(sent).toHaveLength(1);
      expect((sent[0]!.payload as { message: string }).message).toContain(
        "moves back once Studio is reachable"
      );

      client.changed("studio-02", "connected");
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(1);
      client.changed("studio-01", "connected");
      await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(1);
      warn.mockRestore();
    });

    it("dials the host again while a window waits, and stops once the window is put to use", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      const waitingWindows = new Set([3]);
      const { d } = deps(waitingWindows);
      await restoreRemoteWindows(d);
      expect(client.connect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS);
      expect(client.connect).toHaveBeenCalledWith({ hostId: "studio-01" });

      waitingWindows.delete(3);
      client.connect.mockClear();
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS * 2);
      expect(client.connect).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("never re-dials a host that refuses ssh access: only the person can fix that", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw new AppError({
          code: "HOST_SSH_ACCESS_DENIED",
          message: "Permission denied (publickey)",
          userMessage: "Studio refused the ssh login.",
        });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS * 2);
      expect(client.connect).not.toHaveBeenCalled();
      // A fix made outside still brings it back when the host connects.
      client.changed("studio-01", "connected");
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it("retries on a move into connected only, never on each ping of a connected link", async () => {
      let attempts = 0;
      const client = fakeClient(async () => {
        attempts++;
        throw attempts === 1
          ? unreachable()
          : new AppError({ code: "INTERNAL", message: "view failed", userMessage: "x" });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      client.changed("studio-01", "connected");
      await vi.waitFor(() => expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(2));
      client.changed("studio-01", { status: "connected", rttMs: 4 });
      client.changed("studio-01", { status: "connected", rttMs: 5 });
      await Promise.resolve();
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(2);
      client.changed("studio-01", "disconnected");
      client.changed("studio-01", "connected");
      await vi.waitFor(() => expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(3));
      warn.mockRestore();
    });

    it("gives way to a switch the person started in that window", async () => {
      const client = fakeClient(async () => {
        throw unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      client.hasPendingSwitch.mockReturnValue(true);
      client.changed("studio-01", "connected");
      await Promise.resolve();
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("stops dialling once a later attempt finds ssh refused, or a build it can't talk to", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      client.changed("studio-01", {
        status: "unreachable",
        lastSeenAt: null,
        detail: "Permission denied",
        stoppedRetrying: true,
      });
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MAX_MS * 2);
      expect(client.connect).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("never dials again for a host whose build can't talk to this one", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw new AppError({
          code: "HOST_VERSION_MISMATCH",
          message: "protocol",
          userMessage: "x",
        });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MAX_MS * 2);
      expect(client.connect).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("lets go of the host's place when the project is gone from it", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw new AppError({ code: "NOT_FOUND", message: "gone", userMessage: "x" });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      expect(getPendingRemoteRestore(3)).toBeNull();
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MAX_MS);
      expect(client.connect).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("backs off while the host stays away, and forgets a removed host", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS);
      expect(client.connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS);
      expect(client.connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS);
      expect(client.connect).toHaveBeenCalledTimes(2);

      forgetRemoteRestoresForHost("studio-01");
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MAX_MS * 2);
      expect(client.connect).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it("lets a switch the person started win over the first restore attempt", async () => {
      const client = fakeClient(async () => ({ outcome: "switched" }));
      client.hasPendingSwitch.mockReturnValue(true);
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      expect(client.switchWindowToHostProject).not.toHaveBeenCalled();
      expect(getPendingRemoteRestore(3)).toBeNull();
    });

    it("dials again after a connection lifts an earlier refusal, starting the backoff over", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const client = fakeClient(async () => {
        attempts++;
        throw attempts === 1
          ? new AppError({ code: "HOST_SSH_ACCESS_DENIED", message: "denied", userMessage: "x" })
          : unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MAX_MS);
      expect(client.connect).not.toHaveBeenCalled();
      // The person fixed ssh and connected; the retry fails, and the host goes away again.
      client.changed("studio-01", "connected");
      await vi.waitFor(() => expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(2));
      client.changed("studio-01", {
        status: "unreachable",
        lastSeenAt: null,
        detail: null,
        hostModeOff: true,
      });
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS * 2);
      expect(client.connect).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("promises nothing for a project gone from the host", async () => {
      fakeClient(async () => {
        throw new AppError({
          code: "NOT_FOUND",
          message: "gone",
          userMessage: "This project isn't on that host.",
        });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      const { d, sent } = deps(new Set([3]));
      await restoreRemoteWindows(d);
      expect((sent[0]!.payload as { message: string }).message).toContain(
        "The window opened on this machine instead."
      );
      warn.mockRestore();
    });

    it("doesn't read the first ping of a host already connected as a reconnect", async () => {
      let attempts = 0;
      const client = fakeClient(async () => {
        attempts++;
        throw new AppError({ code: "INTERNAL", message: "view failed", userMessage: "x" });
      });
      client.list.mockReturnValue([
        { descriptor: { id: "studio-01", name: "Studio" }, connection: { status: "connected" } },
      ] as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      client.changed("studio-01", { status: "connected", rttMs: 3 });
      await Promise.resolve();
      expect(attempts).toBe(1);
      warn.mockRestore();
    });

    it("stops waiting for a window that closed", async () => {
      vi.useFakeTimers();
      const client = fakeClient(async () => {
        throw unreachable();
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      noteRemoteWindowRestore(3, KEY);
      remoteWindowReady(3);
      await restoreRemoteWindows(deps(new Set([3])).d);
      forgetRemoteWindowRestore(3);
      await vi.advanceTimersByTimeAsync(REMOTE_RESTORE_REDIAL_MS * 2);
      client.changed("studio-01", "connected");
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.switchWindowToHostProject).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  it("names the failure for the shared presenter, so ssh refusals aren't offered a bare Retry", async () => {
    fakeClient(async () => {
      throw new AppError({
        code: "HOST_SSH_ACCESS_DENIED",
        message: "ssh couldn't log in to Studio",
        userMessage: "ssh couldn't log in to Studio: Permission denied (publickey).",
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d, sent } = deps(new Set([3]));
    await restoreRemoteWindows(d);
    expect(sent[0]!.payload).toMatchObject({
      message: expect.stringContaining("Permission denied (publickey)"),
      hostSwitchFailure: {
        hostId: "studio-01",
        projectId: PROJECT,
        code: "HOST_SSH_ACCESS_DENIED",
      },
    });
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

  it("offers no Retry, and keeps no place, for a host removed while it was being reached", async () => {
    const client = fakeClient(async () => {
      client.list.mockReturnValue([]);
      throw new AppError({ code: "NOT_FOUND", message: "No host with id studio-01" });
    });
    noteRemoteWindowRestore(3, KEY);
    remoteWindowReady(3);
    const { d, sent } = deps(new Set([3]));
    await restoreRemoteWindows(d);
    expect(sent).toEqual([]);
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
