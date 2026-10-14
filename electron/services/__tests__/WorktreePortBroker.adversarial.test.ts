import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type WebContents } from "electron";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";

type MockPort = EventEmitter & { close: ReturnType<typeof vi.fn> };

const { createdChannels, logger } = vi.hoisted(() => ({
  createdChannels: [] as Array<{ port1: MockPort; port2: MockPort }>,
  logger: {
    name: "main:WorktreePortBroker",
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", async () => {
  const { EventEmitter: EE } = await import("events");

  function makePort(): MockPort {
    const ee = new EE() as MockPort;
    ee.close = vi.fn();
    return ee;
  }

  class MockMessageChannelMain {
    port1: MockPort = makePort();
    port2: MockPort = makePort();

    constructor() {
      createdChannels.push(this);
    }
  }

  return {
    MessageChannelMain: MockMessageChannelMain,
    ipcMain: new EE(),
  };
});

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => logger,
}));

import { CHANNELS } from "../../ipc/channels.js";
import { WorktreePortBroker, type WorktreePortHost } from "../WorktreePortBroker.js";

type HostLike = Pick<WorkspaceHostProcess, "projectPath" | "attachWorktreePort">;
type MockWebContents = EventEmitter & {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  setDestroyed: (next: boolean) => void;
  setThrowOnPostMessage: (next: boolean) => void;
};

let nextWebContentsId = 1;

function createHost(projectPath = "/tmp/project", attachResult = true): HostLike {
  return {
    projectPath,
    attachWorktreePort: vi.fn(() => attachResult),
  };
}

function createWebContents(options?: {
  destroyed?: boolean;
  throwOnPostMessage?: boolean;
}): MockWebContents {
  let destroyed = options?.destroyed ?? false;
  let throwOnPostMessage = options?.throwOnPostMessage ?? false;
  const webContents = new EventEmitter() as MockWebContents;

  webContents.id = nextWebContentsId++;
  webContents.isDestroyed = vi.fn(() => destroyed);
  webContents.postMessage = vi.fn(() => {
    if (throwOnPostMessage || destroyed) {
      throw new Error("renderer unavailable");
    }
  });
  webContents.setDestroyed = (next: boolean) => {
    destroyed = next;
  };
  webContents.setThrowOnPostMessage = (next: boolean) => {
    throwOnPostMessage = next;
  };

  return webContents;
}

function asWorkspaceHostProcess(host: HostLike): WorkspaceHostProcess {
  return host as unknown as WorkspaceHostProcess;
}

function asWebContents(webContents: MockWebContents): WebContents {
  return webContents as unknown as WebContents;
}

/** Build the getWebContents lookup reBrokerForHost receives in production
 *  (windowServices.ts wraps webContents.fromId). */
function lookupFrom(views: MockWebContents[]): (wcId: number) => WebContents | undefined {
  return (wcId: number) => {
    const found = views.find((view) => view.id === wcId);
    return found ? asWebContents(found) : undefined;
  };
}

/** The token the broker attached to the renderer's most recent port. */
function lastPostedToken(webContents: MockWebContents): number {
  const payload = webContents.postMessage.mock.lastCall?.[1] as { token: number };
  return payload.token;
}

/** Deliver the preload's receipt through the broker's own ipcMain listener. */
function sendAck(webContents: MockWebContents, payload: unknown): void {
  ipcMain.emit(CHANNELS.WORKTREE_PORT_ACK, { sender: { id: webContents.id } }, payload);
}

