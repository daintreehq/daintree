import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const broker = {
    override: null as ((wcId: number) => unknown) | null,
    setHostOverride: vi.fn((fn: (wcId: number) => unknown) => {
      broker.override = fn;
      return () => {
        if (broker.override === fn) broker.override = null;
      };
    }),
    brokerEndpointPort: vi.fn((_host: unknown, _handle: number, _receive: unknown) => true),
    receivers: new Map<number, unknown>(),
    expectEndpointPort: vi.fn((handle: number, receive: unknown) => {
      broker.receivers.set(handle, receive);
    }),
    connectEndpointPort: vi.fn((host: unknown, handle: number) =>
      broker.brokerEndpointPort(host, handle, broker.receivers.get(handle))
    ),
    releaseEndpointPort: vi.fn(),
    brokerPort: vi.fn(() => true),
    closePortsForView: vi.fn(),
  };
  return {
    broker,
    workspaceHost: null as unknown,
    projects: new Map<string, { path: string }>([["p1", { path: "/srv/p1" }]]),
  };
});

vi.mock("../../../window/serviceRefs.js", () => ({
  getWorktreePortBrokerRef: () => m.broker,
  getWorkspaceClientRef: () => ({
    getHostForProject: (path: string) => (path === "/srv/p1" ? m.workspaceHost : undefined),
  }),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => m.projects.get(id) ?? null },
}));
vi.mock("../../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({ onChange: () => () => {} }),
}));

import {
  attachClientWorktreeRelay,
  attachWorktreePortBridge,
  detachWorktreePortBridge,
  disposeAllClientWorktreeRelays,
  installClientWorktreePortOverride,
  redeliverClientWorktreePort,
} from "../attach.js";
import type { RemoteStreamEndpoint } from "../../terminal/hostAttach.js";
import type { WorktreePortHost } from "../../../services/WorktreePortBroker.js";
import { fakeSession, fakeWebContents } from "../../terminal/__tests__/fakeSession.js";

function fakeEndpoint(endpointId: string): RemoteStreamEndpoint {
  return {
    endpointId,
    clientEndpointId: endpointId.split(":").at(-1)!,
    handle: -5,
    projectId: "p1",
    isClosed: () => false,
    onClose: () => ({ dispose: () => {} }),
  } as unknown as RemoteStreamEndpoint;
}

beforeEach(() => {
  vi.useFakeTimers();
  m.workspaceHost = null;
  vi.clearAllMocks();
});

afterEach(() => {
  detachWorktreePortBridge("remote:s1:view-11");
  disposeAllClientWorktreeRelays();
  vi.useRealTimers();
});

const retry = { retryInitialMs: 10, retryMaxMs: 40, retryAttempts: 10 };

describe("host worktree bridge attach", () => {
  it("connects at once when the project's workspace host is resident", () => {
    m.workspaceHost = { projectPath: "/srv/p1" };
    attachWorktreePortBridge(fakeSession(), fakeEndpoint("remote:s1:view-11"), retry);
    expect(m.broker.brokerEndpointPort).toHaveBeenCalledTimes(1);
  });

  it("retries until the project's workspace host is ready instead of giving up", () => {
    attachWorktreePortBridge(fakeSession(), fakeEndpoint("remote:s1:view-11"), retry);
    expect(m.broker.brokerEndpointPort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(m.broker.brokerEndpointPort).not.toHaveBeenCalled();

    m.workspaceHost = { projectPath: "/srv/p1" };
    vi.advanceTimersByTime(40);
    expect(m.broker.brokerEndpointPort).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(m.broker.brokerEndpointPort).toHaveBeenCalledTimes(1);
  });

  it("retries a host that refuses the port while it restarts", () => {
    m.workspaceHost = { projectPath: "/srv/p1" };
    m.broker.brokerEndpointPort.mockReturnValueOnce(false);
    attachWorktreePortBridge(fakeSession(), fakeEndpoint("remote:s1:view-11"), retry);
    vi.advanceTimersByTime(10);
    expect(m.broker.brokerEndpointPort).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once the endpoint's bridge is gone", () => {
    attachWorktreePortBridge(fakeSession(), fakeEndpoint("remote:s1:view-11"), retry);
    detachWorktreePortBridge("remote:s1:view-11");
    m.workspaceHost = { projectPath: "/srv/p1" };
    vi.advanceTimersByTime(1_000);
    expect(m.broker.brokerEndpointPort).not.toHaveBeenCalled();
  });

  it("gives up after its attempts are spent", () => {
    attachWorktreePortBridge(fakeSession(), fakeEndpoint("remote:s1:view-11"), {
      ...retry,
      retryAttempts: 2,
    });
    vi.advanceTimersByTime(10_000);
    m.workspaceHost = { projectPath: "/srv/p1" };
    vi.advanceTimersByTime(10_000);
    expect(m.broker.brokerEndpointPort).not.toHaveBeenCalled();
  });
});

describe("client worktree port override", () => {
  const hosts = new Map<number, string>();
  const hostForView = (id: number) => hosts.get(id) ?? null;

  afterEach(() => hosts.clear());

  it("leaves local views to their local workspace host", () => {
    const uninstall = installClientWorktreePortOverride(hostForView);
    expect(m.broker.override!(11)).toBeNull();
    expect(m.broker.closePortsForView).not.toHaveBeenCalled();
    uninstall();
  });

  it("gives a remote view with no relay yet nothing, and drops its local port", () => {
    const uninstall = installClientWorktreePortOverride(hostForView);
    hosts.set(11, "studio-01");
    const host = m.broker.override!(11) as WorktreePortHost;
    expect(host).not.toBeNull();
    expect(host.attachWorktreePort({} as never)).toBe(false);
    expect(m.broker.closePortsForView).toHaveBeenCalledWith(11);
    uninstall();
  });

  it("routes a remote view to its relay, and re-posts it on reload or reactivation", () => {
    const uninstall = installClientWorktreePortOverride(hostForView);
    hosts.set(11, "studio-01");
    const wc = fakeWebContents(11);
    attachClientWorktreeRelay(fakeSession(), wc, "view-11", "studio-01");
    const relayHost = m.broker.override!(11) as WorktreePortHost;
    expect(relayHost.projectPath).toContain("view-11");
    // Attaching posts the view its first relayed port.
    expect(m.broker.brokerPort).toHaveBeenCalledWith(relayHost, wc, { force: true });

    m.broker.brokerPort.mockClear();
    redeliverClientWorktreePort(wc);
    expect(m.broker.brokerPort).toHaveBeenCalledWith(relayHost, wc, { force: true });

    // Moved to another host: the old relay is retired and the view waits.
    hosts.set(11, "studio-02");
    const waiting = m.broker.override!(11) as WorktreePortHost;
    expect(waiting).not.toBe(relayHost);
    m.broker.brokerPort.mockClear();
    redeliverClientWorktreePort(wc);
    expect(m.broker.brokerPort).not.toHaveBeenCalled();
    uninstall();
  });
});
