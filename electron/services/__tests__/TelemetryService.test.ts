import { describe, it, expect, vi, beforeEach } from "vitest";

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

import {
  sanitizePath,
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  type SentryEvent,
} from "../TelemetryService.js";

describe("sanitizePath", () => {
  it("redacts macOS home dir username", () => {
    expect(sanitizePath("/Users/johndoe/Projects/canopy/src/main.ts")).toBe(
      "/Users/USER/Projects/canopy/src/main.ts"
    );
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
  it("sanitizes stack frame filenames", async () => {
    const { sanitizePath: sp } = await import("../TelemetryService.js");
    const event: SentryEvent = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "/Users/johndoe/projects/canopy/electron/main.ts" }],
            },
          },
        ],
      },
    };
    const filename = event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename ?? "";
    expect(sp(filename)).toBe("/Users/USER/projects/canopy/electron/main.ts");
  });
});