describe("WorktreePortBroker adversarial", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
    ipcMain.removeAllListeners();
    vi.clearAllMocks();
  });

  it("closes both channel ports when renderer postMessage fails after host attachment", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents({ throwOnPostMessage: true });

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(false);

    expect(host.attachWorktreePort).toHaveBeenCalledTimes(1);
    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[0].port2.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(webContents.id)).toBe(false);
  });

  it("does not attach a port to a renderer that is already destroyed", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents({ destroyed: true });

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(false);

    expect(host.attachWorktreePort).not.toHaveBeenCalled();
    expect(createdChannels).toHaveLength(0);
  });

  it("reuses the confirmed live channel when the same host and view are brokered again", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    sendAck(webContents, { token: lastPostedToken(webContents) });
    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);

    expect(createdChannels).toHaveLength(1);
    expect(host.attachWorktreePort).toHaveBeenCalledTimes(1);
    expect(createdChannels[0].port1.close).not.toHaveBeenCalled();
    expect(webContents.postMessage).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Worktree port reused", {
      webContentsId: webContents.id,
      projectPath: "/tmp/project",
      token: 1,
    });
  });

  it("posts a fresh port when the renderer never confirmed the first one (#12576)", () => {
    // The cold-start case: the startup post landed before the preload listener
    // existed and was dropped, so the did-finish-load re-broker must not treat
    // the leftover entry as a live channel.
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);

    expect(createdChannels).toHaveLength(2);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[1].port1.close).not.toHaveBeenCalled();
    expect(webContents.postMessage).toHaveBeenLastCalledWith("worktree-port", { token: 2 }, [
      createdChannels[1].port2,
    ]);
    expect(webContents.listenerCount("did-start-navigation")).toBe(1);
    expect(logger.info).toHaveBeenLastCalledWith("Worktree port posted", {
      webContentsId: webContents.id,
      projectPath: "/tmp/project",
      token: 2,
      reason: "unconfirmed",
    });
  });

  it("posts a fresh port over a confirmed one when forced", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    sendAck(webContents, { token: 1 });
    expect(
      broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents), { force: true })
    ).toBe(true);

    expect(createdChannels).toHaveLength(2);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenLastCalledWith(
      "Worktree port posted",
      expect.objectContaining({ token: 2, reason: "forced" })
    );
  });

  it("only confirms the view's current transfer", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const viewA = createWebContents();
    const viewB = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewA));
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewA));
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewB));

    // A receipt for the replaced port, another view's token, and malformed
    // payloads say nothing about the port viewA holds now.
    sendAck(viewA, { token: 1 });
    sendAck(viewA, { token: 3 });
    sendAck(viewA, { token: "2" });
    sendAck(viewA, null);
    sendAck(viewA, undefined);
    expect(broker.confirmPort(viewA.id, 1)).toBe(false);

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewA));
    expect(createdChannels).toHaveLength(4);

    sendAck(viewA, { token: 4 });
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewA));
    expect(createdChannels).toHaveLength(4);
    expect(logger.info).toHaveBeenCalledWith("Worktree port confirmed by renderer", {
      webContentsId: viewA.id,
      projectPath: "/tmp/project",
      token: 4,
    });
  });

  it("drops confirmation when the port closes, so a later broker re-posts", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    sendAck(webContents, { token: 1 });
    broker.closePortsForView(webContents.id);
    sendAck(webContents, { token: 1 });

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    expect(createdChannels).toHaveLength(2);
    expect(logger.info).toHaveBeenLastCalledWith(
      "Worktree port posted",
      expect.objectContaining({ token: 2, reason: "new" })
    );
  });

  it("logs why a port was not brokered", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();

    broker.brokerPort(
      asWorkspaceHostProcess(host),
      asWebContents(createWebContents({ throwOnPostMessage: true }))
    );
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Worktree port not brokered",
      expect.objectContaining({ reason: "post-failed" })
    );

    host.attachWorktreePort = vi.fn(() => false);
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(createWebContents()));
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Worktree port not brokered",
      expect.objectContaining({ reason: "host-rejected" })
    );

    broker.brokerPort(
      asWorkspaceHostProcess(host),
      asWebContents(createWebContents({ destroyed: true }))
    );
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Worktree port not brokered",
      expect.objectContaining({ reason: "webcontents-destroyed" })
    );
  });

  it("keeps the existing entry when the host refuses a replacement", () => {
    // A host in restart backoff has no child to take the port. Retiring the
    // view's entry first would drop it from the reverse map, so the restart's
    // closePortsForHost → reBrokerForHost pass would never reconnect it.
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    sendAck(webContents, { token: 1 });
    host.attachWorktreePort = vi.fn(() => false);

    expect(
      broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents), { force: true })
    ).toBe(false);

    expect(broker.hasPort(webContents.id)).toBe(true);
    expect(createdChannels[0].port1.close).not.toHaveBeenCalled();
    expect(createdChannels[1].port1.close).toHaveBeenCalledTimes(1);
    expect(broker.closePortsForHost("/tmp/project")).toEqual([webContents.id]);
  });

  it("retires a port at the main-frame commit, even one the outgoing document confirmed", () => {
    // Posted after did-start-navigation fired, so only the commit can tell the
    // broker the document that received (and acknowledged) it is gone.
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    sendAck(webContents, { token: 1 });
    webContents.emit("did-navigate", {}, "app://daintree/index.html", 200, "OK");

    expect(broker.hasPort(webContents.id)).toBe(false);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(webContents.listenerCount("did-navigate")).toBe(0);
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
    expect(webContents.listenerCount("destroyed")).toBe(0);

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));
    expect(createdChannels).toHaveLength(2);
    expect(webContents.listenerCount("did-navigate")).toBe(1);
  });

  it("stops listening for receipts on dispose", () => {
    const broker = new WorktreePortBroker();
    expect(ipcMain.listenerCount(CHANNELS.WORKTREE_PORT_ACK)).toBe(1);
    broker.dispose();
    expect(ipcMain.listenerCount(CHANNELS.WORKTREE_PORT_ACK)).toBe(0);
  });

  describe("waitForConfirmation", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves true once the renderer confirms the current port", async () => {
      const broker = new WorktreePortBroker();
      const webContents = createWebContents();
      broker.brokerPort(asWorkspaceHostProcess(createHost()), asWebContents(webContents));

      const confirmation = broker.waitForConfirmation(webContents.id, 10_000);
      sendAck(webContents, { token: 1 });

      await expect(confirmation).resolves.toBe(true);
      await expect(broker.waitForConfirmation(webContents.id, 10_000)).resolves.toBe(true);
    });

    it("resolves false when the port is replaced or closed before a receipt", async () => {
      const broker = new WorktreePortBroker();
      const host = createHost();
      const webContents = createWebContents();
      broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents));

      const replaced = broker.waitForConfirmation(webContents.id, 10_000);
      broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents), { force: true });
      await expect(replaced).resolves.toBe(false);

      const navigatedAway = broker.waitForConfirmation(webContents.id, 10_000);
      webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      await expect(navigatedAway).resolves.toBe(false);
    });

    it("resolves false without tearing anything down when no receipt arrives in time", async () => {
      vi.useFakeTimers();
      const broker = new WorktreePortBroker();
      const webContents = createWebContents();
      broker.brokerPort(asWorkspaceHostProcess(createHost()), asWebContents(webContents));

      const confirmation = broker.waitForConfirmation(webContents.id, 10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(confirmation).resolves.toBe(false);
      expect(broker.hasPort(webContents.id)).toBe(true);
      expect(createdChannels[0].port1.close).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenLastCalledWith(
        "Worktree port not confirmed by renderer",
        expect.objectContaining({ webContentsId: webContents.id, token: 1, timeoutMs: 10_000 })
      );
    });

    it("resolves false for a view with no port", async () => {
      const broker = new WorktreePortBroker();
      await expect(broker.waitForConfirmation(99, 10_000)).resolves.toBe(false);
    });
  });

  it("replaces an existing brokered port without accumulating lifecycle listeners", () => {
    const broker = new WorktreePortBroker();
    const firstHost = createHost("/tmp/project-a");
    const secondHost = createHost("/tmp/project-b");
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(firstHost), asWebContents(webContents))).toBe(
      true
    );
    const firstChannel = createdChannels[0];

    expect(webContents.listenerCount("destroyed")).toBe(1);
    expect(webContents.listenerCount("did-start-navigation")).toBe(1);

    expect(broker.brokerPort(asWorkspaceHostProcess(secondHost), asWebContents(webContents))).toBe(
      true
    );
    const secondChannel = createdChannels[1];

    expect(firstChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(webContents.listenerCount("destroyed")).toBe(1);
    expect(webContents.listenerCount("did-start-navigation")).toBe(1);

    webContents.emit("destroyed");

    expect(secondChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(webContents.id)).toBe(false);
    expect(webContents.listenerCount("destroyed")).toBe(0);
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("does not close the port on same-document main-frame navigation", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    const channel = createdChannels[0];

    webContents.emit("did-start-navigation", {
      url: "https://example.com/#section",
      isSameDocument: true,
      isMainFrame: true,
      frame: null,
      preventDefault: () => {},
      defaultPrevented: false,
    });

    expect(channel.port1.close).not.toHaveBeenCalled();
    expect(broker.hasPort(webContents.id)).toBe(true);
  });

  it("does not close the port on sub-frame navigation", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    const channel = createdChannels[0];

    webContents.emit("did-start-navigation", {
      url: "https://example.com/iframe-content",
      isSameDocument: false,
      isMainFrame: false,
      frame: null,
      preventDefault: () => {},
      defaultPrevented: false,
    });

    expect(channel.port1.close).not.toHaveBeenCalled();
    expect(broker.hasPort(webContents.id)).toBe(true);
  });

  it("does not close view B port when view A navigates cross-document", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/shared-project");
    const viewA = createWebContents();
    const viewB = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewA))).toBe(true);
    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(viewB))).toBe(true);

    const channelA = createdChannels[0];
    const channelB = createdChannels[1];

    viewA.emit("did-start-navigation", {
      url: "https://example.com/new-page",
      isSameDocument: false,
      isMainFrame: true,
      frame: null,
      preventDefault: () => {},
      defaultPrevented: false,
    });

    expect(channelA.port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(viewA.id)).toBe(false);

    expect(channelB.port1.close).not.toHaveBeenCalled();
    expect(broker.hasPort(viewB.id)).toBe(true);
  });

  it("closes the port when port1 emits 'close' (host-side shutdown / transfer failure)", () => {
    // The webContents lifecycle events don't fire when the host-side shuts the
    // port (utility process crash, port transfer failure on the workspace
    // host). port1.on('close') is the authoritative signal for those paths.
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    const channel = createdChannels[0];

    expect(channel.port1.listenerCount("close")).toBe(1);

    channel.port1.emit("close");

    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(webContents.id)).toBe(false);
    // The webContents listeners are also cleaned up via cleanupListeners.
    expect(webContents.listenerCount("destroyed")).toBe(0);
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
    // Re-entrant 'close' on the dead port does nothing (listener removed).
    expect(channel.port1.listenerCount("close")).toBe(0);
  });

  it("removes the old port1 close listener when re-brokering the same view", () => {
    // Re-brokering must not leave a stale onPortClose attached to the old
    // port1 — accumulating listeners across host restarts would leak handlers.
    const broker = new WorktreePortBroker();
    const firstHost = createHost("/tmp/project-a");
    const secondHost = createHost("/tmp/project-b");
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(firstHost), asWebContents(webContents))).toBe(
      true
    );
    const firstChannel = createdChannels[0];
    expect(firstChannel.port1.listenerCount("close")).toBe(1);

    expect(broker.brokerPort(asWorkspaceHostProcess(secondHost), asWebContents(webContents))).toBe(
      true
    );
    const secondChannel = createdChannels[1];

    // First channel's close listener must be gone after re-broker.
    expect(firstChannel.port1.listenerCount("close")).toBe(0);
    // Second channel has exactly one fresh listener.
    expect(secondChannel.port1.listenerCount("close")).toBe(1);

    // Emitting close on the dead first channel must not affect the broker.
    firstChannel.port1.emit("close");
    expect(broker.hasPort(webContents.id)).toBe(true);
    expect(secondChannel.port1.close).not.toHaveBeenCalled();
  });
});

