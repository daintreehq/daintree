import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

const sentryInitMock = vi.hoisted(() => vi.fn());
const captureEventMock = vi.hoisted(() => vi.fn(() => "mock-event-id"));
const sentryCloseMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const sentrySetTagMock = vi.hoisted(() => vi.fn());
const sentryAddBreadcrumbMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {
    privacy: { telemetryLevel: "off", hasSeenPrompt: false, logRetentionDays: 30 },
  };
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../store.js", () => ({ store: storeMock }));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", isPackaged: false },
}));

vi.mock("@sentry/electron/main", () => ({
  init: sentryInitMock,
  captureEvent: captureEventMock,
  close: sentryCloseMock,
  setTag: sentrySetTagMock,
  addBreadcrumb: sentryAddBreadcrumbMock,
}));

import {
  sanitizePath,
  sanitizeEvent,
  initializeTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
  setTelemetryLevel,
  getTelemetryLevel,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  trackEvent,
  _getPreConsentBufferLength,
  type SentryEvent,
} from "../TelemetryService.js";

function setPrivacy(patch: {
  telemetryLevel?: "off" | "errors" | "full";
  hasSeenPrompt?: boolean;
}) {
  storeMock._data.privacy = {
    telemetryLevel: "off",
    hasSeenPrompt: false,
    logRetentionDays: 30,
    ...(storeMock._data.privacy as Record<string, unknown>),
    ...patch,
  };
  storeMock.get.mockImplementation((key: string) => storeMock._data[key]);
}

describe("sanitizePath", () => {
  it("redacts macOS home dir username", () => {
    expect(sanitizePath("/Users/johndoe/Projects/daintree/src/main.ts")).toBe(
      "/Users/USER/Projects/daintree/src/main.ts"
    );
  });

  it("redacts actual os.homedir() value", () => {
    const home = os.homedir();
    const result = sanitizePath(`${home}/Projects/daintree/src/main.ts`);
    expect(result).not.toContain(home);
  });

  it("redacts Linux home dir username", () => {
    expect(sanitizePath("/home/johndoe/code/app/index.js")).toBe("/home/USER/code/app/index.js");
  });

  it("redacts Windows home dir username", () => {
    expect(sanitizePath("C:\\Users\\johndoe\\Documents\\project\\file.ts")).toBe(
      "C:\\Users\\USER\\Documents\\project\\file.ts"
    );
  });

  it("leaves paths without username unchanged", () => {
    expect(sanitizePath("/usr/local/lib/node_modules/foo")).toBe("/usr/local/lib/node_modules/foo");
  });

  it("handles multiple occurrences", () => {
    const result = sanitizePath("/Users/alice/foo and /Users/bob/bar");
    expect(result).toBe("/Users/USER/foo and /Users/USER/bar");
  });
});

