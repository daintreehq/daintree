import { describe, it, expect, beforeEach, vi } from "vitest";

const { logWarnMock, logErrorMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logWarn: logWarnMock,
  logError: logErrorMock,
}));

import {
  attachRendererConsoleCapture,
  detachRendererConsoleCapture,
  getRecentPluginConsoleMessages,
  PLUGIN_CONSOLE_BUFFER_MAX,
  PLUGIN_CONSOLE_MESSAGE_MAX_CHARS,
  __resetRendererConsoleCaptureForTests,
} from "../rendererConsoleCapture.js";

type ConsoleListener = (event: unknown, ...args: unknown[]) => void;

interface MockWebContents {
  id: number;
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  /** Electron 42's shape: the details ride on the event, then the deprecated positional args. */
  emit: (details: unknown) => void;
  /** The pre-35 shape some tests and older builds produce: details as the second argument. */
  emitLegacy: (details: unknown) => void;
  navigate: () => void;
}

let nextId = 1;

function createMockWebContents(overrides: { destroyed?: boolean } = {}): MockWebContents {
  const id = nextId++;
  const listeners = new Map<string, ConsoleListener>();
  const wc: MockWebContents = {
    id,
    isDestroyed: () => overrides.destroyed === true,
    on: vi.fn((event: string, l: ConsoleListener) => {
      listeners.set(event, l);
    }),
    removeListener: vi.fn((event: string, l: ConsoleListener) => {
      if (listeners.get(event) === l) listeners.delete(event);
    }),
    emit: (details: unknown) => {
      const d = details as { message?: unknown; lineNumber?: unknown; sourceId?: unknown };
      listeners.get("console-message")?.(details, 2, d?.message, d?.lineNumber, d?.sourceId);
    },
    emitLegacy: (details: unknown) => {
      listeners.get("console-message")?.({}, details);
    },
    navigate: () => {
      listeners.get("did-navigate")?.({});
    },
  };
  return wc;
}

function makeDetails(
  level: "debug" | "info" | "warning" | "error",
  overrides: Partial<{ message: string; lineNumber: number; sourceId: string }> = {}
) {
  return {
    level,
    message: overrides.message ?? `message-${level}`,
    lineNumber: overrides.lineNumber ?? 10,
    sourceId: overrides.sourceId ?? "http://localhost/app.js",
  };
}

