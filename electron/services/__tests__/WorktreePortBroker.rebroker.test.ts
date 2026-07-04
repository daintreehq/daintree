/**
 * WorktreePortBroker — host-restart re-broker path and multi-host isolation.
 *
 * Complements WorktreePortBroker.adversarial.test.ts (single-host lifecycle,
 * navigation filtering, listener accounting). This file covers the paths that
 * run when a workspace host crashes and restarts while views hold live ports:
 * closePortsForHost → reBrokerForHost, the destroyed-view skip, the
 * attachWorktreePort-false failure branch, and cross-project port isolation.
 */

import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";

type MockPort = EventEmitter & { close: ReturnType<typeof vi.fn> };

const { createdChannels } = vi.hoisted(() => ({
  createdChannels: [] as Array<{ port1: MockPort; port2: MockPort }>,
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
  };
});

import { WorktreePortBroker } from "../WorktreePortBroker.js";

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

function createWebContents(options?: { destroyed?: boolean }): MockWebContents {
  let destroyed = options?.destroyed ?? false;
  let throwOnPostMessage = false;
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

describe("WorktreePortBroker re-broker", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
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
    expect(viewA.postMessage).toHaveBeenLastCalledWith("worktree-port", null, [
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
