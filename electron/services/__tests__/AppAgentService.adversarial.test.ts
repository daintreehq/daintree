import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(),
  set: vi.fn(),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

import { AppAgentService, API_TEST_TIMEOUT_MS } from "../AppAgentService.js";
import { APP_AGENT_DEFAULT_BASE_URL } from "../../../shared/utils/appAgentUrl.js";

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
  vi.restoreAllMocks();
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

  it("testApiKey returns a stable friendly message when fetch rejects with an opaque value", async () => {
    mockFetch(
      vi.fn(async () => {
        throw 42 as unknown as Error;
      }) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Failed to connect to API");
  });

  it("testApiKey surfaces a thrown string verbatim (formatErrorMessage treats strings as messages)", async () => {
    mockFetch(
      vi.fn(async () => {
        throw "rate limit exceeded" as unknown as Error;
      }) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("rate limit exceeded");
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
    expect(result.error).toEqual("API key does not have access to this model");
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

  it("testApiKey aborts after timeout and returns 'Request timed out'", async () => {
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
    await vi.advanceTimersByTimeAsync(API_TEST_TIMEOUT_MS);
    const result = await pending;

    expect(result).toEqual({ valid: false, error: "Request timed out" });
  });

  it("testApiKey truncates large raw error text to 200 chars", async () => {
    const longText = "x".repeat(500);
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => longText,
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/^API error: 500 /);
    const providerPart = result.error!.replace("API error: 500 ", "");
    expect(providerPart.length).toBe(203);
    expect(providerPart.endsWith("...")).toBe(true);
  });

  it("testApiKey extracts JSON error.message and truncates when long", async () => {
    const longMessage = "e".repeat(300);
    const jsonBody = JSON.stringify({ error: { message: longMessage } });
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => jsonBody,
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    const providerPart = result.error!.replace("API error: 500 ", "");
    expect(providerPart).toBe(longMessage.slice(0, 200) + "...");
  });

  it("testApiKey uses JSON error.message directly when under 200 chars", async () => {
    const jsonBody = JSON.stringify({ error: { message: "short message" } });
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => jsonBody,
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.error).toBe("API error: 500 short message");
  });

  it("testApiKey falls back to raw text when JSON lacks error.message", async () => {
    const jsonBody = JSON.stringify({ foo: "bar" });
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => jsonBody,
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.error).toBe('API error: 500 {"foo":"bar"}');
  });

  it("testApiKey truncates malformed JSON as raw text", async () => {
    const notJson = "not json{{{".repeat(40);
    mockFetch(
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => notJson,
          }) as unknown as Response
      ) as unknown as typeof fetch
    );

    const result = await new AppAgentService().testApiKey("k");
    expect(result.valid).toBe(false);
    const providerPart = result.error!.replace("API error: 500 ", "");
    expect(providerPart).toBe(notJson.slice(0, 200) + "...");
  });
});

const transportMethods = [
  {
    method: "testApiKey",
    sentKey: "renderer-key",
    run: (service: AppAgentService) => service.testApiKey("renderer-key"),
  },
  {
    method: "testModel",
    sentKey: "stored-key",
    run: (service: AppAgentService) => service.testModel("some-model"),
  },
] as const;

describe.each(transportMethods)(
  "AppAgentService $method base URL transport",
  ({ run, sentKey }) => {
    it.each([
      "http://api.example.com/v1",
      "http://192.168.1.10:8000/v1",
      "http://10.0.0.5/v1",
      "http://172.16.0.1/v1",
      "http://169.254.169.254/latest",
      "http://[fd00::1]/v1",
      "http://[fe80::1]/v1",
      "http://0.0.0.0:11434/v1",
      "http://[::]:11434/v1",
      "http://[::ffff:8.8.8.8]/v1",
      "http://[::127.0.0.1]/v1",
      "http://[64:ff9b::7f00:1]/v1",
      "http://134744072/v1",
      "http://api.localhost:8080/v1",
      "http://localhost.evil.example/v1",
      "http://127.0.0.1.nip.io/v1",
      "http://127.0.0.1@evil.example/v1",
      "http://evil.example#http://localhost",
      "HTTP://API.EXAMPLE.COM/v1",
    ])("refuses to send the key over plain HTTP to %s", async (baseUrl) => {
      setConfig({ apiKey: "stored-key", model: "m", baseUrl });
      const fetchSpy = vi.fn();
      mockFetch(fetchSpy as unknown as typeof fetch);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const result = await run(new AppAgentService());

      expect(result).toEqual({
        valid: false,
        error: "Base URL must use HTTPS except for loopback hosts",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it.each([
      "file:///tmp/models",
      "ftp://example.com/v1",
      "ws://localhost:8080/v1",
      "data:text/plain,",
    ])("rejects the non-HTTP scheme in %s without calling fetch", async (baseUrl) => {
      setConfig({ apiKey: "stored-key", model: "m", baseUrl });
      const fetchSpy = vi.fn();
      mockFetch(fetchSpy as unknown as typeof fetch);

      const result = await run(new AppAgentService());

      expect(result).toEqual({ valid: false, error: "Invalid base URL configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, `${APP_AGENT_DEFAULT_BASE_URL}/chat/completions`],
      ["", `${APP_AGENT_DEFAULT_BASE_URL}/chat/completions`],
      ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
      ["https://10.0.0.5/v1", "https://10.0.0.5/v1/chat/completions"],
      ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"],
      ["http://LOCALHOST.:1234/v1", "http://localhost.:1234/v1/chat/completions"],
      ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1/chat/completions"],
      ["http://127.255.255.254/v1", "http://127.255.255.254/v1/chat/completions"],
      ["http://127.0.0.1./v1", "http://127.0.0.1/v1/chat/completions"],
      ["http://[::1]:8080/v1", "http://[::1]:8080/v1/chat/completions"],
      ["http://[0:0:0:0:0:0:0:1]/v1", "http://[::1]/v1/chat/completions"],
      ["http://[::ffff:127.0.0.1]/v1", "http://[::ffff:7f00:1]/v1/chat/completions"],
      ["http://2130706433/v1", "http://127.0.0.1/v1/chat/completions"],
      ["http://0x7f000001/v1", "http://127.0.0.1/v1/chat/completions"],
    ])("sends the key to %s as %s", async (baseUrl, expectedUrl) => {
      setConfig({ apiKey: "stored-key", model: "m", baseUrl });
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
      mockFetch(fetchSpy as unknown as typeof fetch);

      const result = await run(new AppAgentService());

      expect(result).toEqual({ valid: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${sentKey}` }),
        })
      );
    });
  }
);
