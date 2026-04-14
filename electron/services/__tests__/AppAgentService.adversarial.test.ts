import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(),
  set: vi.fn(),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

import { AppAgentService } from "../AppAgentService.js";

function setConfig(config: Record<string, unknown>) {
  storeMock.get.mockImplementation((key: string) => {
    if (key === "appAgentConfig") return config;
    return undefined;
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  setConfig({ apiKey: "sk-valid", model: "gpt-foo" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function mockFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}

describe("AppAgentService adversarial", () => {
  it("hasApiKey returns false for whitespace-only keys", () => {
    setConfig({ apiKey: "   \t ", model: "x" });
    expect(new AppAgentService().hasApiKey()).toBe(false);
  });

  it("hasApiKey returns false for empty-string keys", () => {
    setConfig({ apiKey: "", model: "x" });
    expect(new AppAgentService().hasApiKey()).toBe(false);
  });

  it("hasApiKey returns true for a non-empty key", () => {
    expect(new AppAgentService().hasApiKey()).toBe(true);
  });

  it("getConfig omits apiKey from the returned object", () => {
    setConfig({ apiKey: "secret", model: "foo", baseUrl: "https://x" });
    const cfg = new AppAgentService().getConfig() as Record<string, unknown>;
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe("foo");
    expect(cfg.baseUrl).toBe("https://x");
  });

  it("testApiKey short-circuits on an invalid baseUrl without calling fetch", async () => {
    setConfig({ apiKey: "k", model: "m", baseUrl: "not a url" });
    const fetchSpy = vi.fn();
    mockFetch(fetchSpy as unknown as typeof fetch);

    const result = await new AppAgentService().testApiKey("new-key");

    expect(result).toEqual({ valid: false, error: "Invalid base URL configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("testApiKey returns valid:true on 429 (rate-limited counts as valid key)", async () => {
    mockFetch(vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch);

    const result = await new AppAgentService().testApiKey("k");
    expect(result).toEqual({ valid: true });
  });

  it("testApiKey returns a stable friendly message when fetch rejects with a non-Error value", async () => {
    mockFetch(
      vi.fn(async () => {
        throw "string rejection" as unknown as Error;
      }) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Failed to connect to API");
  });

  it("testApiKey 401 maps to 'Invalid API key'", async () => {
    mockFetch(vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch);
    const result = await new AppAgentService().testApiKey("k");
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("testApiKey 403 maps to model-access error", async () => {
    mockFetch(vi.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch);
    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("access");
  });

  it("testApiKey wraps other non-ok responses with status and error text", async () => {
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => "internal boom",
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.error).toMatch(/internal boom/);
  });

  it("testModel fails fast when no api key is configured", async () => {
    setConfig({ apiKey: "", model: "m" });
    const fetchSpy = vi.fn();
    mockFetch(fetchSpy as unknown as typeof fetch);

    const result = await new AppAgentService().testModel("other-model");

    expect(result).toEqual({ valid: false, error: "API key not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("testModel fails fast on whitespace-only api key", async () => {
    setConfig({ apiKey: "   ", model: "m" });
    const fetchSpy = vi.fn();
    mockFetch(fetchSpy as unknown as typeof fetch);

    const result = await new AppAgentService().testModel("other-model");

    expect(result).toEqual({ valid: false, error: "API key not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("testModel 404 maps to 'Model not found'", async () => {
    mockFetch(vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
    const result = await new AppAgentService().testModel("missing");
    expect(result).toEqual({ valid: false, error: "Model not found" });
  });

  it("testApiKey aborts after 15s timeout and returns 'Request timed out'", async () => {
    vi.useFakeTimers();
    mockFetch(
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      ) as unknown as typeof fetch
    );

    const pending = new AppAgentService().testApiKey("k");
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result).toEqual({ valid: false, error: "Request timed out" });
  });
});