describe("WorktreePortBroker re-broker", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
    ipcMain.removeAllListeners();
  });

  it("posts a fresh port after a host restart even when the host object survives", () => {
    // A restart can respawn the child behind the same WorkspaceHostProcess, so
    // host identity alone can't justify reuse — the restart path's
    // closePortsForHost is what forces the re-post.
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const view = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(view))).toBe(true);
    expect(broker.confirmPort(view.id, 1)).toBe(true);

    const closedIds = broker.closePortsForHost("/tmp/project-a");
    expect(
      broker.reBrokerForHost(asWorkspaceHostProcess(host), lookupFrom([view]), closedIds)
    ).toBe(1);

    expect(createdChannels).toHaveLength(2);
    expect(view.postMessage).toHaveBeenLastCalledWith("worktree-port", { token: 2 }, [
      createdChannels[1].port2,
    ]);
  });

  it("re-brokers every live view against the fresh host after a restart", () => {
    const broker = new WorktreePortBroker();
    const oldHost = createHost("/tmp/project-a");
    const viewA = createWebContents();
    const viewB = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(viewA))).toBe(true);
    expect(broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(viewB))).toBe(true);

    const closedIds = broker.closePortsForHost("/tmp/project-a");
    expect(closedIds).toEqual([viewA.id, viewB.id]);
    expect(broker.hasPort(viewA.id)).toBe(false);
    expect(broker.hasPort(viewB.id)).toBe(false);
    // Old host-side ports are closed so the dead host's transferred ends
    // can't strand the channel.
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[1].port1.close).toHaveBeenCalledTimes(1);

    const freshHost = createHost("/tmp/project-a");
    const reBrokered = broker.reBrokerForHost(
      asWorkspaceHostProcess(freshHost),
      lookupFrom([viewA, viewB]),
      closedIds
    );

    expect(reBrokered).toBe(2);
    expect(broker.hasPort(viewA.id)).toBe(true);
    expect(broker.hasPort(viewB.id)).toBe(true);
    // Two fresh channels, both attached to the NEW host, renderer ends re-posted.
    expect(createdChannels).toHaveLength(4);
    expect(freshHost.attachWorktreePort).toHaveBeenCalledTimes(2);
    expect(oldHost.attachWorktreePort).toHaveBeenCalledTimes(2);
    expect(viewA.postMessage).toHaveBeenCalledTimes(2);
    expect(viewA.postMessage).toHaveBeenLastCalledWith("worktree-port", { token: 3 }, [
      createdChannels[2].port2,
    ]);
  });

  it("skips views destroyed between the host crash and the re-broker (LRU eviction race)", () => {
    const broker = new WorktreePortBroker();
    const oldHost = createHost("/tmp/project-a");
    const evicted = createWebContents();
    const survivor = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(evicted));
    broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(survivor));

    const closedIds = broker.closePortsForHost("/tmp/project-a");
    // The eviction lands while the host is restarting.
    evicted.setDestroyed(true);

    const freshHost = createHost("/tmp/project-a");
    const channelsBefore = createdChannels.length;
    const reBrokered = broker.reBrokerForHost(
      asWorkspaceHostProcess(freshHost),
      lookupFrom([evicted, survivor]),
      closedIds
    );

    // The reported count reflects reality — one view skipped, one restored.
    expect(reBrokered).toBe(1);
    expect(broker.hasPort(evicted.id)).toBe(false);
    expect(broker.hasPort(survivor.id)).toBe(true);
    // Exactly one fresh channel — no port pair minted for the destroyed view.
    expect(createdChannels.length - channelsBefore).toBe(1);
    expect(evicted.postMessage).toHaveBeenCalledTimes(1); // original broker only
  });

  it("skips views whose webContents id no longer resolves", () => {
    const broker = new WorktreePortBroker();
    const oldHost = createHost("/tmp/project-a");
    const view = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(view));
    const closedIds = broker.closePortsForHost("/tmp/project-a");

    const freshHost = createHost("/tmp/project-a");
    // webContents.fromId returns undefined once the renderer is fully gone.
    const reBrokered = broker.reBrokerForHost(
      asWorkspaceHostProcess(freshHost),
      () => undefined,
      closedIds
    );

    expect(reBrokered).toBe(0);
    expect(broker.hasPort(view.id)).toBe(false);
    expect(freshHost.attachWorktreePort).not.toHaveBeenCalled();
  });

  it("one view failing to re-broker does not block the remaining views", () => {
    const broker = new WorktreePortBroker();
    const oldHost = createHost("/tmp/project-a");
    const flaky = createWebContents();
    const healthy = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(flaky));
    broker.brokerPort(asWorkspaceHostProcess(oldHost), asWebContents(healthy));

    const closedIds = broker.closePortsForHost("/tmp/project-a");
    flaky.setThrowOnPostMessage(true);

    const freshHost = createHost("/tmp/project-a");
    const reBrokered = broker.reBrokerForHost(
      asWorkspaceHostProcess(freshHost),
      lookupFrom([flaky, healthy]),
      closedIds
    );

    // A failed brokerPort is not counted as re-brokered.
    expect(reBrokered).toBe(1);
    expect(broker.hasPort(flaky.id)).toBe(false);
    expect(broker.hasPort(healthy.id)).toBe(true);
    // The flaky view's fresh pair is fully closed — no half-open channel.
    const flakyChannel = createdChannels[2];
    expect(flakyChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(flakyChannel.port2.close).toHaveBeenCalledTimes(1);
    // No lifecycle listeners left behind for the failed re-broker.
    expect(flaky.listenerCount("destroyed")).toBe(0);
    expect(flaky.listenerCount("did-start-navigation")).toBe(0);
  });

  it("closes both ports and tracks nothing when the host refuses the attach", () => {
    const broker = new WorktreePortBroker();
    const deadHost = createHost("/tmp/project-a", false);
    const view = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(deadHost), asWebContents(view))).toBe(false);

    expect(broker.hasPort(view.id)).toBe(false);
    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[0].port2.close).toHaveBeenCalledTimes(1);
    // The renderer never saw the port and no lifecycle listeners were attached.
    expect(view.postMessage).not.toHaveBeenCalled();
    expect(view.listenerCount("destroyed")).toBe(0);
    expect(view.listenerCount("did-start-navigation")).toBe(0);

    // A later broker against a live host succeeds from the clean state.
    const liveHost = createHost("/tmp/project-a");
    expect(broker.brokerPort(asWorkspaceHostProcess(liveHost), asWebContents(view))).toBe(true);
    expect(broker.hasPort(view.id)).toBe(true);
  });

  it("keeps ports to other projects intact when one host's ports close", () => {
    const broker = new WorktreePortBroker();
    const hostA = createHost("/tmp/project-a");
    const hostB = createHost("/tmp/project-b");
    // Three windows: two views on project A, one on project B.
    const viewA1 = createWebContents();
    const viewA2 = createWebContents();
    const viewB = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(hostA), asWebContents(viewA1));
    broker.brokerPort(asWorkspaceHostProcess(hostA), asWebContents(viewA2));
    broker.brokerPort(asWorkspaceHostProcess(hostB), asWebContents(viewB));

    const closedIds = broker.closePortsForHost("/tmp/project-a");

    expect(closedIds).toEqual([viewA1.id, viewA2.id]);
    expect(broker.hasPort(viewA1.id)).toBe(false);
    expect(broker.hasPort(viewA2.id)).toBe(false);
    expect(broker.hasPort(viewB.id)).toBe(true);
    // Project B's channel untouched.
    expect(createdChannels[2].port1.close).not.toHaveBeenCalled();
  });

  it("closing an unknown project's ports is a no-op returning an empty snapshot", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const view = createWebContents();
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(view));

    expect(broker.closePortsForHost("/tmp/never-brokered")).toEqual([]);
    expect(broker.hasPort(view.id)).toBe(true);
  });

  it("a view re-brokered to a different project detaches from the old host's reverse map", () => {
    const broker = new WorktreePortBroker();
    const hostA = createHost("/tmp/project-a");
    const hostB = createHost("/tmp/project-b");
    const view = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(hostA), asWebContents(view));
    broker.brokerPort(asWorkspaceHostProcess(hostB), asWebContents(view));

    // A restart of project A must not touch the port now owned by project B.
    expect(broker.closePortsForHost("/tmp/project-a")).toEqual([]);
    expect(broker.hasPort(view.id)).toBe(true);
    expect(broker.closePortsForHost("/tmp/project-b")).toEqual([view.id]);
  });

  it("renderer reload cycle: navigation closes the port, re-broker restores it with one listener set", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const view = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(view));

    // Main-frame cross-document navigation = renderer reload.
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(broker.hasPort(view.id)).toBe(false);
    expect(view.listenerCount("destroyed")).toBe(0);
    expect(view.listenerCount("did-start-navigation")).toBe(0);

    // onViewReady re-brokers after did-finish-load.
    broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(view));
    expect(broker.hasPort(view.id)).toBe(true);
    expect(view.listenerCount("destroyed")).toBe(1);
    expect(view.listenerCount("did-start-navigation")).toBe(1);
    // The stale first channel's close event must not tear down the fresh port.
    createdChannels[0].port1.emit("close");
    expect(broker.hasPort(view.id)).toBe(true);
  });

  it("dispose closes every tracked port across all hosts and removes all listeners", () => {
    const broker = new WorktreePortBroker();
    const hostA = createHost("/tmp/project-a");
    const hostB = createHost("/tmp/project-b");
    const viewA = createWebContents();
    const viewB = createWebContents();

    broker.brokerPort(asWorkspaceHostProcess(hostA), asWebContents(viewA));
    broker.brokerPort(asWorkspaceHostProcess(hostB), asWebContents(viewB));

    broker.dispose();

    expect(broker.hasPort(viewA.id)).toBe(false);
    expect(broker.hasPort(viewB.id)).toBe(false);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[1].port1.close).toHaveBeenCalledTimes(1);
    expect(viewA.listenerCount("destroyed")).toBe(0);
    expect(viewB.listenerCount("destroyed")).toBe(0);
    expect(viewA.listenerCount("did-start-navigation")).toBe(0);
    expect(viewB.listenerCount("did-start-navigation")).toBe(0);
  });
});

