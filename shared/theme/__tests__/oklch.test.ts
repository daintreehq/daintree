import { describe, expect, it } from "vitest";
import {
  hexToOklch,
  deltaOklch,
  auditSurfaceRamp,
  auditAccentProminence,
  auditCrossThemeAccents,
} from "../oklch.js";
import type { ThemePalette } from "../palette.js";
import type { BuiltInThemeSource } from "../builtInThemeSources.js";

function makePalette(overrides: Partial<ThemePalette> = {}): ThemePalette {
  return {
    type: "dark",
    surfaces: {
      grid: "#0e0e0d",
      sidebar: "#131312",
      canvas: "#19191a",
      panel: "#1d1d1e",
      elevated: "#2b2b2c",
    },
    text: { primary: "#e4e4e7", secondary: "#a1a1aa", muted: "#8a8a93", inverse: "#19191a" },
    border: "#282828",
    accent: "#36CE94",
    status: { success: "#6B8D72", warning: "#C59A4E", danger: "#C8746C", info: "#7B8C96" },
    activity: { active: "#2EB37C", idle: "#52525b", working: "#2EB37C", waiting: "#fbbf24" },
    syntax: {
      comment: "#8a8a93",
      punctuation: "#d4d4d8",
      number: "#fbbf24",
      string: "#10b981",
      operator: "#d4d4d8",
      keyword: "#38bdf8",
      function: "#c084fc",
      link: "#22d3ee",
      quote: "#fbbf24",
      chip: "#a855f7",
    },
    ...overrides,
  };
}

// --- hexToOklch ---

describe("hexToOklch", () => {
  it("returns null for non-hex values", () => {
    expect(hexToOklch("")).toBeNull();
    expect(hexToOklch("not-a-color")).toBeNull();
    expect(hexToOklch("rgb(255,0,0)")).toBeNull();
  });

  it("converts black to near-zero values", () => {
    const c = hexToOklch("#000000")!;
    expect(c.l).toBeCloseTo(0, 1);
    expect(c.c).toBeCloseTo(0, 1);
  });

  it("converts white to high lightness, near-zero chroma", () => {
    const c = hexToOklch("#ffffff")!;
    expect(c.l).toBeCloseTo(1, 1);
    expect(c.c).toBeCloseTo(0, 1);
  });

  it("converts mid-gray", () => {
    const c = hexToOklch("#808080")!;
    expect(c.l).toBeGreaterThan(0.4);
    expect(c.l).toBeLessThan(0.7);
    expect(c.c).toBeCloseTo(0, 1);
  });

  it("converts a saturated color with meaningful chroma", () => {
    const c = hexToOklch("#36CE94")!;
    expect(c.c).toBeGreaterThan(0.1);
    expect(c.h).toBeGreaterThan(0);
    expect(c.h).toBeLessThan(360);
  });

  it("handles 3-digit hex", () => {
    const c6 = hexToOklch("#ff0000")!;
    const c3 = hexToOklch("#f00")!;
    expect(c3.l).toBeCloseTo(c6.l, 3);
  });
});

// --- deltaOklch ---

describe("deltaOklch", () => {
  it("returns near-zero for identical colors", () => {
    const a = hexToOklch("#36CE94")!;
    expect(deltaOklch(a, a)).toBeCloseTo(0, 5);
  });

  it("returns a large value for complementary hues", () => {
    const red = hexToOklch("#ff0000")!;
    const teal = hexToOklch("#00ffff")!;
    expect(deltaOklch(red, teal)).toBeGreaterThan(0.2);
  });

  it("handles hue wraparound (h=350 vs h=10)", () => {
    const a = hexToOklch("#ff0044")!;
    const b = hexToOklch("#ff4400")!;
    // These are close in hue (~20° apart), so ΔE should be moderate
    expect(deltaOklch(a, b)).toBeGreaterThan(0);
    expect(deltaOklch(a, b)).toBeLessThan(0.15);
  });
});

// --- auditSurfaceRamp ---

