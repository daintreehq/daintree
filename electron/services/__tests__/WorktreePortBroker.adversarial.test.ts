import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";

const { createdChannels } = vi.hoisted(() => ({
  createdChannels: [] as Array<{
    port1: { close: ReturnType<typeof vi.fn> };
    port2: { close: ReturnType<typeof vi.fn> };
  }>,
}));

vi.mock("electron", () => {
  class MockMessageChannelMain {
    port1 = { close: vi.fn() };
    port2 = { close: vi.fn() };

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

describe("WorktreePortBroker adversarial", () => {
  beforeEach(() => {
    createdChannels.length = 0;
    nextWebContentsId = 1;
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
});