describe("WorktreePortBroker endpoint pairs", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
    ipcMain.removeAllListeners();
  });

  it("attaches one end to the host and hands the other to the endpoint", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const receive = vi.fn();

    expect(broker.brokerEndpointPort(asWorkspaceHostProcess(host), -3, receive)).toBe(true);

    const { port1, port2 } = createdChannels[0]!;
    expect(host.attachWorktreePort).toHaveBeenCalledWith(port1);
    expect(receive).toHaveBeenCalledWith(port2);
    expect(broker.hasPort(-3)).toBe(true);
  });

  it("rejects a non-negative handle, which would alias a WebContents id", () => {
    const broker = new WorktreePortBroker();
    expect(() =>
      broker.brokerEndpointPort(asWorkspaceHostProcess(createHost()), 4, vi.fn())
    ).toThrow();
  });

  it("re-brokers an endpoint with a fresh pair after its host restarts", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const receive = vi.fn();
    broker.brokerEndpointPort(asWorkspaceHostProcess(host), -3, receive);

    const closed = broker.closePortsForHost("/tmp/project-a");
    expect(closed).toEqual([-3]);
    expect(createdChannels[0]!.port1.close).toHaveBeenCalled();

    expect(broker.reBrokerForHost(asWorkspaceHostProcess(host), () => undefined, closed)).toBe(1);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenLastCalledWith(createdChannels[1]!.port2);
  });

  it("stops re-brokering an endpoint once it is released", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const receive = vi.fn();
    broker.brokerEndpointPort(asWorkspaceHostProcess(host), -3, receive);

    broker.releaseEndpointPort(-3);
    expect(broker.hasPort(-3)).toBe(false);
    expect(broker.reBrokerForHost(asWorkspaceHostProcess(host), () => undefined, [-3])).toBe(0);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed attach as brokered", () => {
    const broker = new WorktreePortBroker();
    const receive = vi.fn();
    expect(
      broker.brokerEndpointPort(asWorkspaceHostProcess(createHost("/p", false)), -3, receive)
    ).toBe(false);
    expect(receive).not.toHaveBeenCalled();
    expect(broker.hasPort(-3)).toBe(false);
  });
});

