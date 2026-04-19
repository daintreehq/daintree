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
  __resetRendererConsoleCaptureForTests,
} from "../rendererConsoleCapture.js";

type ConsoleListener = (event: unknown, details: unknown) => void;

interface MockWebContents {
  id: number;
  isDestroyed: () => boolean;
  on: (event: string, listener: ConsoleListener) => void;
  emit: (details: unknown) => void;
}

let nextId = 1;

function createMockWebContents(overrides: { destroyed?: boolean } = {}): MockWebContents {
  const id = nextId++;
  let listener: ConsoleListener | null = null;
  return {
    id,
    isDestroyed: () => overrides.destroyed === true,
    on: vi.fn((event: string, l: ConsoleListener) => {
      if (event === "console-message") listener = l;
    }),
    emit: (details: unknown) => {
      if (listener) listener({}, details);
    },
  };
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

    expect(wc.on).toHaveBeenCalledTimes(1);

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
