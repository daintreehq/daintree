import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

const sentryInitMock = vi.hoisted(() => vi.fn());

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
}));

import {
  sanitizePath,
  initializeTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
} from "../TelemetryService.js";

describe("sanitizePath", () => {
  it("redacts macOS home dir username", () => {
    expect(sanitizePath("/Users/johndoe/Projects/canopy/src/main.ts")).toBe(
      "/Users/USER/Projects/canopy/src/main.ts"
    );
  });

  it("redacts actual os.homedir() value", () => {
    const home = os.homedir();
    const result = sanitizePath(`${home}/Projects/canopy/src/main.ts`);
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

  it("stores enabled=true", () => {
    setTelemetryEnabled(true);
    expect(storeMock.set).toHaveBeenCalledWith("telemetry", {
      enabled: true,
      hasSeenPrompt: false,
    });
  });

  it("stores enabled=false", () => {
    storeMock.get.mockReturnValue({ enabled: true, hasSeenPrompt: true });
    setTelemetryEnabled(false);
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
    const filename = "/Users/johndoe/projects/canopy/electron/main.ts";
    expect(sanitizePath(filename)).toBe("/Users/USER/projects/canopy/electron/main.ts");
  });

  it("sanitizes error message text containing paths", () => {
    const msg = "ENOENT: no such file or directory, open '/Users/alice/code/app/config.json'";
    expect(sanitizePath(msg)).toBe(
      "ENOENT: no such file or directory, open '/Users/USER/code/app/config.json'"
    );
  });

  it("sanitizes Windows-style forward-slash paths", () => {
    expect(sanitizePath("C:/Users/bob/AppData/Roaming/canopy/log.txt")).toBe(
      "C:/Users/USER/AppData/Roaming/canopy/log.txt"
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
});
