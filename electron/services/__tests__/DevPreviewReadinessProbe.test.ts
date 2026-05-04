import { beforeEach, describe, expect, it, vi } from "vitest";

type IncomingMessage = { statusCode: number; resume: () => void };
type RequestCallback = (res: IncomingMessage) => void;
type MockRequest = {
  on: (event: string, handler: (...args: unknown[]) => void) => MockRequest;
  end: () => void;
  destroy: () => void;
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

function mockConnectionRefused() {
  const req: MockRequest = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  mockRequest.mockImplementation(
    (_url: string, _options: Record<string, unknown>, _callback: RequestCallback) => {
      const r = { ...req };
      setTimeout(() => {
        const errorHandler = r.on.mock.calls.find((c: unknown[]) => c[0] === "error")?.[1] as
          | ((err: Error) => void)
          | undefined;
        if (errorHandler) errorHandler(new Error("ECONNREFUSED"));
      }, 10);
      return r;
    }
  );
  return req;
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
});

describe("READINESS_TIMEOUT_MS", () => {
  it("is the expected default", () => {
    expect(READINESS_TIMEOUT_MS).toBe(30000);
  });
});