describe("WorktreePortBroker host override", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
    ipcMain.removeAllListeners();
  });

  it("routes a claimed view to the override's far end and leaves other views alone", () => {
    const broker = new WorktreePortBroker();
    const localHost = createHost("/tmp/local");
    const relayHost: WorktreePortHost = {
      projectPath: "remote-endpoint:ep",
      attachWorktreePort: vi.fn(() => true),
    };
    const remoteView = createWebContents();
    const localView = createWebContents();
    const uninstall = broker.setHostOverride((wcId) => (wcId === remoteView.id ? relayHost : null));

    broker.brokerPort(asWorkspaceHostProcess(localHost), remoteView as unknown as WebContents);
    expect(relayHost.attachWorktreePort).toHaveBeenCalledWith(createdChannels[0]!.port1);
    expect(localHost.attachWorktreePort).not.toHaveBeenCalled();
    expect(remoteView.postMessage).toHaveBeenCalledWith("worktree-port", { token: 1 }, [
      createdChannels[0]!.port2,
    ]);

    broker.brokerPort(asWorkspaceHostProcess(localHost), localView as unknown as WebContents);
    expect(localHost.attachWorktreePort).toHaveBeenCalledTimes(1);

    uninstall();
    broker.brokerPort(asWorkspaceHostProcess(localHost), remoteView as unknown as WebContents);
    expect(localHost.attachWorktreePort).toHaveBeenCalledTimes(2);
  });
});

