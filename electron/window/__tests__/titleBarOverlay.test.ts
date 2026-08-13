import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  resolveOverlayColor,
  seedTitleBarOverlay,
  setTitleBarOverlayBannerSeverity,
  setTitleBarOverlayTheme,
} from "../titleBarOverlay.js";
import {
  WINDOWS_CAPTION_SYMBOL_COLOR,
  WINDOWS_TITLEBAR_HEIGHT_PX,
} from "../../../shared/config/windowChrome.js";

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

  it("maps each severity to its own token, not a neighbour's", () => {
    // With only one status token present, exactly the severity that maps to it
    // may tint — a swapped mapping would tint the wrong one.
    const onlyDanger = { "surface-canvas": CANVAS, "status-danger": DANGER };
    expect(resolveOverlayColor(onlyDanger, "error")).not.toBe(CANVAS);
    expect(resolveOverlayColor(onlyDanger, "warning")).toBe(CANVAS);

    const onlyWarning = { "surface-canvas": CANVAS, "status-warning": WARNING };
    expect(resolveOverlayColor(onlyWarning, "warning")).not.toBe(CANVAS);
    expect(resolveOverlayColor(onlyWarning, "error")).toBe(CANVAS);
  });

  it("keeps the strip a subtle wash, much nearer the canvas than the status colour", () => {
    // The banner paints a light tint over the canvas; a heavy blend (say 50%)
    // would make the caption strip louder than the banner it is matching.
    const [tr] = channels(resolveOverlayColor(TOKENS, "warning")!);
    const [cr] = channels(CANVAS);
    const [wr] = channels(WARNING);
    expect(Math.abs(tr - cr)).toBeLessThan(Math.abs(tr - wr) / 2);
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

  // Custom and imported themes persist tokens as unvalidated strings, so a
  // non-hex value must not reach Electron as "#NaNNaNNaN".
  it.each(["oklch(0.7 0.15 80)", "var(--something)", "rgb(1,2,3)", "goldenrod", ""])(
    "ignores the unparseable status token %j and keeps the canvas",
    (tint) => {
      expect(resolveOverlayColor({ ...TOKENS, "status-warning": tint }, "warning")).toBe(CANVAS);
    }
  );

  it.each(["oklch(0.2 0 0)", "var(--bg)", "not a colour"])(
    "declines to touch the strip when the canvas itself is unparseable (%j)",
    (canvas) => {
      expect(resolveOverlayColor({ ...TOKENS, "surface-canvas": canvas }, "warning")).toBeNull();
      expect(resolveOverlayColor({ ...TOKENS, "surface-canvas": canvas }, null)).toBeNull();
    }
  );

  it("accepts shorthand hex tokens", () => {
    const shorthand = resolveOverlayColor(
      { "surface-canvas": "#111", "status-warning": "#fc0" },
      "warning"
    );
    expect(shorthand).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("always yields a colour Electron can parse", () => {
    for (const severity of [null, "error", "warning", "info", "success", "neutral"] as const) {
      expect(resolveOverlayColor(TOKENS, severity)).toMatch(/^#[0-9a-f]{6}$/i);
    }
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

  it("retries after a rejected native write instead of caching a colour that never landed", () => {
    const win = makeWindow();
    seedTitleBarOverlay(win, TOKENS);
    win.setTitleBarOverlay.mockImplementationOnce(() => {
      throw new Error("Invalid color");
    });

    setTitleBarOverlayBannerSeverity(win, "warning");
    setTitleBarOverlayBannerSeverity(win, null);
    setTitleBarOverlayBannerSeverity(win, "warning");

    // The failed attempt must not be recorded as applied, or dedup would
    // swallow the retry and strand the strip on the wrong colour.
    const colors = win.setTitleBarOverlay.mock.calls.map((c) => (c[0] as { color: string }).color);
    expect(colors.at(-1)).toBe(resolveOverlayColor(TOKENS, "warning"));
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
    // Bound to the same constants the constructor and the renderer's inset use,
    // so a runtime repaint can't quietly resize or restyle the strip.
    expect(applied.height).toBe(WINDOWS_TITLEBAR_HEIGHT_PX);
    expect(applied.symbolColor).toBe(WINDOWS_CAPTION_SYMBOL_COLOR);
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