describe("attachRendererConsoleCapture", () => {
  beforeEach(() => {
    logWarnMock.mockClear();
    logErrorMock.mockClear();
  });

  it("routes warning messages to logWarn with renderer context", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit(makeDetails("warning", { message: "something off" }));

    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "something off",
      expect.objectContaining({
        source: "Renderer",
        sourceId: "http://localhost/app.js",
        lineNumber: 10,
        webContentsId: wc.id,
      })
    );
    expect(logErrorMock).not.toHaveBeenCalled();

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("routes error messages to logError with undefined error arg", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit(makeDetails("error", { message: "boom" }));

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "boom",
      undefined,
      expect.objectContaining({ source: "Renderer", webContentsId: wc.id })
    );

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("ignores debug and info levels", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit(makeDetails("debug"));
    wc.emit(makeDetails("info"));

    expect(logWarnMock).not.toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("rate-limits identical fingerprints to 5 per 5-second window", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 10; i++) {
      wc.emit(makeDetails("warning"));
    }

    expect(logWarnMock).toHaveBeenCalledTimes(5);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("keeps distinct fingerprints on separate quotas", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 10; i++) {
      wc.emit(makeDetails("warning", { lineNumber: 10 }));
    }
    for (let i = 0; i < 10; i++) {
      wc.emit(makeDetails("warning", { lineNumber: 20 }));
    }

    expect(logWarnMock).toHaveBeenCalledTimes(10);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("isolates rate-limit state per webContents", () => {
    const wc1 = createMockWebContents();
    const wc2 = createMockWebContents();
    attachRendererConsoleCapture(wc1 as unknown as Electron.WebContents);
    attachRendererConsoleCapture(wc2 as unknown as Electron.WebContents);

    for (let i = 0; i < 10; i++) wc1.emit(makeDetails("warning"));
    for (let i = 0; i < 10; i++) wc2.emit(makeDetails("warning"));

    expect(logWarnMock).toHaveBeenCalledTimes(10);

    __resetRendererConsoleCaptureForTests(wc1 as unknown as Electron.WebContents);
    __resetRendererConsoleCaptureForTests(wc2 as unknown as Electron.WebContents);
  });

  it("normalizes query strings in sourceId for fingerprinting", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 6; i++) {
      wc.emit(makeDetails("warning", { sourceId: `http://localhost/app.js?hmr=${i}` }));
    }

    expect(logWarnMock).toHaveBeenCalledTimes(5);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("is idempotent — attaching twice registers only one listener", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    expect(wc.on.mock.calls.filter(([event]) => event === "console-message")).toHaveLength(1);

    wc.emit(makeDetails("error"));
    expect(logErrorMock).toHaveBeenCalledTimes(1);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("does nothing if webContents is destroyed when the listener fires", () => {
    const wc = createMockWebContents({ destroyed: true });
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit(makeDetails("error"));

    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("releases quota after the rate window expires", () => {
    vi.useFakeTimers();
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 6; i++) wc.emit(makeDetails("warning"));
    expect(logWarnMock).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(5001);
    wc.emit(makeDetails("warning"));
    expect(logWarnMock).toHaveBeenCalledTimes(6);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
    vi.useRealTimers();
  });

  it("keeps warn and error quotas independent at the same source position", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 6; i++) wc.emit(makeDetails("warning"));
    for (let i = 0; i < 6; i++) wc.emit(makeDetails("error"));

    expect(logWarnMock).toHaveBeenCalledTimes(5);
    expect(logErrorMock).toHaveBeenCalledTimes(5);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("handles non-string sourceId without throwing", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    expect(() => {
      wc.emit({ level: "warning", message: "null src", lineNumber: 1, sourceId: null });
      wc.emit({ level: "warning", message: "num src", lineNumber: 2, sourceId: 42 });
      wc.emit({ level: "warning", message: "obj src", lineNumber: 3, sourceId: {} });
    }).not.toThrow();

    expect(logWarnMock).toHaveBeenCalledTimes(3);
    expect(logWarnMock.mock.calls.every((c) => c[1].sourceId === "")).toBe(true);

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });

  it("tolerates missing sourceId and lineNumber", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit({
      level: "warning",
      message: "partial details",
      lineNumber: undefined,
      sourceId: undefined,
    });

    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "partial details",
      expect.objectContaining({ source: "Renderer", sourceId: "", lineNumber: 0 })
    );

    __resetRendererConsoleCaptureForTests(wc as unknown as Electron.WebContents);
  });
});

describe("detachRendererConsoleCapture", () => {
  beforeEach(() => {
    logWarnMock.mockClear();
    logErrorMock.mockClear();
  });

  it("removes the console-message listener so post-detach emits are silent", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    wc.emit(makeDetails("warning", { message: "before" }));
    expect(logWarnMock).toHaveBeenCalledTimes(1);

    detachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    const handler = wc.on.mock.calls.find(([event]) => event === "console-message")?.[1];
    expect(wc.removeListener).toHaveBeenCalledWith("console-message", handler);

    wc.emit(makeDetails("warning", { message: "after" }));
    expect(logWarnMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when called for a webContents that was never attached", () => {
    const wc = createMockWebContents();

    expect(() => detachRendererConsoleCapture(wc as unknown as Electron.WebContents)).not.toThrow();
    expect(wc.removeListener).not.toHaveBeenCalled();
  });

  it("clears rate-limit state on detach so reattach starts with a fresh quota", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 6; i++) wc.emit(makeDetails("warning"));
    expect(logWarnMock).toHaveBeenCalledTimes(5);

    detachRendererConsoleCapture(wc as unknown as Electron.WebContents);
    attachRendererConsoleCapture(wc as unknown as Electron.WebContents);

    for (let i = 0; i < 6; i++) wc.emit(makeDetails("warning"));
    expect(logWarnMock).toHaveBeenCalledTimes(10);

    detachRendererConsoleCapture(wc as unknown as Electron.WebContents);
  });
});