const PRELOAD_CTS = path.resolve(__dirname, "../../preload.cts");

/**
 * The broker only reuses a port the renderer has acknowledged (#12576), and its
 * suites fabricate those receipts — so they would keep passing if the preload
 * stopped sending them. This pins the preload half of the handshake.
 */
describe("preload worktree port receipt", () => {
  let listener: string;

  beforeAll(async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    const start = source.indexOf('ipcRenderer.on("worktree-port"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n});", start);
    expect(end).toBeGreaterThan(start);
    listener = source.slice(start, end);
  });

  it("acknowledges the transfer on the receipt channel with the broker's token", () => {
    expect(listener).toContain("ipcRenderer.send(CHANNELS.WORKTREE_PORT_ACK, { token })");
    expect(listener).toMatch(/typeof token === "number"/);
  });

  it("acknowledges only after attaching, so the ready callbacks have already run", () => {
    // Retry resolves on this receipt; the ready callbacks it follows are what
    // restart the renderer's fetch and put the skeleton back up.
    const attachIdx = listener.indexOf("worktreePortClient.attach(event.ports[0])");
    const ackIdx = listener.indexOf("CHANNELS.WORKTREE_PORT_ACK");
    expect(attachIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeGreaterThan(attachIdx);
  });

  it("sends nothing for a message that carried no port", () => {
    const guardIdx = listener.indexOf("if (!event.ports || event.ports.length === 0) return;");
    const ackIdx = listener.indexOf("CHANNELS.WORKTREE_PORT_ACK");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(ackIdx);
  });
});

/**
 * A request made before the port arrives is rejected in preload and never
 * reaches the broker, so this warning is main's only record of it (#12759).
 */
describe("preload worktree request without a port", () => {
  let branch: string;

  beforeAll(async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    const start = source.indexOf("if (!this.port) {\n      // Main can't see this rejection");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    expect(end).toBeGreaterThan(start);
    branch = source.slice(start, end);
  });

  it("warns with the requested action before rejecting", () => {
    const warnIdx = branch.indexOf(
      'console.warn(`[Preload] Worktree port request "${String(action)}" rejected: port not ready`)'
    );
    const rejectIdx = branch.indexOf('new BrokerError("HOST_EXITED", "Worktree port not ready")');
    expect(warnIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(warnIdx);
  });
});
