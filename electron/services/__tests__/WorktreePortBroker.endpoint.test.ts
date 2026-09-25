/**
 * WorktreePortBroker — remote hosts: endpoint pairs whose far end stays in
 * Main (relayed over the link) and the per-view host override that routes a
 * remote view's re-brokers to its relay instead of a local workspace host.
 */

import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type WebContents } from "electron";
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
    ipcMain: new EE(),
  };
});

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    name: "test",
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { WorktreePortBroker, type WorktreePortHost } from "../WorktreePortBroker.js";

function createHost(projectPath = "/tmp/project", attachResult = true) {
  return {
    projectPath,
    attachWorktreePort: vi.fn(() => attachResult),
  };
}

function asHost(host: ReturnType<typeof createHost>): WorkspaceHostProcess {
  return host as unknown as WorkspaceHostProcess;
}

let nextWebContentsId = 1;

function createWebContents() {
  const wc = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
    postMessage: ReturnType<typeof vi.fn>;
  };
  wc.id = nextWebContentsId++;
  wc.isDestroyed = () => false;
  wc.postMessage = vi.fn();
  return wc;
}

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

    expect(broker.brokerEndpointPort(asHost(host), -3, receive)).toBe(true);

    const { port1, port2 } = createdChannels[0]!;
    expect(host.attachWorktreePort).toHaveBeenCalledWith(port1);
    expect(receive).toHaveBeenCalledWith(port2);
    expect(broker.hasPort(-3)).toBe(true);
  });

  it("rejects a non-negative handle, which would alias a WebContents id", () => {
    const broker = new WorktreePortBroker();
    expect(() => broker.brokerEndpointPort(asHost(createHost()), 4, vi.fn())).toThrow();
  });

  it("re-brokers an endpoint with a fresh pair after its host restarts", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const receive = vi.fn();
    broker.brokerEndpointPort(asHost(host), -3, receive);

    const closed = broker.closePortsForHost("/tmp/project-a");
    expect(closed).toEqual([-3]);
    expect(createdChannels[0]!.port1.close).toHaveBeenCalled();

    expect(broker.reBrokerForHost(asHost(host), () => undefined, closed)).toBe(1);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenLastCalledWith(createdChannels[1]!.port2);
  });

  it("stops re-brokering an endpoint once it is released", () => {
    const broker = new WorktreePortBroker();
    const host = createHost("/tmp/project-a");
    const receive = vi.fn();
    broker.brokerEndpointPort(asHost(host), -3, receive);

    broker.releaseEndpointPort(-3);
    expect(broker.hasPort(-3)).toBe(false);
    expect(broker.reBrokerForHost(asHost(host), () => undefined, [-3])).toBe(0);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed attach as brokered", () => {
    const broker = new WorktreePortBroker();
    const receive = vi.fn();
    expect(broker.brokerEndpointPort(asHost(createHost("/p", false)), -3, receive)).toBe(false);
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

    broker.brokerPort(asHost(localHost), remoteView as unknown as WebContents);
    expect(relayHost.attachWorktreePort).toHaveBeenCalledWith(createdChannels[0]!.port1);
    expect(localHost.attachWorktreePort).not.toHaveBeenCalled();
    expect(remoteView.postMessage).toHaveBeenCalledWith("worktree-port", { token: 1 }, [
      createdChannels[0]!.port2,
    ]);

    broker.brokerPort(asHost(localHost), localView as unknown as WebContents);
    expect(localHost.attachWorktreePort).toHaveBeenCalledTimes(1);

    uninstall();
    broker.brokerPort(asHost(localHost), remoteView as unknown as WebContents);
    expect(localHost.attachWorktreePort).toHaveBeenCalledTimes(2);
  });
});