describe("sanitizeEvent", () => {
  it("scrubs a GitHub PAT from event.message", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456";
    const event: SentryEvent = {
      message: `failed to clone with token ${secret}`,
    };
    const result = sanitizeEvent(event);
    expect(result?.message).toBe("failed to clone with token [REDACTED]");
    expect(result?.message).not.toContain(secret);
  });

  it("scrubs a Bearer token from exception.values[].value", () => {
    const event: SentryEvent = {
      exception: {
        values: [
          {
            value: "401 Unauthorized: sent Authorization: Bearer abcdefghij.klmnop-qr_st=",
          },
        ],
      },
    };
    const result = sanitizeEvent(event);
    const value = result?.exception?.values?.[0]?.value ?? "";
    expect(value).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(value).toContain("Bearer [REDACTED]");
  });

  it("scrubs an AWS access key from a breadcrumb message", () => {
    const event: SentryEvent = {
      breadcrumbs: [
        {
          message: "env: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        },
      ],
    };
    const result = sanitizeEvent(event);
    const bc = result?.breadcrumbs?.[0];
    expect(bc?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(bc?.message).toContain("[REDACTED]");
  });

  it("scrubs a token from a breadcrumb.data string value", () => {
    const event: SentryEvent = {
      breadcrumbs: [
        {
          message: "request",
          data: {
            url: "https://example.com/",
            body: "access_token=supersecrettokenvalue&other=1",
          },
        },
      ],
    };
    const result = sanitizeEvent(event);
    const body = result?.breadcrumbs?.[0]?.data?.body as string;
    expect(body).toBe("access_token=[REDACTED]&other=1");
  });

  it("scrubs an Anthropic key from event.extra string value", () => {
    const secret = `sk-ant-${"a".repeat(95)}`;
    const event: SentryEvent = {
      extra: {
        apiKeyMention: `key is ${secret} in config`,
        numericField: 42,
      },
    };
    const result = sanitizeEvent(event);
    expect(result?.extra?.apiKeyMention).toBe("key is [REDACTED] in config");
    expect(result?.extra?.apiKeyMention).not.toContain(secret);
    // non-string values are left alone
    expect(result?.extra?.numericField).toBe(42);
  });

  it("passes benign strings through unchanged", () => {
    const event: SentryEvent = {
      message: "User 42 signed in at 2026-04-18 from Los Angeles",
      breadcrumbs: [{ message: "navigated to /dashboard" }],
    };
    const result = sanitizeEvent(event);
    expect(result?.message).toBe("User 42 signed in at 2026-04-18 from Los Angeles");
    expect(result?.breadcrumbs?.[0]?.message).toBe("navigated to /dashboard");
  });

  it("is idempotent — sanitizing the same event twice leaves it unchanged", () => {
    const event: SentryEvent = {
      message: "failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
      exception: { values: [{ value: "Bearer abcdefghij.klmnop-qr_st=" }] },
    };
    // Mutate in place twice — sanitizeEvent mutates the passed object.
    sanitizeEvent(event);
    const afterFirst = JSON.parse(JSON.stringify(event)) as SentryEvent;
    sanitizeEvent(event);
    expect(event).toEqual(afterFirst);
    expect(event.message).toBe("failed with token [REDACTED]");
    expect(event.exception?.values?.[0]?.value).toBe("Bearer [REDACTED]");
  });

  it("recurses into nested breadcrumb.data objects and arrays", () => {
    const event: SentryEvent = {
      breadcrumbs: [
        {
          message: "http request",
          data: {
            request: {
              headers: {
                authorization: "Bearer abcdefghij.klmnop-qr_st=",
              },
            },
            trailers: [{ token: `sk-${"A".repeat(48)}` }],
          },
        },
      ],
    };
    const result = sanitizeEvent(event);
    const data = result?.breadcrumbs?.[0]?.data as {
      request: { headers: { authorization: string } };
      trailers: Array<{ token: string }>;
    };
    expect(data.request.headers.authorization).toBe("Bearer [REDACTED]");
    expect(data.trailers[0]?.token).toBe("[REDACTED]");
  });

  it("recurses into nested event.extra objects and arrays", () => {
    const event: SentryEvent = {
      extra: {
        diagnostic: {
          env: {
            AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          },
          errors: ["failed to read token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456"],
        },
      },
    };
    const result = sanitizeEvent(event);
    const diag = result?.extra?.diagnostic as {
      env: { AWS_ACCESS_KEY_ID: string };
      errors: string[];
    };
    expect(diag.env.AWS_ACCESS_KEY_ID).toBe("[REDACTED]");
    expect(diag.errors[0]).not.toContain("ghp_");
    expect(diag.errors[0]).toContain("[REDACTED]");
  });

  it("survives null elements in exception.values without throwing", () => {
    const event = {
      exception: {
        values: [null, { value: "Bearer abcdefghij.klmnop-qr_st=" }],
      },
    } as unknown as SentryEvent;
    expect(() => sanitizeEvent(event)).not.toThrow();
    const result = sanitizeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.exception?.values?.[1]?.value).toBe("Bearer [REDACTED]");
  });

  it("survives null elements in breadcrumbs without throwing", () => {
    const event = {
      breadcrumbs: [null, { message: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456" }],
    } as unknown as SentryEvent;
    expect(() => sanitizeEvent(event)).not.toThrow();
    const result = sanitizeEvent(event);
    expect(result?.breadcrumbs?.[1]?.message).toContain("[REDACTED]");
    expect(result?.breadcrumbs?.[1]?.message).not.toContain("ghp_");
  });

  it("clears username, password, search, and hash from request.url", () => {
    const event: SentryEvent = {
      request: {
        url: "https://user:pat@api.example.com/path?access_token=abc#token=xyz",
      },
    };
    const result = sanitizeEvent(event);
    expect(result?.request?.url).toBe("https://api.example.com/path");
  });

  it("scrubs a relative URL in-place when URL() throws", () => {
    const event: SentryEvent = {
      request: {
        url: "/oauth/callback?code=supersecretcode123&state=abc",
      },
    };
    const result = sanitizeEvent(event);
    // `new URL("/oauth/callback...")` throws, so the catch branch runs
    // sanitizeString on the raw string — `code=` matches the oauth pattern.
    expect(result?.request?.url).toContain("code=[REDACTED]");
    expect(result?.request?.url).not.toContain("supersecretcode123");
  });

  it("scrubs Bearer tokens in request.headers", () => {
    const event: SentryEvent = {
      request: {
        url: "https://api.example.com/",
        headers: {
          authorization: "Bearer abcdefghij.klmnop-qr_st=",
          "x-trace-id": "keep-this",
        },
      },
    };
    const result = sanitizeEvent(event);
    expect(result?.request?.headers?.authorization).toBe("Bearer [REDACTED]");
    expect(result?.request?.headers?.["x-trace-id"]).toBe("keep-this");
  });

  it("scrubs secrets in request.cookies, request.data, and request.query_string", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456";
    const event: SentryEvent = {
      request: {
        cookies: `session=${secret}; flavor=chocolate`,
        data: { payload: `token=${secret}` },
        query_string: `token=${secret}`,
      },
    };
    const result = sanitizeEvent(event);
    expect(result?.request?.cookies).not.toContain(secret);
    expect((result?.request?.data as { payload: string }).payload).not.toContain(secret);
    expect(result?.request?.query_string).not.toContain(secret);
  });

  it("scrubs a secret nested deeper than the recursion cap (depth 11+)", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456";
    const event: SentryEvent = {
      extra: {
        a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: secret } } } } } } } } } },
      },
    };
    const result = sanitizeEvent(event);
    // Serialize and assert the raw secret is nowhere — scalar leaves must
    // scrub regardless of depth even though descent halts past the cap.
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns null when sanitization throws (fail-closed)", () => {
    const event = {
      // Getter that throws — forces the outer try/catch to kick in. If
      // sanitizeEvent returned the event, the throw-source string would
      // leak unscrubbed.
      get message(): string {
        throw new Error("boom");
      },
    } as unknown as SentryEvent;
    expect(sanitizeEvent(event)).toBeNull();
  });
});

