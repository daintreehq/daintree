import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

const sentryInitMock = vi.hoisted(() => vi.fn());
const captureEventMock = vi.hoisted(() => vi.fn(() => "mock-event-id"));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {
    telemetry: { enabled: false, hasSeenPrompt: false },
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
}));

import {
  sanitizePath,
  initializeTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  trackEvent,
  _getPreConsentBufferLength,
} from "../TelemetryService.js";

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

describe("isTelemetryEnabled", () => {
  beforeEach(() => {
    storeMock.get.mockImplementation((key: string) => {
      if (key === "telemetry") return { enabled: false, hasSeenPrompt: false };
      return undefined;
    });
    vi.clearAllMocks();
    storeMock.get.mockImplementation((key: string) => {
      if (key === "telemetry") return { enabled: false, hasSeenPrompt: false };
      return undefined;
    });
  });

  it("returns false when disabled", () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns true when enabled", () => {
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns false when telemetry key is undefined", () => {
    storeMock.get.mockReturnValue(undefined);
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("setTelemetryEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
  });

  it("stores enabled=true", async () => {
    await setTelemetryEnabled(true);
    expect(storeMock.set).toHaveBeenCalledWith("telemetry", {
      enabled: true,
      hasSeenPrompt: false,
    });
  });

  it("stores enabled=false", async () => {
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
    await setTelemetryEnabled(false);
    expect(storeMock.set).toHaveBeenCalledWith("telemetry", {
      enabled: false,
      hasSeenPrompt: true,
    });
  });
});

describe("hasTelemetryPromptBeenShown", () => {
  it("returns false when not shown", () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    expect(hasTelemetryPromptBeenShown()).toBe(false);
  });

  it("returns true when shown", () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: true });
    expect(hasTelemetryPromptBeenShown()).toBe(true);
  });
});

describe("markTelemetryPromptShown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
  });

  it("sets hasSeenPrompt to true", () => {
    markTelemetryPromptShown();
    expect(storeMock.set).toHaveBeenCalledWith("telemetry", {
      enabled: false,
      hasSeenPrompt: true,
    });
  });
});

describe("sanitizeEvent (via beforeSend logic)", () => {
  it("sanitizes stack frame filenames", () => {
    const filename = "/Users/johndoe/projects/daintree/electron/main.ts";
    expect(sanitizePath(filename)).toBe("/Users/USER/projects/daintree/electron/main.ts");
  });

  it("sanitizes error message text containing paths", () => {
    const msg = "ENOENT: no such file or directory, open '/Users/alice/code/app/config.json'";
    expect(sanitizePath(msg)).toBe(
      "ENOENT: no such file or directory, open '/Users/USER/code/app/config.json'"
    );
  });

  it("sanitizes Windows-style forward-slash paths", () => {
    expect(sanitizePath("C:/Users/bob/AppData/Roaming/daintree/log.txt")).toBe(
      "C:/Users/USER/AppData/Roaming/daintree/log.txt"
    );
  });
});

describe("initializeTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentryInitMock.mockReset();
  });

  it("does not call Sentry.init when telemetry is disabled", async () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    await initializeTelemetry();
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it("does not call Sentry.init when DSN is empty", async () => {
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "";
    await initializeTelemetry();
    expect(sentryInitMock).not.toHaveBeenCalled();
    process.env.SENTRY_DSN = original;
  });

  it("does not drop error events via sampleRate when initialized", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
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
  beforeEach(() => {
    vi.clearAllMocks();
    captureEventMock.mockClear();
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    // Clear the buffer by disabling telemetry
    // (preConsentBuffer.length = 0 happens inside setTelemetryEnabled(false))
  });

  it("buffers events before consent is decided", async () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBeGreaterThan(0);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("drops events when consent was explicitly denied", async () => {
    // Clear buffer first
    await setTelemetryEnabled(false);
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: true });
    const before = _getPreConsentBufferLength();
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBe(before);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("sends directly when telemetry is enabled and Sentry is initialized", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    storeMock._data.telemetry = { enabled: true, hasSeenPrompt: true };
    storeMock._data.privacy = { telemetryLevel: "full", logRetentionDays: 30 };
    storeMock.get.mockImplementation((key: string) => storeMock._data[key]);
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
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    trackEvent("onboarding_step_viewed", { step: "agentSelection" });
    // store.set should NOT have been called with any buffer data
    for (const call of storeMock.set.mock.calls) {
      expect(call[0]).not.toContain("buffer");
    }
  });
});

describe("setTelemetryEnabled with buffer", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    captureEventMock.mockClear();
    // Clean buffer
    await setTelemetryEnabled(false);
  });

  it("flushes buffered events on consent", async () => {
    const original = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://test@sentry.io/123";

    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    trackEvent("onboarding_step_viewed", { step: "agentSelection" });

    // Now enable — this should flush
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
    captureEventMock.mockClear();
    await setTelemetryEnabled(true);

    expect(captureEventMock).toHaveBeenCalledTimes(2);
    expect(_getPreConsentBufferLength()).toBe(0);

    process.env.SENTRY_DSN = original;
  });

  it("discards buffer when consent denied", async () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    trackEvent("onboarding_step_viewed", { step: "telemetry" });
    expect(_getPreConsentBufferLength()).toBeGreaterThan(0);

    await setTelemetryEnabled(false);
    expect(_getPreConsentBufferLength()).toBe(0);
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it("respects buffer cap", async () => {
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });
    // Clear buffer
    await setTelemetryEnabled(false);
    storeMock.get.mockReturnValue({ enabled: false, hasSeenPrompt: false });

    for (let i = 0; i < 110; i++) {
      trackEvent("onboarding_step_viewed", { step: "telemetry", i });
    }
    expect(_getPreConsentBufferLength()).toBe(100);
  });
});
