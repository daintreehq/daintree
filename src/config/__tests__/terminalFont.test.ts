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

  it("fires when the font loads before the timeout (#9809)", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);

    // With the `use(terminalFontReady)` Suspense gate removed, terminals open
    // immediately — so a cache-miss font that lands WITHIN the 3s window (the
    // common case) still arrives after terminals measured against the fallback
    // and must trigger a repair. Pre-#9809 this was gated on the timeout having
    // already elapsed, leaving these terminals permanently mis-sized.
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
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

  it("fires when one weight arrives late even if the other fails", async () => {
    // Regular weight loads late; bold rejects. The regular JetBrains Mono face
    // still changes cell metrics, so the grid must be repaired (allSettled).
    let resolveRegular!: (value: unknown) => void;
    let rejectBold!: (reason: unknown) => void;
    const regular = new Promise((resolve) => {
      resolveRegular = resolve;
    });
    const bold = new Promise((_resolve, reject) => {
      rejectBold = reject;
    });
    // Avoid an unhandled-rejection warning for the deliberately-rejected weight.
    bold.catch(() => {});
    loadMock.mockImplementation((spec: string) => (spec.startsWith("bold") ? bold : regular));

    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const callback = vi.fn();
    mod.onTerminalFontArrivedLate(callback);

    await vi.advanceTimersByTimeAsync(3_000);
    rejectBold(new Error("bold failed"));
    resolveRegular([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing callback so the others still fire", async () => {
    const mod = await import("../terminalFont");
    mod.ensureTerminalFontLoaded();
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    mod.onTerminalFontArrivedLate(throwing);
    mod.onTerminalFontArrivedLate(second);

    await vi.advanceTimersByTimeAsync(3_000);
    resolveLoad([{ family: "JetBrains Mono" }]);
    await vi.runAllTimersAsync();

    expect(throwing).toHaveBeenCalledTimes(1);
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
