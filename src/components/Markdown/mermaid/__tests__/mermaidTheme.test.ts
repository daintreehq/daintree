// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetMermaidThemeForTests,
  getThemeSignature,
  readThemeSignature,
  resolveMermaidPalette,
  subscribeThemeSignature,
  toMermaidThemeVariables,
} from "../mermaidTheme";

const root = document.documentElement;

beforeEach(() => {
  _resetMermaidThemeForTests();
  root.removeAttribute("style");
  root.removeAttribute("data-color-mode");
  root.className = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme signature", () => {
  it("moves when a theme token or the color mode changes", () => {
    root.style.setProperty("--color-text-primary", "#111111");
    const initial = readThemeSignature();

    root.style.setProperty("--color-text-primary", "#eeeeee");
    const retinted = readThemeSignature();
    expect(retinted).not.toBe(initial);

    root.dataset.colorMode = "dark";
    expect(readThemeSignature()).not.toBe(retinted);
  });

  it("ignores inline styles that are not theme tokens", () => {
    const initial = readThemeSignature();
    root.style.setProperty("--markdown-font-size", "18px");
    expect(readThemeSignature()).toBe(initial);
  });

  it("notifies subscribers when <html> is re-themed, and only then", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeThemeSignature(listener);
    const before = getThemeSignature();

    root.style.setProperty("--unrelated", "1");
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    root.style.setProperty("--color-surface-canvas", "#202020");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getThemeSignature()).not.toBe(before);

    unsubscribe();
    root.style.setProperty("--color-surface-canvas", "#303030");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("subscription gap", () => {
  it("picks up a re-theme that landed between the first snapshot and the first subscription", () => {
    root.style.setProperty("--color-text-primary", "#111111");
    const early = getThemeSignature();
    root.style.setProperty("--color-text-primary", "#eeeeee");

    const listener = vi.fn();
    const unsubscribe = subscribeThemeSignature(listener);

    expect(getThemeSignature()).not.toBe(early);
    unsubscribe();
  });
});

describe("resolveMermaidPalette", () => {
  function stubCanvas(pixelFor: (painted: string[]) => number[]) {
    const painted: string[] = [];
    let fill = "";
    const context = {
      clearRect: vi.fn(() => {
        painted.length = 0;
      }),
      fillRect: vi.fn(() => {
        painted.push(fill);
      }),
      set fillStyle(value: string) {
        fill = value;
      },
      get fillStyle() {
        return fill;
      },
      getImageData: vi.fn(() => ({ data: pixelFor([...painted]) })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsdom has no 2d context; the stub covers the four members the palette uses
      context as unknown as CanvasRenderingContext2D
    );
    return context;
  }

  it("paints every token over the resolved background and emits opaque hex", () => {
    const layers: string[][] = [];
    stubCanvas((painted) => {
      layers.push(painted);
      return painted.length === 2 && painted[0] === "#000" ? [16, 16, 16, 255] : [10, 20, 30, 255];
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the members the palette reads
        ({
          color: "oklch(0.5 0.1 200 / 0.5)",
          fontFamily: element === document.body ? "Inter, sans-serif" : "",
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration
    );
    root.dataset.colorMode = "dark";

    const palette = resolveMermaidPalette();

    expect(palette.darkMode).toBe(true);
    expect(palette.fontFamily).toBe("Inter, sans-serif");
    // The background composites over black in a dark theme...
    expect(palette.colors.background).toBe("#101010");
    expect(layers[0]).toEqual(["#000", "oklch(0.5 0.1 200 / 0.5)"]);
    // ...and every other token over that background.
    expect(layers[1]).toEqual(["#101010", "oklch(0.5 0.1 200 / 0.5)"]);
    expect(palette.colors.text).toBe("#0a141e");
    expect(document.body.children).toHaveLength(0);

    const variables = toMermaidThemeVariables(palette);
    expect(variables.darkMode).toBe(true);
    expect(variables.primaryTextColor).toBe("#0a141e");
    for (const value of Object.values(variables)) {
      if (typeof value === "string") expect(value).not.toMatch(/var\(|color-mix\(|oklch\(/);
    }
  });

  it("leaves tokens out when there is no canvas to resolve them with", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const palette = resolveMermaidPalette();
    expect(palette.colors.text).toBeUndefined();
    expect(palette.colors.background).toBe("#ffffff");
    expect("primaryTextColor" in toMermaidThemeVariables(palette)).toBe(false);
  });
});