describe("getTelemetryLevel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off" });
  });

  it("returns the stored privacy.telemetryLevel", () => {
    setPrivacy({ telemetryLevel: "errors" });
    expect(getTelemetryLevel()).toBe("errors");
  });

  it("returns 'off' when privacy is missing", () => {
    storeMock.get.mockReturnValue(undefined);
    expect(getTelemetryLevel()).toBe("off");
  });

  it("does NOT write to the store on read (no lazy migration)", () => {
    storeMock.get.mockReturnValue(undefined);
    getTelemetryLevel();
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("isTelemetryEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when level is 'off'", () => {
    setPrivacy({ telemetryLevel: "off" });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns true when level is 'errors'", () => {
    setPrivacy({ telemetryLevel: "errors" });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns true when level is 'full'", () => {
    setPrivacy({ telemetryLevel: "full" });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns false when privacy is undefined", () => {
    storeMock.get.mockReturnValue(undefined);
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("setTelemetryLevel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
  });

  it("writes telemetryLevel to privacy without touching any legacy telemetry key", async () => {
    await setTelemetryLevel("errors");
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "errors" })
    );
    for (const call of storeMock.set.mock.calls) {
      expect(call[0]).not.toBe("telemetry");
    }
  });

  it("preserves hasSeenPrompt when writing telemetryLevel", async () => {
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: true });
    await setTelemetryLevel("full");
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "full", hasSeenPrompt: true })
    );
  });
});

