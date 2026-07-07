/**
 * SurfacePortBroker — the Phase 1V pty-port substrate: synthetic connection
 * ids that can never alias real window ids, token-before-port delivery order
 * (the preload relay pairs them), context registration before connect (shard
 * derivation), and teardown from every direction — host port close (#7589),
 * webContents destruction, navigation, re-broker, dispose.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const madeChannels = vi.hoisted(() => [] as Array<{ port1: unknown; port2: unknown }>);

function makeMockPort() {
  const handlers = new Map<string, Handler[]>();
  return {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }),
    close: vi.fn(),
    _fire(event: string) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler();
    },
    _listenerCount(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
  };
}

vi.mock("electron", () => ({
  // A function expression (not an arrow) so `new MessageChannelMain()` works;
  // returning an object from a constructor substitutes it as the instance.
  MessageChannelMain: function MessageChannelMain() {
    const channel = { port1: makeMockPort(), port2: makeMockPort() };
    madeChannels.push(channel);
    return channel;
  },
}));

import { SurfacePortBroker, SURFACE_CONNECTION_ID_BASE } from "../SurfacePortBroker.js";
import type { PtyClient } from "../../services/PtyClient.js";

type MockPort = ReturnType<typeof makeMockPort>;

function makeMockWc() {
  const handlers = new Map<string, Handler[]>();
  let destroyed = false;
  return {
    id: 3,
    isDestroyed: vi.fn(() => destroyed),
    postMessage: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }),
    _fire(event: string, ...args: unknown[]) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    },
    _listenerCount(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
    _destroy() {
      destroyed = true;
    },
  };
}

function makeMockPtyClient() {
  return {
    registerAuxConnectionContext: vi.fn(),
    connectMessagePort: vi.fn(),
    disconnectMessagePort: vi.fn(),
  };
}

function makeBroker() {
  const ptyClient = makeMockPtyClient();
  const broker = new SurfacePortBroker(() => ptyClient as unknown as PtyClient);
  const wc = makeMockWc();
  return { broker, ptyClient, wc };
}

beforeEach(() => {
  madeChannels.length = 0;
});

describe("SurfacePortBroker.brokerSurfacePort", () => {
  it("allocates synthetic connection ids above the real-window id space", () => {
    const { broker, wc } = makeBroker();
    const id1 = broker.brokerSurfacePort({
      surfaceId: "s1",
      wc: wc as never,
      projectId: "p1",
      projectPath: "/proj",
    });
    const id2 = broker.brokerSurfacePort({
      surfaceId: "s2",
      wc: wc as never,
      projectId: "p1",
    });

    expect(id1).toBeGreaterThanOrEqual(SURFACE_CONNECTION_ID_BASE);
    expect(id2).toBeGreaterThan(id1);
  });

  it("registers the project context before connecting so shard routing resolves", () => {
    const { broker, ptyClient, wc } = makeBroker();
    const connectionId = broker.brokerSurfacePort({
      surfaceId: "s1",
      wc: wc as never,
      projectId: "p1",
      projectPath: "/proj",
    });

    expect(ptyClient.registerAuxConnectionContext).toHaveBeenCalledWith(
      connectionId,
      "p1",
      "/proj"
    );
    expect(ptyClient.connectMessagePort).toHaveBeenCalledWith(
      connectionId,
      madeChannels[0]!.port2
    );
    const registerOrder = ptyClient.registerAuxConnectionContext.mock.invocationCallOrder[0]!;
    const connectOrder = ptyClient.connectMessagePort.mock.invocationCallOrder[0]!;
    expect(registerOrder).toBeLessThan(connectOrder);
  });

  it("delivers the handshake token before the port, both to the surface webContents", () => {
    const { broker, wc } = makeBroker();
    broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });

    expect(wc.postMessage).toHaveBeenCalledTimes(2);
    const [first, second] = wc.postMessage.mock.calls;
    expect(first![0]).toBe("terminal-port-token");
    expect(second![0]).toBe("terminal-port");
    // The port rides only the second message, paired by the same token.
    expect(first![1].token).toBe(second![1].token);
    expect(second![2]).toEqual([madeChannels[0]!.port1]);
  });

  it("re-brokering a surface releases the previous connection first", () => {
    const { broker, ptyClient, wc } = makeBroker();
    const first = broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });
    const second = broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });

    expect(second).not.toBe(first);
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledWith(first);
    const firstChannel = madeChannels[0]!;
    expect((firstChannel.port1 as MockPort).close).toHaveBeenCalled();
    expect(broker.connectionIdFor("s1")).toBe(second);
  });

  it("releases the pty-host connection when port delivery to the renderer fails", () => {
    const { broker, ptyClient, wc } = makeBroker();
    wc.postMessage.mockImplementation(() => {
      throw new Error("Render frame was disposed");
    });

    expect(() =>
      broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" })
    ).toThrow(/disposed/);
    // The half-open connection must not survive: pty-host disconnected and
    // ports closed. The failed delivery is terminal, so no context lingers
    // for a re-broker.
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledTimes(1);
    expect((madeChannels[0]!.port1 as MockPort).close).toHaveBeenCalled();
    expect(broker.connectionIdFor("s1")).toBeNull();
    wc.postMessage.mockReset();
    expect(broker.rebrokerFromLast("s1", wc as never)).toBeNull();
  });

  it("rebrokerFromLast reuses the last broker's project context after a reload", () => {
    const { broker, ptyClient, wc } = makeBroker();
    broker.brokerSurfacePort({
      surfaceId: "s1",
      wc: wc as never,
      projectId: "p1",
      projectPath: "/proj",
    });
    // Reload navigation released the port.
    wc._fire("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(broker.connectionIdFor("s1")).toBeNull();

    const reconnected = broker.rebrokerFromLast("s1", wc as never);
    expect(reconnected).not.toBeNull();
    expect(ptyClient.registerAuxConnectionContext).toHaveBeenLastCalledWith(
      reconnected,
      "p1",
      "/proj"
    );
    expect(broker.connectionIdFor("s1")).toBe(reconnected);

    // A surface never brokered has no context to reuse.
    expect(broker.rebrokerFromLast("never-brokered", wc as never)).toBeNull();
  });

  it("throws when the pty client is unavailable or the webContents is destroyed", () => {
    const wc = makeMockWc();
    const noPty = new SurfacePortBroker(() => null);
    expect(() =>
      noPty.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: null })
    ).toThrow(/pty client unavailable/);

    const { broker } = makeBroker();
    wc._destroy();
    expect(() =>
      broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: null })
    ).toThrow(/destroyed/);
  });
});

describe("SurfacePortBroker teardown paths", () => {
  it("releases on host-side port close (#7589 fallback)", () => {
    const { broker, ptyClient, wc } = makeBroker();
    const connectionId = broker.brokerSurfacePort({
      surfaceId: "s1",
      wc: wc as never,
      projectId: "p1",
    });

    (madeChannels[0]!.port1 as MockPort)._fire("close");
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledWith(connectionId);
    expect(broker.connectionIdFor("s1")).toBeNull();
  });

  it("releases when the surface webContents is destroyed and forgets its context", () => {
    const { broker, ptyClient, wc } = makeBroker();
    const connectionId = broker.brokerSurfacePort({
      surfaceId: "s1",
      wc: wc as never,
      projectId: "p1",
    });

    wc._fire("destroyed");
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledWith(connectionId);
    expect(broker.connectionIdFor("s1")).toBeNull();
    // A destroyed view never re-brokers.
    expect(broker.rebrokerFromLast("s1", wc as never)).toBeNull();
  });

  it("releases on real navigation but not same-document navigation", () => {
    const { broker, wc } = makeBroker();
    broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });

    wc._fire("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(broker.connectionIdFor("s1")).not.toBeNull();
    wc._fire("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(broker.connectionIdFor("s1")).not.toBeNull();

    wc._fire("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(broker.connectionIdFor("s1")).toBeNull();
  });

  it("release detaches every listener it installed", () => {
    const { broker, wc } = makeBroker();
    broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });
    const port1 = madeChannels[0]!.port1 as MockPort;
    expect(port1._listenerCount("close")).toBe(1);

    broker.releaseSurfacePort("s1");
    expect(port1._listenerCount("close")).toBe(0);
    expect(wc._listenerCount("destroyed")).toBe(0);
    expect(wc._listenerCount("did-start-navigation")).toBe(0);
  });

  it("release is idempotent and dispose sweeps every surface", () => {
    const { broker, ptyClient, wc } = makeBroker();
    broker.brokerSurfacePort({ surfaceId: "s1", wc: wc as never, projectId: "p1" });
    broker.brokerSurfacePort({ surfaceId: "s2", wc: wc as never, projectId: "p1" });

    broker.releaseSurfacePort("s1");
    broker.releaseSurfacePort("s1");
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledTimes(1);

    broker.dispose();
    expect(ptyClient.disconnectMessagePort).toHaveBeenCalledTimes(2);
    expect(broker.connectionIdFor("s2")).toBeNull();
  });
});
