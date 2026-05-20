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

import { waitForServerReady, READINESS_TIMEOUT_MS } from "../DevPreviewReadinessProbe.js";

function mockSuccessResponse() {
  const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  mockRequest.mockImplementation(
    (_url: string, _options: Record<string, unknown>, callback: RequestCallback) => {
      callback({ statusCode: 200, resume: vi.fn() });
      return req;
    }
  );
  return req;
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
    mockSuccessResponse();
    const signal = new AbortController().signal;
    const result = await waitForServerReady("http://localhost:3000", signal, 100);
    expect(result).toBe(true);
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

  describe("accepted status range (200–499)", () => {
    it.each([200, 204, 301, 401, 404, 499])("returns true on HTTP %i", async (status) => {
      mockResponseWithStatus(status);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 100);
      expect(result).toBe(true);
    });

    it.each([100, 199, 500, 502, 503, 599])("returns false on HTTP %i", async (status) => {
      mockResponseWithStatus(status);
      const signal = new AbortController().signal;
      const result = await waitForServerReady("http://localhost:3000", signal, 100);
      expect(result).toBe(false);
    });
  });
});

describe("READINESS_TIMEOUT_MS", () => {
  it("is the expected default", () => {
    expect(READINESS_TIMEOUT_MS).toBe(30000);
  });
});
