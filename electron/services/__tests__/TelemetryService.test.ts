import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

const sentryInitMock = vi.hoisted(() => vi.fn());
const captureEventMock = vi.hoisted(() => vi.fn(() => "mock-event-id"));
const sentryCloseMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const sentrySetTagMock = vi.hoisted(() => vi.fn());

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
}));

import {
  sanitizePath,
  initializeTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
  setTelemetryLevel,
  getTelemetryLevel,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  trackEvent,
  _getPreConsentBufferLength,
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
