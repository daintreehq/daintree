import { describe, expect, it } from "vitest";
import {
  isValidAccentRgbTriplet,
  isValidCssColor,
  isValidThemeHeroImage,
  validateImportedThemeData,
} from "../colorValidator.js";

describe("isValidCssColor", () => {
  it("accepts hex colors in 3/4/6/8 digit forms", () => {
    expect(isValidCssColor("#fff")).toBe(true);
    expect(isValidCssColor("#FFFF")).toBe(true);
    expect(isValidCssColor("#123456")).toBe(true);
    expect(isValidCssColor("#12345678")).toBe(true);
    expect(isValidCssColor("#ABCDEF")).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(isValidCssColor("#")).toBe(false);
    expect(isValidCssColor("#12")).toBe(false);
    expect(isValidCssColor("#12345")).toBe(false);
    expect(isValidCssColor("#1234567")).toBe(false);
    expect(isValidCssColor("#123456789")).toBe(false);
    expect(isValidCssColor("#gggggg")).toBe(false);
  });

  it("accepts rgb()/rgba() in legacy and modern forms", () => {
    expect(isValidCssColor("rgb(255, 0, 0)")).toBe(true);
    expect(isValidCssColor("rgba(255, 128, 64, 0.5)")).toBe(true);
    expect(isValidCssColor("rgb(255 128 64)")).toBe(true);
    expect(isValidCssColor("rgb(255 128 64 / 0.5)")).toBe(true);
    expect(isValidCssColor("rgba(100%, 50%, 25%, 0.75)")).toBe(true);
  });

  it("rejects malformed rgb()", () => {
    expect(isValidCssColor("rgb(255, 0)")).toBe(false);
    expect(isValidCssColor("rgb()")).toBe(false);
    expect(isValidCssColor("rgb(255 128, 64)")).toBe(false);
    expect(isValidCssColor("rgb(oops)")).toBe(false);
  });

  it("accepts hsl()/hsla() in legacy and modern forms", () => {
    expect(isValidCssColor("hsl(120, 50%, 50%)")).toBe(true);
    expect(isValidCssColor("hsla(120deg, 50%, 50%, 0.5)")).toBe(true);
    expect(isValidCssColor("hsl(120 50% 50%)")).toBe(true);
    expect(isValidCssColor("hsl(120deg 50% 50% / 0.5)")).toBe(true);
  });

  it("accepts oklch() and oklab() including slash-alpha syntax", () => {
    expect(isValidCssColor("oklch(0.7 0.13 250)")).toBe(true);
    expect(isValidCssColor("oklch(0.7 0.13 250 / 0.8)")).toBe(true);
    expect(isValidCssColor("oklch(0.7, 0.13, 250)")).toBe(true);
    expect(isValidCssColor("oklab(0.65 0.05 -0.05)")).toBe(true);
    expect(isValidCssColor("oklab(0.65 0.05 -0.05 / 0.5)")).toBe(true);
  });

  it("rejects malformed oklch()", () => {
    expect(isValidCssColor("oklch(0.7 0.13)")).toBe(false);
    expect(isValidCssColor("oklch()")).toBe(false);
  });

  it("accepts color-mix() with valid prefix and balanced parens", () => {
    expect(isValidCssColor("color-mix(in oklab, #ff0000 50%, #00ff00)")).toBe(true);
    expect(isValidCssColor("color-mix(in srgb, red, blue)")).toBe(true);
    expect(isValidCssColor("color-mix(in oklch longer hue, red, blue)")).toBe(true);
    expect(isValidCssColor("color-mix(in oklab, rgb(255, 0, 0) 50%, #00ff00)")).toBe(true);
  });

  it("rejects color-mix() with invalid inner colors", () => {
    expect(isValidCssColor("color-mix(in oklab, not-a-color, blue)")).toBe(false);
    expect(isValidCssColor("color-mix(in oklab, #ff0000, bogus)")).toBe(false);
    expect(isValidCssColor("color-mix(in oklab, nope)")).toBe(false);
  });

  it("rejects malformed color-mix()", () => {
    expect(isValidCssColor("color-mix(red, blue)")).toBe(false);
    expect(isValidCssColor("color-mix(in oklab, red, blue")).toBe(false);
    expect(isValidCssColor("color-mix()")).toBe(false);
  });

  it("accepts var() with double-dash custom property and color fallback", () => {
    expect(isValidCssColor("var(--accent-primary)")).toBe(true);
    expect(isValidCssColor("var(--theme-accent, #ff0000)")).toBe(true);
    expect(isValidCssColor("var( --custom )")).toBe(true);
  });

  it("rejects var() without double-dash, empty name, or invalid fallback", () => {
    expect(isValidCssColor("var()")).toBe(false);
    expect(isValidCssColor("var(accent)")).toBe(false);
    expect(isValidCssColor("var(-accent)")).toBe(false);
    expect(isValidCssColor("var(--)")).toBe(false);
    expect(isValidCssColor("var(--theme-accent, )")).toBe(false);
    expect(isValidCssColor("var(--x, not-a-color)")).toBe(false);
  });

  it("accepts CSS named colors, transparent, and currentcolor", () => {
    expect(isValidCssColor("red")).toBe(true);
    expect(isValidCssColor("rebeccapurple")).toBe(true);
    expect(isValidCssColor("TRANSPARENT")).toBe(true);
    expect(isValidCssColor("currentcolor")).toBe(true);
    expect(isValidCssColor("CurrentColor")).toBe(true);
  });

  it("rejects unknown named colors and garbage strings", () => {
    expect(isValidCssColor("not-a-color")).toBe(false);
    expect(isValidCssColor("bogus")).toBe(false);
    expect(isValidCssColor("")).toBe(false);
    expect(isValidCssColor("   ")).toBe(false);
  });
});