describe("setTelemetryLevel — onboarding_complete re-stamp", () => {
  // Use isolated module instances so each test starts with a clean `initialized` flag.
  async function loadFreshModule() {
    vi.resetModules();
    return await import("../TelemetryService.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
  });

  it("re-stamps onboarding_complete=true when switching mid-session to 'full' while onboarding is complete", async () => {
    storeMock._data.onboarding = {
      completed: true,
    } as unknown as typeof storeMock._data.onboarding;
    const mod = await loadFreshModule();
    await mod.setTelemetryLevel("full");
    expect(sentrySetTagMock).toHaveBeenCalledWith("onboarding_complete", "true");
  });

  it("re-stamps onboarding_complete=false when switching mid-session to 'errors' while onboarding is incomplete", async () => {
    storeMock._data.onboarding = {
      completed: false,
    } as unknown as typeof storeMock._data.onboarding;
    const mod = await loadFreshModule();
    await mod.setTelemetryLevel("errors");
    expect(sentrySetTagMock).toHaveBeenCalledWith("onboarding_complete", "false");
  });

  it("does NOT re-stamp when switching to 'off' (SDK is unloaded)", async () => {
    storeMock._data.onboarding = {
      completed: true,
    } as unknown as typeof storeMock._data.onboarding;
    const mod = await loadFreshModule();
    setPrivacy({ telemetryLevel: "full" });
    sentrySetTagMock.mockClear();
    await mod.setTelemetryLevel("off");
    expect(sentrySetTagMock).not.toHaveBeenCalled();
  });
});

describe("setOnboardingCompleteTag", () => {
  async function loadFreshModule() {
    vi.resetModules();
    return await import("../TelemetryService.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
  });

  it("is a safe no-op when Sentry has not been initialized", async () => {
    const mod = await loadFreshModule();
    expect(() => mod.setOnboardingCompleteTag(true)).not.toThrow();
    expect(sentrySetTagMock).not.toHaveBeenCalled();
  });

  it("calls Sentry.setTag with string booleans once Sentry is initialized", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    process.env.SENTRY_DSN = "https://example@sentry.io/123";
    try {
      const mod = await loadFreshModule();
      await mod.initializeTelemetry();
      mod.setOnboardingCompleteTag(true);
      expect(sentrySetTagMock).toHaveBeenCalledWith("onboarding_complete", "true");
      mod.setOnboardingCompleteTag(false);
      expect(sentrySetTagMock).toHaveBeenCalledWith("onboarding_complete", "false");
    } finally {
      delete process.env.SENTRY_DSN;
    }
  });
});

describe("setTelemetryEnabled (compat shim)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off" });
  });

  it("maps true to 'errors'", async () => {
    await setTelemetryEnabled(true);
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "errors" })
    );
  });

  it("maps false to 'off'", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    await setTelemetryEnabled(false);
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "off" })
    );
  });
});

describe("hasTelemetryPromptBeenShown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads privacy.hasSeenPrompt", () => {
    setPrivacy({ hasSeenPrompt: true });
    expect(hasTelemetryPromptBeenShown()).toBe(true);
  });

  it("returns false when not shown", () => {
    setPrivacy({ hasSeenPrompt: false });
    expect(hasTelemetryPromptBeenShown()).toBe(false);
  });

  it("returns false when privacy is missing", () => {
    storeMock.get.mockReturnValue(undefined);
    expect(hasTelemetryPromptBeenShown()).toBe(false);
  });
});

