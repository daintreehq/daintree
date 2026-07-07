/**
 * portDistribution — window port-pair delivery and the disposed-frame race
 * (#10964): a reloading frame can be disposed while its WebContents still
 * reports alive, so postMessage throws despite isDestroyed() checks. The
 * window pair must survive a failed delivery (pty-host reacts to port close;
 * onViewReady re-brokers), while a failed worker-port delivery releases its
 * pair immediately and returns null per the function's contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function makeMockPort() {
  return {
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

type MockPort = ReturnType<typeof makeMockPort>;

const madeChannels = vi.hoisted(() => [] as Array<{ port1: MockPort; port2: MockPort }>);

vi.mock("electron", () => ({
  BrowserWindow: function BrowserWindow() {
    return {};
  },
  // A function expression (not an arrow) so `new MessageChannelMain()` works;
  // returning an object from a constructor substitutes it as the instance.
  MessageChannelMain: function MessageChannelMain() {
    const channel = { port1: makeMockPort(), port2: makeMockPort() };
    madeChannels.push(channel);
    return channel;
  },
}));

import {
  distributePortsToView,
  distributeTerminalWorkerPortToView,
  releaseTerminalWorkerPort,
} from "../portDistribution.js";
import type { WindowContext } from "../WindowRegistry.js";
import type { PtyClient } from "../../services/PtyClient.js";
import type { BrowserWindow } from "electron";

function makeMockWin(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
  } as unknown as BrowserWindow;
}

function makeMockWc(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    postMessage: vi.fn(),
  };
}

function makeMockPtyClient() {
  return {
    connectMessagePort: vi.fn(),
    connectTerminalMessagePort: vi.fn(),
    disconnectTerminalMessagePort: vi.fn(),
  };
}

function makeCtx(windowId = 7): WindowContext {
  return {
    windowId,
    services: {},
  } as unknown as WindowContext;
}

const asWc = (wc: ReturnType<typeof makeMockWc>) => wc as unknown as Electron.WebContents;
const asPty = (pty: ReturnType<typeof makeMockPtyClient>) => pty as unknown as PtyClient;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  madeChannels.length = 0;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("distributePortsToView", () => {
  it("stores the pair, connects the pty-host end, and posts token before port", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();
    const pty = makeMockPtyClient();

    distributePortsToView(makeMockWin(), ctx, asWc(wc), asPty(pty));

    expect(madeChannels).toHaveLength(1);
    const { port1, port2 } = madeChannels[0];
    expect(ctx.services.activeRendererPort).toBe(port1);
    expect(ctx.services.activePtyHostPort).toBe(port2);
    expect(pty.connectMessagePort).toHaveBeenCalledWith(ctx.windowId, port2);

    expect(wc.postMessage).toHaveBeenCalledTimes(2);
    const [first, second] = wc.postMessage.mock.calls;
    expect(first[0]).toBe("terminal-port-token");
    expect(second[0]).toBe("terminal-port");
    expect(second[2]).toEqual([port1]);
    expect((first[1] as { token: string }).token).toBe((second[1] as { token: string }).token);
  });

  it("closes the previous pair before minting a replacement", () => {
    const ctx = makeCtx();
    const oldRenderer = makeMockPort();
    const oldHost = makeMockPort();
    ctx.services.activeRendererPort = oldRenderer as unknown as Electron.MessagePortMain;
    ctx.services.activePtyHostPort = oldHost as unknown as Electron.MessagePortMain;

    distributePortsToView(makeMockWin(), ctx, asWc(makeMockWc()), asPty(makeMockPtyClient()));

    expect(oldRenderer.close).toHaveBeenCalled();
    expect(oldHost.close).toHaveBeenCalled();
    expect(ctx.services.activeRendererPort).toBe(madeChannels[0].port1);
  });

  it("releases dedicated worker-ingest pairs when replacing the window pair", () => {
    const ctx = makeCtx();
    const pty = makeMockPtyClient();
    const workerPair = { rendererPort: makeMockPort(), ptyHostPort: makeMockPort() };
    ctx.services.terminalWorkerPorts = new Map([
      [
        "term-1",
        workerPair as unknown as {
          rendererPort: Electron.MessagePortMain;
          ptyHostPort: Electron.MessagePortMain;
        },
      ],
    ]);

    distributePortsToView(makeMockWin(), ctx, asWc(makeMockWc()), asPty(pty));

    expect(ctx.services.terminalWorkerPorts?.has("term-1")).toBe(false);
    expect(pty.disconnectTerminalMessagePort).toHaveBeenCalledWith(ctx.windowId, "term-1");
    expect(workerPair.rendererPort.close).toHaveBeenCalled();
    expect(workerPair.ptyHostPort.close).toHaveBeenCalled();
  });

  it("swallows a disposed-frame throw on the first post and keeps the pair wired", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();
    wc.postMessage.mockImplementation(() => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    });
    const pty = makeMockPtyClient();

    expect(() => distributePortsToView(makeMockWin(), ctx, asWc(wc), asPty(pty))).not.toThrow();

    const { port1, port2 } = madeChannels[0];
    expect(pty.connectMessagePort).toHaveBeenCalledWith(ctx.windowId, port2);
    expect(ctx.services.activeRendererPort).toBe(port1);
    expect(ctx.services.activePtyHostPort).toBe(port2);
    expect(port1.close).not.toHaveBeenCalled();
    expect(port2.close).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("swallows a disposed-frame throw on the second post (token delivered, port not)", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();
    wc.postMessage
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Render frame was disposed before WebFrameMain could be accessed");
      });

    expect(() =>
      distributePortsToView(makeMockWin(), ctx, asWc(wc), asPty(makeMockPtyClient()))
    ).not.toThrow();

    const { port1, port2 } = madeChannels[0];
    expect(ctx.services.activeRendererPort).toBe(port1);
    expect(port1.close).not.toHaveBeenCalled();
    expect(port2.close).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("wires and posts the pair without a pty client", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();

    expect(() => distributePortsToView(makeMockWin(), ctx, asWc(wc), null)).not.toThrow();

    expect(madeChannels).toHaveLength(1);
    expect(ctx.services.activeRendererPort).toBe(madeChannels[0].port1);
    expect(ctx.services.activePtyHostPort).toBe(madeChannels[0].port2);
    expect(wc.postMessage).toHaveBeenCalledTimes(2);
  });

  it("skips posting to a destroyed WebContents but still wires the pair", () => {
    const ctx = makeCtx();
    const wc = makeMockWc(true);
    const pty = makeMockPtyClient();

    distributePortsToView(makeMockWin(), ctx, asWc(wc), asPty(pty));

    expect(wc.postMessage).not.toHaveBeenCalled();
    expect(ctx.services.activeRendererPort).toBe(madeChannels[0].port1);
    expect(pty.connectMessagePort).toHaveBeenCalled();
  });
});

describe("distributeTerminalWorkerPortToView", () => {
  it("mints a pair, connects the shard end, and returns the handshake token", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();
    const pty = makeMockPtyClient();

    const result = distributeTerminalWorkerPortToView(
      makeMockWin(),
      ctx,
      asWc(wc),
      asPty(pty),
      "term-1"
    );

    const { port1, port2 } = madeChannels[0];
    expect(result).not.toBeNull();
    expect(pty.connectTerminalMessagePort).toHaveBeenCalledWith(ctx.windowId, "term-1", port2);
    expect(ctx.services.terminalWorkerPorts?.get("term-1")).toEqual({
      rendererPort: port1,
      ptyHostPort: port2,
    });
    expect(wc.postMessage).toHaveBeenCalledWith(
      "terminal-worker-port",
      { token: result!.token, terminalId: "term-1" },
      [port1]
    );
  });

  it("returns null without allocating a channel when the window or client is gone", () => {
    const ctx = makeCtx();
    expect(
      distributeTerminalWorkerPortToView(makeMockWin(), ctx, asWc(makeMockWc()), null, "term-1")
    ).toBeNull();
    expect(
      distributeTerminalWorkerPortToView(
        makeMockWin(),
        ctx,
        asWc(makeMockWc(true)),
        asPty(makeMockPtyClient()),
        "term-1"
      )
    ).toBeNull();
    expect(madeChannels).toHaveLength(0);
  });

  it("releases the pair and returns null when delivery throws", () => {
    const ctx = makeCtx();
    const wc = makeMockWc();
    wc.postMessage.mockImplementation(() => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    });
    const pty = makeMockPtyClient();

    const result = distributeTerminalWorkerPortToView(
      makeMockWin(),
      ctx,
      asWc(wc),
      asPty(pty),
      "term-1"
    );

    const { port1, port2 } = madeChannels[0];
    expect(result).toBeNull();
    expect(ctx.services.terminalWorkerPorts?.has("term-1")).toBe(false);
    expect(pty.disconnectTerminalMessagePort).toHaveBeenCalledWith(ctx.windowId, "term-1");
    expect(port1.close).toHaveBeenCalled();
    expect(port2.close).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("releaseTerminalWorkerPort", () => {
  it("swallows close throws and is idempotent on double release", () => {
    const ctx = makeCtx();
    const pty = makeMockPtyClient();
    const pair = { rendererPort: makeMockPort(), ptyHostPort: makeMockPort() };
    pair.rendererPort.close.mockImplementation(() => {
      throw new Error("already closed");
    });
    ctx.services.terminalWorkerPorts = new Map([
      [
        "term-1",
        pair as unknown as {
          rendererPort: Electron.MessagePortMain;
          ptyHostPort: Electron.MessagePortMain;
        },
      ],
    ]);

    expect(() => releaseTerminalWorkerPort(ctx, asPty(pty), "term-1")).not.toThrow();
    expect(ctx.services.terminalWorkerPorts?.has("term-1")).toBe(false);
    expect(pair.ptyHostPort.close).toHaveBeenCalled();

    releaseTerminalWorkerPort(ctx, asPty(pty), "term-1");
    expect(pty.disconnectTerminalMessagePort).toHaveBeenCalledTimes(1);
  });
});
