import { beforeEach, describe, expect, it, vi } from "vitest";

type IncomingMessage = { statusCode: number; resume: () => void };
type RequestCallback = (res: IncomingMessage) => void;
type MockRequest = {
  on: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

type WsListener = (...args: unknown[]) => void;
type WsHeaders = Record<string, string>;
type MockWebSocket = {
  url: string;
  subprotocols: string[];
  headers: WsHeaders;
  listeners: { open: WsListener[]; error: WsListener[]; close: WsListener[] };
  once: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: "open" | "error" | "close", ...args: unknown[]) => void;
};

const { mockRequest, wsInstances, wsBehavior } = vi.hoisted(() => ({
  mockRequest:
    vi.fn<
      (url: string, options: Record<string, unknown>, callback: RequestCallback) => MockRequest
    >(),
  wsInstances: [] as MockWebSocket[],
  wsBehavior: {
    mode: "error" as "error" | "open" | "throw" | "openOn" | "manual",
    openOnUrl: "",
  },
}));

vi.mock("node:http", () => ({
  default: { request: mockRequest },
  request: mockRequest,
}));
vi.mock("node:https", () => ({
  default: { request: mockRequest },
  request: mockRequest,
}));

vi.mock("ws", () => {
  class WebSocketMock {
    url: string;
    subprotocols: string[];
    headers: WsHeaders;
    listeners: MockWebSocket["listeners"] = { open: [], error: [], close: [] };
    once = vi.fn((event: "open" | "error" | "close", listener: WsListener) => {
      this.listeners[event].push(listener);
      return this;
    });
    terminate = vi.fn();
    emit(event: "open" | "error" | "close", ...args: unknown[]) {
      const listeners = this.listeners[event];
      this.listeners[event] = [];
      for (const listener of listeners) listener(...args);
    }
    constructor(url: string, protocolsOrOptions?: unknown, maybeOptions?: unknown) {
      this.url = url;
      const hasProtocols = Array.isArray(protocolsOrOptions);
      this.subprotocols = hasProtocols ? (protocolsOrOptions as string[]) : [];
      const options = (hasProtocols ? maybeOptions : protocolsOrOptions) as
        | { headers?: WsHeaders }
        | undefined;
      this.headers = options?.headers ?? {};

      if (wsBehavior.mode === "throw") {
        throw new Error("invalid ws url");
      }

      wsInstances.push(this as unknown as MockWebSocket);

      if (wsBehavior.mode === "manual") {
        return;
      }

      const shouldOpen =
        wsBehavior.mode === "open" ||
        (wsBehavior.mode === "openOn" && url === wsBehavior.openOnUrl);

      queueMicrotask(() => {
        if (shouldOpen) {
          this.emit("open");
        } else {
          this.emit("error", new Error("ws connect failed"));
        }
      });
    }
  }
  return {
    default: WebSocketMock,
  };
});

import { waitForServerReady, probeHmrWebSocket } from "../DevPreviewReadinessProbe.js";

function resetWsState() {
  wsInstances.length = 0;
  wsBehavior.mode = "error";
  wsBehavior.openOnUrl = "";
}

function mockResponseWithStatus(statusCode: number) {
  const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  mockRequest.mockImplementation(
    (_url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
      callback({ statusCode, resume: vi.fn() });
      return req;
    }
  );
  return req;
}

function mockResponseSequence(statuses: number[]) {
  let i = 0;
  mockRequest.mockImplementation(
    (_url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
      const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      const status = statuses[Math.min(i, statuses.length - 1)] ?? 0;
      i += 1;
      callback({ statusCode: status, resume: vi.fn() });
      return req;
    }
  );
}

function mockConnectionRefused() {
  const firstReq: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  mockRequest.mockImplementation(
    (_url: string, _options: Record<string, unknown>, _callback: RequestCallback) => {
      const r: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      setTimeout(() => {
        const errorHandler = r.on.mock.calls
          .filter((c: unknown[]) => c[0] === "error")
          .at(-1)?.[1] as ((err: Error) => void) | undefined;
        if (errorHandler) errorHandler(new Error("ECONNREFUSED"));
      }, 10);
      return r;
    }
  );
  return firstReq;
}

