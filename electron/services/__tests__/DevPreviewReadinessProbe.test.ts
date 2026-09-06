import { beforeEach, describe, expect, it, vi } from "vitest";

type IncomingMessage = { statusCode: number; resume: () => void };
type RequestCallback = (res: IncomingMessage) => void;
type MockRequest = {
  on: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const { mockRequest } = vi.hoisted(() => ({
  mockRequest:
    vi.fn<
      (url: string, options: Record<string, unknown>, callback: RequestCallback) => MockRequest
    >(),
}));

vi.mock("node:http", () => ({
  default: { request: mockRequest },
  request: mockRequest,
}));
vi.mock("node:https", () => ({
  default: { request: mockRequest },
  request: mockRequest,
}));

import { waitForServerReady } from "../DevPreviewReadinessProbe.js";

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
    it("resolves without importing or opening a WebSocket", async () => {
      mockResponseWithStatus(200);
      const signal = new AbortController().signal;
      const started = performance.now();
      const result = await waitForServerReady("http://localhost:3000", signal, 5000);
      expect(result).toBe(true);
      // The discarded HMR probe used to hold this path for up to 1500ms.
      expect(performance.now() - started).toBeLessThan(500);
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
      expect(mockRequest.mock.calls[0]?.[1]?.timeout).toBe(5000);
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
      await waitForServerReady("http://localhost:3000", signal, 5000, (attempt) =>
        attempts.push({ ...attempt })
      );
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
      await waitForServerReady("http://127.0.0.1:3000", signal, 120, (attempt) =>
        attempts.push({ ...attempt })
      );
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
      await waitForServerReady("http://localhost:3000", signal, 2000, (attempt) =>
        attempts.push({ ...attempt })
      );
      expect(mockRequest.mock.calls.length).toBeGreaterThan(4);
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts.map((a) => a.url)).size).toBe(3);
    });

    it("reports again when a candidate's outcome changes", async () => {
      mockResponseSequence([503, 503, 200, 200]);
      const attempts: Array<Record<string, unknown>> = [];
      const signal = new AbortController().signal;
      await waitForServerReady("http://127.0.0.1:3000", signal, 5000, (attempt) =>
        attempts.push({ ...attempt })
      );
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

    // #12299: the confirming success has to land in a *later* round. A sibling
    // loopback alias answering in the same pass says nothing about whether the
    // compile that produced the 5xx has finished.
    it("does not confirm recovery through a sibling candidate in the same round", async () => {
      mockResponseSequence([502, 200]);
      const signal = new AbortController().signal;
      // localhost fans out to 127.0.0.1 and [::1]; a round is three candidates,
      // and 300ms is under one 500ms poll interval, so only round 1 can run.
      const result = await waitForServerReady("http://localhost:3000", signal, 300);
      expect(result).toBe(false);
    });

    it("ends the round once confirmation is armed rather than probing siblings", async () => {
      mockResponseSequence([502, 200]);
      const signal = new AbortController().signal;
      await waitForServerReady("http://localhost:3000", signal, 300);
      // 502 on localhost, 200 on 127.0.0.1 arms confirmation and breaks —
      // [::1] is never dialled in that round.
      expect(mockRequest.mock.calls.map((call) => call[0])).toEqual([
        "http://localhost:3000/",
        "http://127.0.0.1:3000/",
      ]);
    });
  });
});
