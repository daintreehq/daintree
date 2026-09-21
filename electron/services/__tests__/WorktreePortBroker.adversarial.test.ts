import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { WorktreePortBroker } from "../WorktreePortBroker.js";

type HostLike = Pick<WorkspaceHostProcess, "projectPath" | "attachWorktreePort">;
type MockWebContents = EventEmitter & {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  setDestroyed: (next: boolean) => void;
};

let nextWebContentsId = 1;

function createHost(projectPath = "/tmp/project"): HostLike {
  return {
    projectPath,
    attachWorktreePort: vi.fn(() => true),
  };
}

function createWebContents(options?: {
  destroyed?: boolean;
  throwOnPostMessage?: boolean;
}): MockWebContents {
  let destroyed = options?.destroyed ?? false;
  const webContents = new EventEmitter() as MockWebContents;

  webContents.id = nextWebContentsId++;
  webContents.isDestroyed = vi.fn(() => destroyed);
  webContents.postMessage = vi.fn(() => {
    if (options?.throwOnPostMessage || destroyed) {
      throw new Error("renderer unavailable");
    }
  });
  webContents.setDestroyed = (next: boolean) => {
    destroyed = next;
  };

  return webContents;
}

function asWorkspaceHostProcess(host: HostLike): WorkspaceHostProcess {
  return host as unknown as WorkspaceHostProcess;
}

function asWebContents(webContents: MockWebContents): WebContents {
  return webContents as unknown as WebContents;
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

  it("closes every brokered view for the same host and returns a stable snapshot of ids", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/shared-project");
    const firstView = createWebContents();
    const secondView = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(firstView))).toBe(true);
    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(secondView))).toBe(true);

    const closedIds = broker.closePortsForHost(host.projectPath);

    expect(closedIds).toEqual([firstView.id, secondView.id]);
    expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(createdChannels[1].port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(firstView.id)).toBe(false);
    expect(broker.hasPort(secondView.id)).toBe(false);
  });

  it("closes the port on cross-document main-frame navigation", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    const channel = createdChannels[0];

    webContents.emit("did-start-navigation", {
      url: "https://example.com/new-page",
      isSameDocument: false,
      isMainFrame: true,
      frame: null,
      preventDefault: () => {},
      defaultPrevented: false,
    });

    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(webContents.id)).toBe(false);
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

  it("handles navigation after webContents is destroyed without throwing", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);

    webContents.setDestroyed(true);
    webContents.emit("destroyed");

    expect(() => {
      webContents.emit("did-start-navigation", {
        url: "https://example.com/late-navigation",
        isSameDocument: false,
        isMainFrame: true,
        frame: null,
        preventDefault: () => {},
        defaultPrevented: false,
      });
    }).not.toThrow();
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

  it("cleans up the active port when a renderer crashes after brokering", () => {
    const broker = new WorktreePortBroker();
    const host = createHost();
    const webContents = createWebContents();

    expect(broker.brokerPort(asWorkspaceHostProcess(host), asWebContents(webContents))).toBe(true);
    const channel = createdChannels[0];

    webContents.setDestroyed(true);
    webContents.emit("destroyed");

    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(broker.hasPort(webContents.id)).toBe(false);
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
