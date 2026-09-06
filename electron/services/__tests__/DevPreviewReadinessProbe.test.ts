import { beforeEach, describe, expect, it, vi } from "vitest";

type IncomingMessage = { statusCode: number; resume: () => void };
type RequestCallback = (res: IncomingMessage) => void;
type MockRequest = {
  on: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const { mockRequest, wsConstructed } = vi.hoisted(() => ({
  mockRequest:
    vi.fn<
      (url: string, options: Record<string, unknown>, callback: RequestCallback) => MockRequest
    >(),
  wsConstructed: [] as string[],
}));

// The readiness path must not reach for a socket at all. Recording construction
// is what makes that assertable — a timing check cannot distinguish a fast
// handshake from no handshake.
vi.mock("ws", () => ({
  default: class {
    constructor(url: string) {
      wsConstructed.push(url);
      throw new Error("readiness must not open a WebSocket");
    }
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

import { waitForServerReady, READINESS_REQUEST_TIMEOUT_MS } from "../DevPreviewReadinessProbe.js";

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
    wsConstructed.length = 0;
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
            ((err: Error) => void) | undefined;
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

    // #12299: a final 4xx proves the server is bound and serving. An auth-gated
    // dev server or one with no route at `/` used to be retried until the 30s
    // deadline and then reported as "did not respond".
    it.each([400, 401, 403, 404, 405, 499])(
      "accepts HTTP %i as a responding server",
      async (status) => {
        mockResponseWithStatus(status);
        const signal = new AbortController().signal;
        const result = await waitForServerReady("http://localhost:3000", signal, 100);
        expect(result).toBe(true);
      }
    );

    it("resolves a 404 on the first request rather than polling to the deadline", async () => {
      mockResponseWithStatus(404);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      expect(mockRequest.mock.calls.length).toBe(1);
    });

    // 1xx is not a completed final response, and 5xx is a compiling shell.
    it.each([100, 199, 500, 502, 503, 599])("returns false on HTTP %i", async (status) => {
      mockResponseWithStatus(status);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 100);
      expect(result).toBe(false);
    });
  });

  describe("no WebSocket handshake on the ready path (#12299)", () => {
    it("never constructs a WebSocket", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      // Recorded at construction rather than timed: a wall-clock assertion
      // could not tell a fast handshake from no handshake at all.
      expect(wsConstructed).toHaveLength(0);
    });
  });

  describe("deadline enforcement (#12299)", () => {
    it("clamps a request timeout to the remaining budget", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 120);
      const timeout = mockRequest.mock.calls[0]?.[1]?.timeout;
      expect(timeout).toBeLessThanOrEqual(120);
    });

    it("uses the full per-request ceiling when the budget is large", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 30000);
      expect(mockRequest.mock.calls[0]?.[1]?.timeout).toBe(READINESS_REQUEST_TIMEOUT_MS);
    });

    it("shrinks the clamp as candidates consume the budget", async () => {
      // Every candidate refuses, so all three run inside one round.
      mockRequest.mockImplementation(
        (_url: string, _options: Record<string, unknown>, _callback: RequestCallback) => {
          const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
          setTimeout(() => {
            const errorHandler = req.on.mock.calls.find((c: unknown[]) => c[0] === "error")?.[1] as
              ((err: Error) => void) | undefined;
            errorHandler?.(new Error("ECONNREFUSED"));
          }, 20);
          return req;
        }
      );
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 100);
      const timeouts = mockRequest.mock.calls.map((call) => call[1]?.timeout as number);
      expect(timeouts.length).toBeGreaterThanOrEqual(2);
      expect(timeouts[1]).toBeLessThan(timeouts[0]);
      for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(100);
    });
  });

  describe("attempt reporting (#12299)", () => {
    it("reports the settled response with status, attempt and budget", async () => {
      mockResponseWithStatus(200);
      const attempts: Array<Record<string, unknown>> = [];
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 5000, {
        onAttempt: (attempt) => attempts.push({ ...attempt }),
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        url: "http://localhost:3000/",
        outcome: "reachable",
        status: 200,
        attempt: 1,
      });
      expect(attempts[0].remainingMs).toBeLessThanOrEqual(5000);
    });

    it("reports a retry cause rather than a status when the connection fails", async () => {
      mockConnectionRefused();
      const attempts: Array<Record<string, unknown>> = [];
      const signal = new AbortController().signal;
      await waitForServerReady("http://127.0.0.1:3000", signal, 120, {
        onAttempt: (attempt) => attempts.push({ ...attempt }),
      });
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts[0]).toMatchObject({ outcome: "retry", cause: "connection-error" });
      expect(attempts[0].status).toBeUndefined();
    });

    it("reports one row per candidate while the outcome is unchanged", async () => {
      mockConnectionRefused();
      const attempts: Array<Record<string, unknown>> = [];
      const signal = new AbortController().signal;
      // ~4 rounds x 3 candidates worth of requests, but every one settles the
      // same way — the timeline must not carry a row for each.
      await waitForServerReady("http://localhost:3000", signal, 2000, {
        onAttempt: (attempt) => attempts.push({ ...attempt }),
      });
      expect(mockRequest.mock.calls.length).toBeGreaterThan(4);
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts.map((a) => a.url)).size).toBe(3);
    });

    it("reports again when a candidate's outcome changes", async () => {
      mockResponseSequence([503, 503, 200, 200]);
      const attempts: Array<Record<string, unknown>> = [];
      const signal = new AbortController().signal;
      await waitForServerReady("http://127.0.0.1:3000", signal, 5000, {
        onAttempt: (attempt) => attempts.push({ ...attempt }),
      });
      expect(attempts.map((a) => a.outcome)).toEqual(["server-error", "reachable"]);
    });
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

    // #12299: an alias that 5xxes every round must not starve the aliases that
    // answer. Arming the confirmation deliberately does NOT end the round, so
    // every address family stays reachable (#9752).
    it("keeps probing siblings after a 5xx arms the confirmation", async () => {
      mockRequest.mockImplementation(
        (url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
          const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
          callback({ statusCode: url.includes("localhost") ? 502 : 200, resume: vi.fn() });
          return req;
        }
      );
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 300);
      expect(result).toBe(true);
      // localhost 502 latches; 127.0.0.1 200 arms the confirmation; [::1] 200
      // confirms it — a permanently sick alias cannot veto the healthy ones.
      expect(mockRequest.mock.calls.map((call) => call[0])).toEqual([
        "http://localhost:3000/",
        "http://127.0.0.1:3000/",
        "http://[::1]:3000/",
      ]);
    });

    // The confirming success may need to be separated from a 5xx seen by an
    // EARLIER wait: a ready marker replaces the in-flight probe, and the
    // replacement must not forget the compiling shell (#8294, #9317).
    it("carries a prior 5xx into a replacement wait", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://127.0.0.1:3000", signal, 300, {
        seenServerError: true,
      });
      expect(result).toBe(false);
    });

    it("resolves normally when no earlier probe saw a 5xx", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://127.0.0.1:3000", signal, 300, {
        seenServerError: false,
      });
      expect(result).toBe(true);
    });
  });
});