describe("plugin console buffer", () => {
  const asWc = (wc: MockWebContents) => wc as unknown as Electron.WebContents;

  beforeEach(() => {
    logWarnMock.mockClear();
    logErrorMock.mockClear();
  });

  it("reads details from the event object, as Electron 42 delivers them", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc));

    wc.emit(makeDetails("error", { message: "boom" }));

    expect(logErrorMock).toHaveBeenCalledWith("boom", undefined, expect.anything());
    __resetRendererConsoleCaptureForTests(asWc(wc));
  });

  it("still reads the older second-argument shape", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc));

    wc.emitLegacy(makeDetails("warning", { message: "legacy" }));

    expect(logWarnMock).toHaveBeenCalledWith("legacy", expect.anything());
    __resetRendererConsoleCaptureForTests(asWc(wc));
  });

  it("keeps only plugin-sourced warnings and errors", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc));

    wc.emit(makeDetails("error", { message: "host", sourceId: "app://daintree/index.js" }));
    wc.emit(makeDetails("info", { sourceId: "plugin://pi-a/__dtv-1/view.js" }));
    wc.emit(
      makeDetails("error", {
        message: "mine",
        sourceId: "plugin://pi-a/__dtv-1/view.js",
        lineNumber: 3,
      })
    );

    // Only the host's line reaches the logger: a plugin's console text stays
    // in the view's buffer.
    expect(logErrorMock.mock.calls.map(([message]) => message)).toEqual(["host"]);
    expect(getRecentPluginConsoleMessages(asWc(wc))).toEqual([
      expect.objectContaining({
        level: "error",
        message: "mine",
        sourceId: "plugin://pi-a/__dtv-1/view.js",
        lineNumber: 3,
      }),
    ]);
    __resetRendererConsoleCaptureForTests(asWc(wc));
  });

  it("buffers every plugin entry, bounded to the newest", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc));

    for (let i = 0; i < PLUGIN_CONSOLE_BUFFER_MAX + 5; i++) {
      wc.emit(makeDetails("warning", { message: `m${i}`, sourceId: "plugin://pi-a/v.js" }));
    }

    const buffered = getRecentPluginConsoleMessages(asWc(wc));
    expect(buffered).toHaveLength(PLUGIN_CONSOLE_BUFFER_MAX);
    expect(buffered[0]?.message).toBe("m5");
    expect(buffered.at(-1)?.message).toBe(`m${PLUGIN_CONSOLE_BUFFER_MAX + 4}`);
    __resetRendererConsoleCaptureForTests(asWc(wc));
  });

  it("caps each message's length", () => {
    const wc = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc));

    wc.emit(
      makeDetails("error", {
        message: "x".repeat(PLUGIN_CONSOLE_MESSAGE_MAX_CHARS + 50),
        sourceId: "plugin://pi-a/v.js",
      })
    );

    const [entry] = getRecentPluginConsoleMessages(asWc(wc));
    expect(entry?.message.length).toBe(PLUGIN_CONSOLE_MESSAGE_MAX_CHARS + 1);
    __resetRendererConsoleCaptureForTests(asWc(wc));
  });

  it("keeps each view's buffer to itself and clears it on navigation and detach", () => {
    const wc1 = createMockWebContents();
    const wc2 = createMockWebContents();
    attachRendererConsoleCapture(asWc(wc1));
    attachRendererConsoleCapture(asWc(wc2));

    wc1.emit(makeDetails("error", { sourceId: "plugin://pi-a/v.js" }));
    expect(getRecentPluginConsoleMessages(asWc(wc1))).toHaveLength(1);
    expect(getRecentPluginConsoleMessages(asWc(wc2))).toEqual([]);

    wc1.navigate();
    expect(getRecentPluginConsoleMessages(asWc(wc1))).toEqual([]);

    wc2.emit(makeDetails("error", { sourceId: "plugin://pi-a/v.js" }));
    detachRendererConsoleCapture(asWc(wc2));
    expect(getRecentPluginConsoleMessages(asWc(wc2))).toEqual([]);
    expect(wc2.removeListener).toHaveBeenCalledWith("did-navigate", expect.any(Function));

    __resetRendererConsoleCaptureForTests(asWc(wc1));
  });
});