describe("waitForServerReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWsState();
  });

  it("returns true on HTTP 200", async () => {
    mockResponseWithStatus(200);
    const signal = new AbortController().signal;
    const result = await waitForServerReady("http://localhost:3000", signal, 100);
    expect(result).toBe(true);
  });

  it("uses GET method, not HEAD", async () => {
    mockResponseWithStatus(200);
    const signal = new AbortController().signal;
    await waitForServerReady("http://localhost:3000", signal, 100);
    const optionsArg = mockRequest.mock.calls[0]?.[1];
    expect(optionsArg?.method).toBe("GET");
  });

  it("falls back to IPv4 loopback when localhost is refused", async () => {
    mockRequest.mockImplementation(
      (url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
        const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
        if (url === "http://127.0.0.1:3000/") {
          callback({ statusCode: 200, resume: vi.fn() });
          return req;
        }

        setTimeout(() => {
          const errorHandler = req.on.mock.calls.find((c: unknown[]) => c[0] === "error")?.[1] as
            | ((err: Error) => void)
            | undefined;
          errorHandler?.(new Error("ECONNREFUSED"));
        }, 0);
        return req;
      }
    );

    const signal = new AbortController().signal;
    const result = await waitForServerReady("http://localhost:3000", signal, 100);
    expect(result).toBe(true);
    expect(mockRequest.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3000/",
      "http://127.0.0.1:3000/",
    ]);
  });

  it("returns false on malformed URL", async () => {
    const signal = new AbortController().signal;
    const result = await waitForServerReady("not-a-url", signal, 100);
    expect(result).toBe(false);
  });

  it("returns false when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForServerReady("http://localhost:3000", controller.signal, 100);
    expect(result).toBe(false);
  });

  it("returns false on connection timeout", async () => {
    mockConnectionRefused();
    const signal = new AbortController().signal;
    const result = await waitForServerReady("http://localhost:3000", signal, 100);
    expect(result).toBe(false);
  });

  describe("accepted status range", () => {
    it.each([200, 204, 301, 302, 307, 308])("returns true on HTTP %i", async (status) => {
      mockResponseWithStatus(status);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 100);
      expect(result).toBe(true);
    });

    it.each([100, 199, 400, 401, 404, 405, 499, 500, 502, 503, 599])(
      "returns false on HTTP %i",
      async (status) => {
        mockResponseWithStatus(status);
        const signal = new AbortController().signal;
        const result = await waitForServerReady("http://localhost:3000", signal, 100);
        expect(result).toBe(false);
      }
    );
  });

  describe("5xx memory", () => {
    it("requires a follow-up 2xx/3xx after a 5xx before resolving", async () => {
      mockResponseSequence([502, 200, 200]);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      const statusCount = mockRequest.mock.calls.length;
      expect(statusCount).toBeGreaterThanOrEqual(3);
    });

    it("does not resolve on the first 200 immediately after a 5xx", async () => {
      let idx = 0;
      const statuses = [502, 200];
      mockRequest.mockImplementation(
        (_url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
          const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
          const status = statuses[Math.min(idx, statuses.length - 1)] ?? 200;
          idx += 1;
          callback({ statusCode: status, resume: vi.fn() });
          return req;
        }
      );
      const signal = new AbortController().signal;
      // Single-candidate URL (no IPv4/IPv6 fallback fanout) so each round = 1 call.
      // Timeout 600ms allows ~2 rounds (poll interval 500ms): round 1 = 502, round 2 = 200,
      // then deadline expires before a round 3 follow-up 200 could resolve.
      const result = await waitForServerReady("http://127.0.0.1:3000", signal, 600);
      expect(result).toBe(false);
      expect(idx).toBeGreaterThanOrEqual(2);
    });

    it("resolves on first 2xx when no 5xx ever observed (ECONNREFUSED then 200)", async () => {
      let callCount = 0;
      mockRequest.mockImplementation(
        (_url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
          const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
          callCount += 1;
          if (callCount === 1) {
            setTimeout(() => {
              const errorHandler = req.on.mock.calls.find(
                (c: unknown[]) => c[0] === "error"
              )?.[1] as ((err: Error) => void) | undefined;
              errorHandler?.(new Error("ECONNREFUSED"));
            }, 0);
            return req;
          }
          callback({ statusCode: 200, resume: vi.fn() });
          return req;
        }
      );
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
    });

    it("resets confirmation when a new 5xx interrupts the recovery", async () => {
      mockResponseSequence([502, 200, 502, 200, 200]);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      expect(mockRequest.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("HMR WebSocket handshake", () => {
    it("opens WS probe after HTTP succeeds", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      expect(wsInstances.length).toBe(3);
    });

    it("returns true even when all WS candidates fail (opportunistic)", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
    });

    it("spoofs Origin header on every WS candidate", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 5000);
      for (const instance of wsInstances) {
        expect(instance.headers.Origin).toBe("http://localhost:3000");
      }
    });

    it("uses vite-hmr subprotocol on the root WS path", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 5000);
      const root = wsInstances.find((ws) => ws.url === "ws://localhost:3000/");
      expect(root).toBeDefined();
      expect(root?.subprotocols).toEqual(["vite-hmr"]);
    });

    it("probes all three HMR endpoints", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 5000);
      const urls = wsInstances.map((ws) => ws.url).sort();
      expect(urls).toEqual([
        "ws://localhost:3000/",
        "ws://localhost:3000/_next/webpack-hmr",
        "ws://localhost:3000/ws",
      ]);
    });

    it("derives wss:// scheme from https:// HTTP URL", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      await waitForServerReady("https://localhost:3000", signal, 5000);
      expect(wsInstances.every((ws) => ws.url.startsWith("wss://"))).toBe(true);
    });

    it("terminates all sockets after settlement", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "error";
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 5000);
      for (const instance of wsInstances) {
        expect(instance.terminate).toHaveBeenCalled();
      }
    });

    it("survives a synchronous WS constructor throw", async () => {
      mockResponseWithStatus(200);
      wsBehavior.mode = "throw";
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
    });
  });
});