describe("markTelemetryPromptShown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
  });

  it("writes hasSeenPrompt=true on the privacy object (not telemetry)", () => {
    markTelemetryPromptShown();
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ hasSeenPrompt: true })
    );
    for (const call of storeMock.set.mock.calls) {
      expect(call[0]).not.toBe("telemetry");
    }
  });

  it("preserves telemetryLevel and other privacy fields", () => {
    setPrivacy({ telemetryLevel: "full", hasSeenPrompt: false });
    markTelemetryPromptShown();
    expect(storeMock.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "full", hasSeenPrompt: true })
    );
  });
});

describe("initializeTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentryInitMock.mockReset();
  });

  it("does not call Sentry.init when telemetry level is 'off'", async () => {
    setPrivacy({ telemetryLevel: "off" });
    await initializeTelemetry();
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it("does not call Sentry.init when DSN is empty", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "";
    await initializeTelemetry();
    expect(sentryInitMock).not.toHaveBeenCalled();
    process.env.SENTRY_DSN = original;
  });

  // Covers both #5259 (sampleRate must be absent so SDK defaults to 100% capture)
  // and #5262 (init gates on privacy.telemetryLevel, not a legacy telemetry key).
  it("initializes via privacy.telemetryLevel without setting sampleRate", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    await initializeTelemetry();
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    const options = sentryInitMock.mock.calls[0][0] as Record<string, unknown>;
    // sampleRate must not be set at all — the SDK default is 1.0 (100%
    // capture) and any value < 1 silently drops that fraction of crash
    // reports. Fail closed so reintroduction at any value is caught. See #5255.
    expect(options).not.toHaveProperty("sampleRate");
    process.env.SENTRY_DSN = original;
  });
});

describe("trackEvent", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    captureEventMock.mockClear();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    await setTelemetryEnabled(false); // clears buffer
  });

  it("buffers events before consent is decided", () => {
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBeGreaterThan(0);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("drops events when consent was explicitly denied", async () => {
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: true });
    const before = _getPreConsentBufferLength();
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBe(before);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("sends directly when telemetry is at 'full' and Sentry is initialized", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    setPrivacy({ telemetryLevel: "full", hasSeenPrompt: true });
    await initializeTelemetry();
    captureEventMock.mockClear();

    trackEvent("onboarding_completed", { totalSteps: 3 });
    expect(captureEventMock).toHaveBeenCalledTimes(1);
    expect(captureEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "onboarding_completed",
        tags: { kind: "analytics" },
      })
    );
    process.env.SENTRY_DSN = original;
  });

  it("does not write buffer contents to the store", () => {
    storeMock.set.mockClear();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    trackEvent("onboarding_step_viewed", { step: "agentSelection" });
    for (const call of storeMock.set.mock.calls) {
      expect(call[0]).not.toContain("buffer");
    }
  });
});

describe("setTelemetryLevel with buffer", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    captureEventMock.mockClear();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    await setTelemetryEnabled(false);
  });

  it("flushes buffered events on consent", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";

    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    trackEvent("onboarding_step_viewed", { step: "agentSelection" });

    setPrivacy({ telemetryLevel: "full", hasSeenPrompt: true });
    captureEventMock.mockClear();
    await setTelemetryLevel("full");

    expect(captureEventMock).toHaveBeenCalledTimes(2);
    expect(_getPreConsentBufferLength()).toBe(0);

    process.env.SENTRY_DSN = original;
  });

  it("discards buffer when consent denied", async () => {
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBeGreaterThan(0);

    await setTelemetryLevel("off");
    expect(_getPreConsentBufferLength()).toBe(0);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("drops (does NOT flush) the buffer at 'errors' level", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";

    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    trackEvent("onboarding_step_viewed", { step: "agentSelection" });
    expect(_getPreConsentBufferLength()).toBe(2);

    setPrivacy({ telemetryLevel: "errors", hasSeenPrompt: true });
    captureEventMock.mockClear();
    await setTelemetryLevel("errors");

    // "errors" permits crash reports only — analytics events must NOT be replayed.
    expect(captureEventMock).not.toHaveBeenCalled();
    expect(_getPreConsentBufferLength()).toBe(0);

    process.env.SENTRY_DSN = original;
  });

  it("respects buffer cap", async () => {
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
    await setTelemetryLevel("off");
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });

    for (let i = 0; i < 110; i++) {
      trackEvent("onboarding_step_viewed", { step: "telemetry", i });
    }
    expect(_getPreConsentBufferLength()).toBe(100);
  });
});