describe("isValidAccentRgbTriplet", () => {
  it("accepts comma-space triplet with values 0-255", () => {
    expect(isValidAccentRgbTriplet("62, 144, 102")).toBe(true);
    expect(isValidAccentRgbTriplet("0, 0, 0")).toBe(true);
    expect(isValidAccentRgbTriplet("255, 255, 255")).toBe(true);
    expect(isValidAccentRgbTriplet("62,144,102")).toBe(true);
  });

  it("rejects out-of-range components", () => {
    expect(isValidAccentRgbTriplet("256, 0, 0")).toBe(false);
    expect(isValidAccentRgbTriplet("-1, 0, 0")).toBe(false);
    expect(isValidAccentRgbTriplet("999, 0, 0")).toBe(false);
  });

  it("rejects wrong separators and shapes", () => {
    expect(isValidAccentRgbTriplet("62 144 102")).toBe(false);
    expect(isValidAccentRgbTriplet("62, 144")).toBe(false);
    expect(isValidAccentRgbTriplet("rgb(62, 144, 102)")).toBe(false);
    expect(isValidAccentRgbTriplet("")).toBe(false);
  });
});

describe("isValidThemeHeroImage", () => {
  it("accepts relative and root-relative paths", () => {
    expect(isValidThemeHeroImage("/themes/foo.webp")).toBe(true);
    expect(isValidThemeHeroImage("./foo.webp")).toBe(true);
    expect(isValidThemeHeroImage("foo.webp")).toBe(true);
    expect(isValidThemeHeroImage("images/hero/foo.png")).toBe(true);
  });

  it("accepts data:image/ URLs", () => {
    expect(isValidThemeHeroImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isValidThemeHeroImage("DATA:image/jpeg;base64,xyz")).toBe(true);
    expect(isValidThemeHeroImage("data:image/svg+xml;base64,abc")).toBe(true);
  });

  it("rejects non-image data: URLs", () => {
    expect(isValidThemeHeroImage("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isValidThemeHeroImage("data:text/plain,hello")).toBe(false);
    expect(isValidThemeHeroImage("data:application/javascript,alert(1)")).toBe(false);
  });

  it("rejects remote protocols and script-capable schemes", () => {
    expect(isValidThemeHeroImage("http://example.com/img.png")).toBe(false);
    expect(isValidThemeHeroImage("https://example.com/img.png")).toBe(false);
    expect(isValidThemeHeroImage("//cdn.example.com/img.png")).toBe(false);
    expect(isValidThemeHeroImage("file:///Users/me/img.png")).toBe(false);
    expect(isValidThemeHeroImage("javascript:alert(1)")).toBe(false);
    expect(isValidThemeHeroImage("vbscript:msgbox(1)")).toBe(false);
    expect(isValidThemeHeroImage("ftp://example.com/x.png")).toBe(false);
  });

  it("rejects Windows absolute paths and UNC paths", () => {
    expect(isValidThemeHeroImage("C:\\Users\\me\\img.png")).toBe(false);
    expect(isValidThemeHeroImage("C:/Users/me/img.png")).toBe(false);
    expect(isValidThemeHeroImage("\\\\server\\share\\img.png")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isValidThemeHeroImage("")).toBe(false);
    expect(isValidThemeHeroImage("   ")).toBe(false);
  });
});

describe("validateImportedThemeData", () => {
  it("returns valid for a clean color token set", () => {
    const result = validateImportedThemeData({
      tokens: {
        "surface-canvas": "#101010",
        "accent-primary": "oklch(0.7 0.13 250)",
        "text-primary": "rgba(255, 255, 255, 0.9)",
        "accent-rgb": "62, 144, 102",
        "shadow-ambient": "0 1px 3px rgba(0, 0, 0, 0.3)",
        "material-opacity": "0.9",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("aggregates multiple invalid token failures into a single error message", () => {
    const result = validateImportedThemeData({
      tokens: {
        "surface-canvas": "not-a-color",
        "accent-primary": "also-invalid",
        "text-primary": "#fff",
      },
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("surface-canvas");
    expect(result.errors[0]).toContain("accent-primary");
    expect(result.errors[0]).not.toContain("text-primary");
  });

  it("rejects an invalid accent-rgb triplet with its own token in the list", () => {
    const result = validateImportedThemeData({
      tokens: {
        "accent-rgb": "255 128 64",
      },
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]).toContain("accent-rgb");
  });

  it("rejects a remote heroImage URL alongside color errors", () => {
    const result = validateImportedThemeData({
      tokens: {
        "surface-canvas": "not-a-color",
      },
      heroImage: "https://evil.example.com/img.png",
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.includes("surface-canvas"))).toBe(true);
    expect(result.errors.some((e) => e.includes("heroImage"))).toBe(true);
  });

  it("ignores unknown token keys (importer handles those separately as warnings)", () => {
    const result = validateImportedThemeData({
      tokens: {
        "surface-canvas": "#101010",
        "not-a-real-token": "garbage value",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-string token values", () => {
    const result = validateImportedThemeData({
      tokens: {
        "surface-canvas": 12345 as unknown as string,
      },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects empty string values on non-color tokens", () => {
    const result = validateImportedThemeData({
      tokens: {
        "material-blur": "",
      },
    });
    expect(result.valid).toBe(false);
  });

  it("handles null or missing tokens without throwing", () => {
    expect(
      validateImportedThemeData({ tokens: null as unknown as Record<string, unknown> }).valid
    ).toBe(true);
    expect(validateImportedThemeData({}).valid).toBe(true);
  });

  it("rejects non-object tokens", () => {
    const result = validateImportedThemeData({
      tokens: "not-an-object" as unknown as Record<string, unknown>,
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]).toContain("Invalid tokens");
  });

  it("rejects palette-format themes with invalid color values", () => {
    const result = validateImportedThemeData({
      palette: {
        type: "dark",
        surfaces: {
          grid: "not-a-color",
          sidebar: "#151a20",
          canvas: "#1a2027",
          panel: "#202730",
          elevated: "#28313c",
        },
        text: {
          primary: "#edf2f7",
          secondary: "#cbd5e0",
          muted: "#94a3b8",
          inverse: "#0f1115",
        },
        border: "#334155",
        accent: "also-bogus",
        status: {
          success: "#22c55e",
          warning: "#f59e0b",
          danger: "#ef4444",
          info: "#60a5fa",
        },
        activity: {
          active: "#22d3ee",
          idle: "#64748b",
          working: "#38bdf8",
          waiting: "#fbbf24",
        },
        syntax: {
          comment: "#64748b",
          punctuation: "#cbd5e1",
          number: "#fbbf24",
          string: "#86efac",
          operator: "#7dd3fc",
          keyword: "#c084fc",
          function: "#93c5fd",
          link: "#38bdf8",
          quote: "#94a3b8",
          chip: "#22d3ee",
        },
      },
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const joined = result.errors.join(" ");
    expect(joined).toContain("palette.surfaces.grid");
    expect(joined).toContain("palette.accent");
  });
});
