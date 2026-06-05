import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureTerminalFontLoaded", () => {
  let loadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    loadMock = vi.fn().mockResolvedValue([{ family: "JetBrains Mono" }]);
    Object.defineProperty(globalThis, "document", {
      value: { fonts: { load: loadMock } },
      configurable: true,
    });
  });

  it("calls document.fonts.load for regular and bold weights", async () => {
    const { ensureTerminalFontLoaded } = await import("../terminalFont");
    await ensureTerminalFontLoaded();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(loadMock).toHaveBeenCalledWith("12px 'JetBrains Mono'");
    expect(loadMock).toHaveBeenCalledWith("bold 12px 'JetBrains Mono'");
  });

  it("returns the same promise on subsequent calls (singleton)", async () => {
    const { ensureTerminalFontLoaded } = await import("../terminalFont");
    const p1 = ensureTerminalFontLoaded();
    const p2 = ensureTerminalFontLoaded();

    expect(p1).toBe(p2);
    expect(loadMock).toHaveBeenCalledTimes(2);
    await p1;
    await p2;
  });

  it("resolves when document.fonts is unavailable", async () => {
    Object.defineProperty(globalThis, "document", {
      value: {},
      configurable: true,
    });
    const { ensureTerminalFontLoaded } = await import("../terminalFont");
    await expect(ensureTerminalFontLoaded()).resolves.toBeUndefined();
  });

  it("resolves when document is undefined", async () => {
    Reflect.deleteProperty(globalThis, "document");
    const { ensureTerminalFontLoaded } = await import("../terminalFont");
    await expect(ensureTerminalFontLoaded()).resolves.toBeUndefined();
  });

  it("swallows font load rejection", async () => {
    loadMock.mockRejectedValue(new Error("network error"));
    const { ensureTerminalFontLoaded } = await import("../terminalFont");
    await expect(ensureTerminalFontLoaded()).resolves.toBeUndefined();
  });
});

describe("onTerminalFontArrivedLate", () => {
  let resolveLoad: (value: unknown) => void;
  let rejectLoad: (reason: unknown) => void;
  let loadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    // A single shared deferred drives both the regular and bold load calls so
    // the test controls exactly when the real font load settles relative to the
    // 3s timeout.
    const deferred = new Promise((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    loadMock = vi.fn().mockReturnValue(deferred);
    Object.defineProperty(globalThis, "document", {
      value: { fonts: { load: loadMock } },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires registered callbacks when the font arrives after the timeout", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);

    // Timeout wins the race first — terminal would open against the fallback.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(callback).not.toHaveBeenCalled();

    // Real font load settles afterwards: the grid must be repaired.
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the font loads before the timeout", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);

    // Font resolves before the 3s timeout elapses — on-time, no repair needed.
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();
    expect(callback).not.toHaveBeenCalled();
  });

  it("fires synchronously when subscribing after the font already arrived late", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();

    await vi.advanceTimersByTimeAsync(3_000);
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();

    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire an unsubscribed callback", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    const unsubscribe = mod.onTerminalFontArrivedLate(callback);
    unsubscribe();

    await vi.advanceTimersByTimeAsync(3_000);
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not fire when the font load fails", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);

    await vi.advanceTimersByTimeAsync(3_000);
    rejectLoad(new Error("network error"));
    await vi.runAllTimersAsync();
    expect(callback).not.toHaveBeenCalled();
  });

  it("fires every registered callback exactly once", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const first = vi.fn();
    const second = vi.fn();
    mod.onTerminalFontArrivedLate(first);
    mod.onTerminalFontArrivedLate(second);

    await vi.advanceTimersByTimeAsync(3_000);
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("terminalFontReady", () => {
  let loadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    loadMock = vi.fn().mockResolvedValue([{ family: "JetBrains Mono" }]);
    Object.defineProperty(globalThis, "document", {
      value: { fonts: { load: loadMock } },
      configurable: true,
    });
  });

  it("is initialised eagerly at module import", async () => {
    await import("../terminalFont");
    // Module import alone should have triggered the font load so the
    // shared promise is already in-flight before any component mounts.
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("is the same promise instance as ensureTerminalFontLoaded()", async () => {
    const mod = await import("../terminalFont");
    expect(mod.terminalFontReady).toBe(mod.ensureTerminalFontLoaded());
  });

  it("resolves to undefined (never rejects)", async () => {
    const { terminalFontReady } = await import("../terminalFont");
    await expect(terminalFontReady).resolves.toBeUndefined();
  });
});
