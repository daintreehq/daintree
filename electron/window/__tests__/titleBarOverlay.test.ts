import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  resolveOverlayColor,
  seedTitleBarOverlay,
  setTitleBarOverlayBannerSeverity,
  setTitleBarOverlayTheme,
} from "../titleBarOverlay.js";

/**
 * Issue #11766. The native Windows caption strip paints above every
 * WebContentsView, so its colour has to track whatever the renderer puts in
 * that band. Two independent inputs drive it — theme and active global banner
 * — and these tests pin the reconciliation between them.
 */

const CANVAS = "#1a1a1a";
const WARNING = "#f0b429";
const DANGER = "#e5484d";

const TOKENS: Record<string, string> = {
  "surface-canvas": CANVAS,
  "status-warning": WARNING,
  "status-danger": DANGER,
  "status-info": "#0091ff",
  "status-success": "#30a46c",
};

const LIGHT_TOKENS: Record<string, string> = { ...TOKENS, "surface-canvas": "#fbfbfb" };

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function makeWindow() {
  return {
    setTitleBarOverlay: vi.fn(),
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow & {
    setTitleBarOverlay: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
}

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("resolveOverlayColor", () => {
  it("leaves the strip at the canvas when no banner holds the band", () => {
    expect(resolveOverlayColor(TOKENS, null)).toBe(CANVAS);
  });

  it("pulls the strip toward the severity colour without reaching it", () => {
    const tinted = resolveOverlayColor(TOKENS, "warning");
    expect(tinted).not.toBe(CANVAS);
    expect(tinted).not.toBe(WARNING);

    const [tr, tg, tb] = channels(tinted!);
    const [cr, cg, cb] = channels(CANVAS);
    const [wr, wg, wb] = channels(WARNING);

    // The wash is a partial blend, so every channel lands strictly between the
    // canvas and the status colour it is tinting with.
    expect(tr).toBeGreaterThan(cr);
    expect(tr).toBeLessThan(wr);
    expect(tg).toBeGreaterThan(cg);
    expect(tg).toBeLessThan(wg);
    expect(tb).toBeGreaterThan(cb);
    expect(tb).toBeLessThan(wb);
  });

  it("distinguishes severities that tint with different tokens", () => {
    expect(resolveOverlayColor(TOKENS, "warning")).not.toBe(resolveOverlayColor(TOKENS, "error"));
  });

  it("tracks the theme: the same severity resolves differently per canvas", () => {
    expect(resolveOverlayColor(TOKENS, "warning")).not.toBe(
      resolveOverlayColor(LIGHT_TOKENS, "warning")
    );
  });

  it("falls back to the canvas for neutral, whose wash is not a status colour", () => {
    expect(resolveOverlayColor(TOKENS, "neutral")).toBe(CANVAS);
  });

  it("falls back to the canvas when the severity's token is missing from the theme", () => {
    const partial = { "surface-canvas": CANVAS };
    expect(resolveOverlayColor(partial, "warning")).toBe(CANVAS);
  });

  it("resolves to nothing when the theme has no canvas to blend against", () => {
    expect(resolveOverlayColor({}, "warning")).toBeNull();
  });
});

describe("native overlay writes", () => {
  beforeEach(() => setPlatform("win32"));

  it("repaints the frame when a banner claims the band, and again when it leaves", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);

    setTitleBarOverlayBannerSeverity(win, "warning");
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    const tinted = win.setTitleBarOverlay.mock.calls[0]![0] as { color: string };
    expect(tinted.color).toBe(resolveOverlayColor(TOKENS, "warning"));

    setTitleBarOverlayBannerSeverity(win, null);
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(2);
    expect((win.setTitleBarOverlay.mock.calls[1]![0] as { color: string }).color).toBe(CANVAS);
  });

  it("seeding records the constructor's colour so an unchanged theme repaints nothing", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();

    setTitleBarOverlayTheme(win, TOKENS);
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("collapses repeated reports of the same severity into one repaint", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);

    setTitleBarOverlayBannerSeverity(win, "warning");
    setTitleBarOverlayBannerSeverity(win, "warning");
    setTitleBarOverlayBannerSeverity(win, "warning");

    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1);
  });

  it("re-tints rather than reverting when the theme changes under a live banner", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);
    setTitleBarOverlayBannerSeverity(win, "warning");
    win.setTitleBarOverlay.mockClear();

    setTitleBarOverlayTheme(win, LIGHT_TOKENS);

    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    const applied = win.setTitleBarOverlay.mock.calls[0]![0] as { color: string };
    // The banner is still up, so the new colour must be the light theme's
    // *tinted* value — not its bare canvas.
    expect(applied.color).toBe(resolveOverlayColor(LIGHT_TOKENS, "warning"));
    expect(applied.color).not.toBe(LIGHT_TOKENS["surface-canvas"]);
  });

  it("keeps windows independent", () => {
    const a = makeWindow();
    const b = makeWindow();
    seedTitleBarOverlay(a, TOKENS);
    seedTitleBarOverlay(b, TOKENS);

    setTitleBarOverlayBannerSeverity(a, "error");

    expect(a.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    expect(b.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("does not write to a destroyed window", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);
    win.isDestroyed.mockReturnValue(true);

    setTitleBarOverlayBannerSeverity(win, "warning");

    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("does nothing for a window that was never seeded with a theme", () => {
    const win = makeWindow();
    setTitleBarOverlayBannerSeverity(win, "warning");
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("applies the shared caption height and symbol colour", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);
    setTitleBarOverlayBannerSeverity(win, "warning");

    const applied = win.setTitleBarOverlay.mock.calls[0]![0] as {
      height: number;
      symbolColor: string;
    };
    expect(applied.height).toBeGreaterThan(0);
    expect(applied.symbolColor).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("non-Windows platforms", () => {
  it.each(["darwin", "linux"] as const)("never touches the native overlay on %s", (platform) => {
    setPlatform(platform);
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);

    setTitleBarOverlayBannerSeverity(win, "warning");
    setTitleBarOverlayTheme(win, LIGHT_TOKENS);

    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
