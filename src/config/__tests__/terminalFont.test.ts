import { beforeEach, describe, expect, it, vi } from "vitest";

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