describe("closeTelemetry", () => {
  // Use isolated module instances so each test starts with a clean `initialized` flag.
  async function loadFreshModule() {
    vi.resetModules();
    return await import("../TelemetryService.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sentryCloseMock.mockReset();
    sentryCloseMock.mockResolvedValue(true);
  });

  it("is a no-op when telemetry was never initialized", async () => {
    const mod = await loadFreshModule();
    await mod.closeTelemetry();
    expect(sentryCloseMock).not.toHaveBeenCalled();
  });

  it("calls Sentry.close(2000) after init", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock._data.telemetry = { enabled: true, hasSeenPrompt: true };
    storeMock._data.privacy = { telemetryLevel: "errors", logRetentionDays: 30 };
    storeMock.get.mockImplementation((key: string) => storeMock._data[key]);

    const mod = await loadFreshModule();
    await mod.initializeTelemetry();
    await mod.closeTelemetry();

    expect(sentryCloseMock).toHaveBeenCalledTimes(1);
    expect(sentryCloseMock).toHaveBeenCalledWith(2000);

    process.env.SENTRY_DSN = original;
  });

  it("swallows rejection from Sentry.close", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock._data.telemetry = { enabled: true, hasSeenPrompt: true };
    storeMock._data.privacy = { telemetryLevel: "errors", logRetentionDays: 30 };
    storeMock.get.mockImplementation((key: string) => storeMock._data[key]);

    const mod = await loadFreshModule();
    await mod.initializeTelemetry();
    sentryCloseMock.mockRejectedValueOnce(new Error("transport exploded"));

    await expect(mod.closeTelemetry()).resolves.toBeUndefined();

    process.env.SENTRY_DSN = original;
  });

  it("is idempotent — second call is a no-op", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock._data.telemetry = { enabled: true, hasSeenPrompt: true };
    storeMock._data.privacy = { telemetryLevel: "errors", logRetentionDays: 30 };
    storeMock.get.mockImplementation((key: string) => storeMock._data[key]);

    const mod = await loadFreshModule();
    await mod.initializeTelemetry();
    await mod.closeTelemetry();
    expect(sentryCloseMock).toHaveBeenCalledTimes(1);

    await mod.closeTelemetry();
    expect(sentryCloseMock).toHaveBeenCalledTimes(1);

    process.env.SENTRY_DSN = original;
  });

  it("stops capturing new events after close", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock._data.telemetry = { enabled: true, hasSeenPrompt: true };
    storeMock._data.privacy = { telemetryLevel: "full", logRetentionDays: 30 };
    storeMock.get.mockImplementation((key: string) => storeMock._data[key]);

    const mod = await loadFreshModule();
    await mod.initializeTelemetry();
    captureEventMock.mockClear();

    await mod.closeTelemetry();
    mod.trackEvent("post_close_event", {});
    expect(captureEventMock).not.toHaveBeenCalled();

    process.env.SENTRY_DSN = original;
  });
});