describe("probeHmrWebSocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWsState();
  });

  it("resolves true when any candidate opens", async () => {
    wsBehavior.mode = "openOn";
    wsBehavior.openOnUrl = "ws://localhost:3000/_next/webpack-hmr";
    const signal = new AbortController().signal;
    const result = await probeHmrWebSocket("http://localhost:3000", signal);
    expect(result).toBe(true);
  });

  it("resolves false when all candidates error", async () => {
    wsBehavior.mode = "error";
    const signal = new AbortController().signal;
    const result = await probeHmrWebSocket("http://localhost:3000", signal);
    expect(result).toBe(false);
  });

  it("resolves false when signal is already aborted", async () => {
    wsBehavior.mode = "open";
    const controller = new AbortController();
    controller.abort();
    const result = await probeHmrWebSocket("http://localhost:3000", controller.signal);
    expect(result).toBe(false);
    expect(wsInstances.length).toBe(0);
  });

  it("resolves false on invalid URL", async () => {
    wsBehavior.mode = "open";
    const signal = new AbortController().signal;
    const result = await probeHmrWebSocket("not-a-url", signal);
    expect(result).toBe(false);
  });

  it("resolves false when all WS constructors throw", async () => {
    wsBehavior.mode = "throw";
    const signal = new AbortController().signal;
    const result = await probeHmrWebSocket("http://localhost:3000", signal);
    expect(result).toBe(false);
  });

  it("does not double-count error+close on the same failed socket", async () => {
    // Regression: ws emits both "error" and "close" on a failed connection.
    // Without per-socket guarding, two failed sockets (4 events) would settle
    // the probe to false before the third (successful) socket fires "open".
    wsBehavior.mode = "manual";
    const signal = new AbortController().signal;
    const probePromise = probeHmrWebSocket("http://localhost:3000", signal);

    // Let the constructor loop complete (synchronous), then drive events.
    await Promise.resolve();
    expect(wsInstances.length).toBe(3);

    // Two sockets fail with both error then close (the ws-native sequence).
    wsInstances[0].emit("error", new Error("refused"));
    wsInstances[0].emit("close");
    wsInstances[1].emit("error", new Error("refused"));
    wsInstances[1].emit("close");

    // Third socket opens successfully — guard must have kept pending > 0 so
    // settle(false) wasn't called prematurely.
    wsInstances[2].emit("open");

    const result = await probePromise;
    expect(result).toBe(true);
  });
});