describe("auditSurfaceRamp", () => {
  it("passes a well-spaced ramp with no warnings", () => {
    const surfaces = {
      grid: "#0a0a0a",
      sidebar: "#141414",
      canvas: "#1e1e1e",
      panel: "#282828",
      elevated: "#3a3a3a",
    };
    const result = auditSurfaceRamp(surfaces, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on collapsing adjacent pair", () => {
    const surfaces = {
      grid: "#141414",
      sidebar: "#141415", // nearly identical to grid
      canvas: "#1e1e1e",
      panel: "#282828",
      elevated: "#3a3a3a",
    };
    const result = auditSurfaceRamp(surfaces, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("JND"))).toBe(true);
  });

  it("warns on runaway step", () => {
    const surfaces = {
      grid: "#0a0a0a",
      sidebar: "#0b0b0b",
      canvas: "#0c0c0c",
      panel: "#2a2a2a", // huge jump
      elevated: "#2c2c2c",
    };
    const result = auditSurfaceRamp(surfaces, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("runaway"))).toBe(true);
  });

  it("skips non-hex surface values gracefully", () => {
    const surfaces = {
      grid: "#0a0a0a",
      sidebar: "rgba(0,0,0,0.5)" as unknown as string,
      canvas: "#1e1e1e",
      panel: "#282828",
      elevated: "#3a3a3a",
    };
    const result = auditSurfaceRamp(surfaces, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("not a parseable hex"))).toBe(true);
  });
});

// --- auditAccentProminence ---

describe("auditAccentProminence", () => {
  it("passes a vivid accent on a well-separated canvas", () => {
    const palette = makePalette({
      accent: "#36CE94",
      surfaces: {
        grid: "#0e0e0d",
        sidebar: "#131312",
        canvas: "#19191a",
        panel: "#1d1d1e",
        elevated: "#2b2b2c",
      },
    });
    const result = auditAccentProminence(palette, "test");
    expect(result.failures).toHaveLength(0);
    // #36CE94 on #19191a should have good separation
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on low-chroma accent", () => {
    const palette = makePalette({
      accent: "#8a8a8a", // gray, near-zero chroma
    });
    const result = auditAccentProminence(palette, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("chroma"))).toBe(true);
  });

  it("warns on accent too close in lightness to canvas", () => {
    const palette = makePalette({
      accent: "#1a1a1b", // very close to canvas #19191a
    });
    const result = auditAccentProminence(palette, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("grayscale"))).toBe(true);
  });

  it("checks accentSecondary when present", () => {
    const palette = makePalette({
      accent: "#36CE94",
      accentSecondary: "#8a8a8a",
    });
    const result = auditAccentProminence(palette, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("accentSecondary"))).toBe(true);
  });

  it("skips accentSecondary when not present", () => {
    const palette = makePalette({ accentSecondary: undefined });
    const result = auditAccentProminence(palette, "test");
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.every((w) => !w.includes("accentSecondary"))).toBe(true);
  });
});

// --- auditCrossThemeAccents ---

function makeSource(
  id: string,
  type: "dark" | "light",
  accent: string,
  accentSecondary?: string
): BuiltInThemeSource {
  return {
    id,
    name: id,
    type,
    builtin: true,
    palette: makePalette({ type, accent, accentSecondary }),
    location: "Test",
    heroImage: "/test.png",
  };
}

describe("auditCrossThemeAccents", () => {
  it("passes when accents are distinct across themes", () => {
    const sources = [
      makeSource("theme-a", "dark", "#36CE94"),
      makeSource("theme-b", "dark", "#C59A4E"),
      makeSource("theme-c", "dark", "#C8746C"),
    ];
    const result = auditCrossThemeAccents(sources);
    expect(result.failures).toHaveLength(0);
  });

  it("warns when two primary accents are too close", () => {
    const sources = [
      makeSource("theme-a", "dark", "#36CE94"),
      makeSource("theme-b", "dark", "#36CF94"), // 1-bit difference
    ];
    const result = auditCrossThemeAccents(sources);
    expect(result.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("ΔE"))).toBe(true);
  });

  it("warns on duplicate accentSecondary hexes", () => {
    const sources = [
      makeSource("theme-a", "dark", "#36CE94", "#6B8D72"),
      makeSource("theme-b", "dark", "#C59A4E", "#6B8D72"), // same secondary
    ];
    const result = auditCrossThemeAccents(sources);
    expect(result.warnings.some((w) => w.includes("accentSecondary"))).toBe(true);
  });

  it("only compares within same polarity", () => {
    const sources = [
      makeSource("dark-a", "dark", "#36CE94", "#6B8D72"),
      makeSource("light-a", "light", "#36CE94", "#6B8D72"),
    ];
    const result = auditCrossThemeAccents(sources);
    // Same hexes OK across different polarities
    expect(result.failures).toHaveLength(0);
  });
});
