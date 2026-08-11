import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));

import {
  getServiceConnectivityRegistry,
  wireMcpServerToConnectivityRegistry,
  _resetServiceConnectivityRegistryForTests,
} from "../index.js";
import { broadcastToRenderer } from "../../../ipc/utils.js";
import { CHANNELS } from "../../../ipc/channels.js";

interface FakeMcpServer {
  isRunning: boolean;
  listeners: Set<(running: boolean) => void>;
  onStatusChange(listener: (running: boolean) => void): () => void;
  setRunning(running: boolean): void;
}

function createFakeMcpServer(initialRunning: boolean): FakeMcpServer {
  const fake: FakeMcpServer = {
    isRunning: initialRunning,
    listeners: new Set(),
    onStatusChange: (listener) => {
      fake.listeners.add(listener);
      return () => {
        fake.listeners.delete(listener);
      };
    },
    setRunning: (running) => {
      fake.isRunning = running;
      for (const listener of fake.listeners) listener(running);
    },
  };
  return fake;
}

describe("connectivity lazy MCP proxy", () => {
  afterEach(() => {
    _resetServiceConnectivityRegistryForTests();
  });

  it("buffers a subscription made before wiring and forwards events after", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();
    expect(registry.getSnapshot().mcp.status).toBe("unknown");

    const fake = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(fake);
    expect(fake.listeners.size).toBe(1);

    fake.setRunning(true);
    expect(registry.getSnapshot().mcp.status).toBe("reachable");

    fake.setRunning(false);
    expect(registry.getSnapshot().mcp.status).toBe("unreachable");
  });

  it("delegates isRunning and subscriptions directly once wired before start", () => {
    const registry = getServiceConnectivityRegistry();
    const fake = createFakeMcpServer(true);
    wireMcpServerToConnectivityRegistry(fake);

    registry.start();
    expect(registry.getSnapshot().mcp.status).toBe("reachable");
    expect(fake.listeners.size).toBe(1);
  });

  it("leaves the seed at unknown when wired after start, even if already running", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();

    const fake = createFakeMcpServer(true);
    wireMcpServerToConnectivityRegistry(fake);

    // Deliberate per the registry's seeding contract: a server that was
    // already running when wiring lands waits for its first live status
    // event rather than back-filling the snapshot, avoiding a spurious
    // unreachable→reachable recovery toast.
    expect(registry.getSnapshot().mcp.status).toBe("unknown");

    fake.setRunning(true);
    expect(registry.getSnapshot().mcp.status).toBe("reachable");
  });

  it("tolerates repeated dispose before wiring", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();
    registry.dispose();
    registry.dispose();

    const fake = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(fake);
    expect(fake.listeners.size).toBe(0);
  });

  it("drops a subscription unsubscribed before wiring", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();
    registry.dispose();

    const fake = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(fake);
    expect(fake.listeners.size).toBe(0);
  });

  it("ignores a second wire call", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();

    const first = createFakeMcpServer(false);
    const second = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(first);
    wireMcpServerToConnectivityRegistry(second);

    expect(first.listeners.size).toBe(1);
    expect(second.listeners.size).toBe(0);

    second.setRunning(true);
    expect(getServiceConnectivityRegistry().getSnapshot().mcp.status).toBe("unknown");

    first.setRunning(true);
    expect(getServiceConnectivityRegistry().getSnapshot().mcp.status).toBe("reachable");
  });

  it("unsubscribes from the real service when disposed after wiring", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();

    const fake = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(fake);
    expect(fake.listeners.size).toBe(1);

    registry.dispose();
    expect(fake.listeners.size).toBe(0);
  });
});

describe("connectivity recovery toast", () => {
  beforeEach(() => {
    vi.mocked(broadcastToRenderer).mockClear();
  });

  afterEach(() => {
    _resetServiceConnectivityRegistryForTests();
  });

  // MCP is the only source that can reach the unreachable→reachable edge —
  // GitHub maps `unhealthy` to `unknown`, never `unreachable`. Nothing else
  // guards the channel or the copy, so assert both here.
  it("broadcasts the restored toast only on an MCP crash→restart, not on first start", () => {
    const registry = getServiceConnectivityRegistry();
    registry.start();

    const fake = createFakeMcpServer(false);
    wireMcpServerToConnectivityRegistry(fake);

    // unknown → reachable: normal launch, must stay silent.
    fake.setRunning(true);
    expect(broadcastToRenderer).not.toHaveBeenCalled();

    // reachable → unreachable: the crash itself carries no toast.
    fake.setRunning(false);
    expect(broadcastToRenderer).not.toHaveBeenCalled();

    // unreachable → reachable: the recovery users actually need to know about.
    fake.setRunning(true);
    expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      title: "Connection restored",
      message: "Reconnected to MCP server.",
    });
  });
});