describe("addActionBreadcrumb", () => {
  async function loadFreshModule() {
    vi.resetModules();
    return await import("../TelemetryService.js");
  }

  const crumb = {
    id: "abc",
    actionId: "foo.bar",
    category: "preferences",
    source: "user" as const,
    durationMs: 7,
    timestamp: 1_700_000_000_000,
    count: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sentryAddBreadcrumbMock.mockReset();
    setPrivacy({ telemetryLevel: "off", hasSeenPrompt: false });
  });

  it("is a no-op when telemetry is off (no Sentry call)", async () => {
    const mod = await loadFreshModule();
    mod.addActionBreadcrumb(crumb);
    expect(sentryAddBreadcrumbMock).not.toHaveBeenCalled();
  });

  it("is a no-op when Sentry has not been initialized yet", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const mod = await loadFreshModule();
    // No initializeTelemetry() call — sentryModule is null
    mod.addActionBreadcrumb(crumb);
    expect(sentryAddBreadcrumbMock).not.toHaveBeenCalled();
  });

  it("calls Sentry.addBreadcrumb with Unix seconds timestamp and dotted category once initialized", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    try {
      const mod = await loadFreshModule();
      await mod.initializeTelemetry();
      mod.addActionBreadcrumb(crumb);
      expect(sentryAddBreadcrumbMock).toHaveBeenCalledTimes(1);
      const arg = sentryAddBreadcrumbMock.mock.calls[0]![0];
      expect(arg.category).toBe("action.preferences");
      expect(arg.message).toBe("foo.bar");
      expect(arg.timestamp).toBe(1_700_000_000); // seconds, not ms
      expect(arg.level).toBe("info");
      expect(arg.data).toMatchObject({ source: "user", durationMs: 7 });
      expect(arg.data.count).toBeUndefined();
    } finally {
      process.env.SENTRY_DSN = original;
    }
  });

  it("includes count only when greater than 1", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    try {
      const mod = await loadFreshModule();
      await mod.initializeTelemetry();
      mod.addActionBreadcrumb({ ...crumb, count: 3 });
      const arg = sentryAddBreadcrumbMock.mock.calls[0]![0];
      expect(arg.data.count).toBe(3);
    } finally {
      process.env.SENTRY_DSN = original;
    }
  });

  it("includes args when present on the breadcrumb", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    try {
      const mod = await loadFreshModule();
      await mod.initializeTelemetry();
      mod.addActionBreadcrumb({ ...crumb, args: { show: true } });
      const arg = sentryAddBreadcrumbMock.mock.calls[0]![0];
      expect(arg.data.args).toEqual({ show: true });
    } finally {
      process.env.SENTRY_DSN = original;
    }
  });

  it("swallows errors thrown by Sentry.addBreadcrumb", async () => {
    setPrivacy({ telemetryLevel: "errors" });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    try {
      const mod = await loadFreshModule();
      await mod.initializeTelemetry();
      sentryAddBreadcrumbMock.mockImplementationOnce(() => {
        throw new Error("transport failed");
      });
      expect(() => mod.addActionBreadcrumb(crumb)).not.toThrow();
    } finally {
      process.env.SENTRY_DSN = original;
    }
  });
});

describe("beforeSend wrapper (end-to-end via initializeTelemetry)", () => {
  async function loadFreshModule() {
    vi.resetModules();
    return await import("../TelemetryService.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sentryInitMock.mockReset();
    setPrivacy({ telemetryLevel: "errors", hasSeenPrompt: true });
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
  });

  it("scrubs a PAT passed through the registered beforeSend hook", async () => {
    const mod = await loadFreshModule();
    await mod.initializeTelemetry();
    const init = sentryInitMock.mock.calls[0]?.[0] as {
      beforeSend?: (event: unknown) => unknown;
    };
    expect(typeof init.beforeSend).toBe("function");

    const input = {
      message: "clone failed ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
      breadcrumbs: [
        {
          message: "http",
          data: {
            request: { headers: { authorization: "Bearer abcdefghij.klmnop-qr_st=" } },
          },
        },
      ],
      extra: { note: `key=sk-ant-${"a".repeat(95)}` },
      exception: { values: [null] },
    };
    const out = init.beforeSend?.(input) as typeof input | null;

    expect(out).not.toBeNull();
    expect(out?.message).not.toContain("ghp_");
    expect(out?.message).toContain("[REDACTED]");
    const headers = (
      out?.breadcrumbs?.[0]?.data as {
        request: { headers: { authorization: string } };
      }
    ).request.headers;
    expect(headers.authorization).toBe("Bearer [REDACTED]");
    expect(out?.extra?.note).not.toContain("sk-ant-");
    expect(out?.extra?.note).toContain("[REDACTED]");
  });
});
