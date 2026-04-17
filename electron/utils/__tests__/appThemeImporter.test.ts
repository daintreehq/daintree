import { describe, expect, it } from "vitest";
import { parseAppThemeContent } from "../appThemeImporter.js";

describe("appThemeImporter", () => {
  it("parses nested partial light themes against the light fallback base", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Partial Light",
        type: "light",
        tokens: {
          "surface-canvas": "#ffffff",
          "accent-primary": "#2f855a",
        },
      }),
      "partial-light.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.type).toBe("light");
    expect(result.scheme.tokens["surface-canvas"]).toBe("#ffffff");
    expect(result.scheme.tokens["surface-panel"]).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it("infers theme type from surface-canvas when missing and warns", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Inferred Light",
        tokens: {
          "surface-canvas": "#faf7f2",
        },
      }),
      "inferred-light.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.type).toBe("light");
    expect(result.warnings.some((warning) => warning.message.includes('Add "type"'))).toBe(true);
  });

  it("warns about unknown nested tokens but still imports the scheme", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Unknown Token Theme",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "not-a-real-token": "#ffffff",
        },
      }),
      "unknown-token-theme.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.warnings.some((warning) => warning.message.includes("Ignored unknown tokens"))
    ).toBe(true);
  });

  it("preserves location and heroImage metadata through import", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Ecosystem Theme",
        type: "dark",
        location: "Daintree Rainforest, Queensland, Australia",
        heroImage: "/themes/daintree.webp",
        heroVideo: "/themes/daintree.webm",
        tokens: {
          "surface-canvas": "#19191a",
          "accent-primary": "#3E9066",
        },
      }),
      "ecosystem.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBe("Daintree Rainforest, Queensland, Australia");
    expect(result.scheme.heroImage).toBe("/themes/daintree.webp");
    expect(result.scheme.heroVideo).toBe("/themes/daintree.webm");
  });

  it("parses palette-format themes with extensions", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Palette Theme",
        palette: {
          type: "dark",
          surfaces: {
            grid: "#0f1115",
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
          accent: "#38bdf8",
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
          terminal: {
            selection: "#1e293b",
            red: "#f87171",
            green: "#4ade80",
            yellow: "#facc15",
            blue: "#60a5fa",
            magenta: "#c084fc",
            cyan: "#22d3ee",
            brightRed: "#fca5a5",
            brightGreen: "#86efac",
            brightYellow: "#fde047",
            brightBlue: "#93c5fd",
            brightMagenta: "#d8b4fe",
            brightCyan: "#67e8f9",
            brightWhite: "#f8fafc",
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
        extensions: {
          "toolbar-project-bg": "linear-gradient(180deg, #1a2027, #0f1115)",
        },
      }),
      "palette-theme.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.tokens["surface-canvas"]).toBe("#1a2027");
    expect(result.scheme.extensions?.["toolbar-project-bg"]).toContain("linear-gradient");
  });

  it("omits metadata fields when not provided", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Plain Theme",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "accent-primary": "#ff0000",
        },
      }),
      "plain.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBeUndefined();
    expect(result.scheme.heroImage).toBeUndefined();
    expect(result.scheme.heroVideo).toBeUndefined();
  });

  it("does not treat metadata keys as unknown tokens in flat format", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Flat with metadata",
        type: "dark",
        location: "Test Location",
        heroImage: "/test.webp",
        "surface-canvas": "#101010",
        "accent-primary": "#ff0000",
      }),
      "flat-meta.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBe("Test Location");
    expect(result.warnings.every((w) => !w.message.includes("location"))).toBe(true);
  });

  it("rejects JSON without recognizable app theme tokens", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Bad Theme",
        type: "dark",
        foo: "bar",
      }),
      "bad-theme.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("No recognized app theme tokens or palette");
  });

  it("accepts the full spectrum of valid CSS color forms", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "All Color Forms",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "surface-sidebar": "#abcdefff",
          "accent-primary": "oklch(0.7 0.13 250)",
          "accent-hover": "oklch(0.7 0.13 250 / 0.8)",
          "accent-soft": "color-mix(in oklab, #3E9066 60%, #ffffff)",
          "accent-muted": "rgba(62, 144, 102, 0.3)",
          "text-primary": "rgb(255 255 255)",
          "text-secondary": "hsl(120, 50%, 50%)",
          "text-link": "hsla(200 50% 50% / 0.9)",
          "text-inverse": "currentcolor",
          "text-placeholder": "transparent",
          "border-default": "rebeccapurple",
          "focus-ring": "var(--theme-accent-primary)",
          "accent-rgb": "62, 144, 102",
          "shadow-ambient": "0 1px 3px rgba(0, 0, 0, 0.3)",
          "material-opacity": "0.9",
          "material-blur": "12px",
        },
      }),
      "all-forms.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.tokens["accent-primary"]).toBe("oklch(0.7 0.13 250)");
    expect(result.scheme.tokens["accent-rgb"]).toBe("62, 144, 102");
  });

  it("rejects themes with invalid color values and lists the offending tokens", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Invalid Colors",
        type: "dark",
        tokens: {
          "surface-canvas": "not-a-color",
          "accent-primary": "#12345",
          "text-primary": "#fff",
        },
      }),
      "invalid-colors.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("surface-canvas");
    expect(result.errors.join(" ")).toContain("accent-primary");
    expect(result.errors.join(" ")).not.toContain("text-primary");
  });

  it("rejects remote heroImage URLs at import time", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Remote Hero",
        type: "dark",
        heroImage: "https://evil.example.com/hero.png",
        tokens: {
          "surface-canvas": "#101010",
        },
      }),
      "remote-hero.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((err) => err.includes("heroImage"))).toBe(true);
  });

  it("rejects each remote heroImage protocol variant", () => {
    const variants = [
      "http://example.com/hero.png",
      "//cdn.example.com/hero.png",
      "file:///Users/me/hero.png",
      "C:\\Users\\me\\hero.png",
      "\\\\server\\share\\hero.png",
    ];
    for (const heroImage of variants) {
      const result = parseAppThemeContent(
        JSON.stringify({
          name: "Hero Variant",
          type: "dark",
          heroImage,
          tokens: { "surface-canvas": "#101010" },
        }),
        "hero.json"
      );
      expect(result.ok, `expected rejection for ${heroImage}`).toBe(false);
    }
  });

  it("accepts data: URLs for heroImage", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Data Hero",
        type: "dark",
        heroImage: "data:image/png;base64,iVBORw0KGgo=",
        tokens: { "surface-canvas": "#101010" },
      }),
      "data-hero.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.heroImage).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("rejects an accent-rgb token in the wrong format", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Bad RGB Triplet",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "accent-rgb": "255 128 64",
        },
      }),
      "bad-triplet.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("accent-rgb");
  });

  it("rejects palette-format themes when a palette color is invalid", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Bad Palette",
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
          accent: "#38bdf8",
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
      }),
      "bad-palette.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("palette.surfaces.grid");
  });

  it("rejects a javascript: heroImage URL", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "JS Hero",
        type: "dark",
        heroImage: "javascript:alert(1)",
        tokens: { "surface-canvas": "#101010" },
      }),
      "js-hero.json"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((err) => err.includes("heroImage"))).toBe(true);
  });

  it("rejects a non-image data: URL for heroImage", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Data HTML Hero",
        type: "dark",
        heroImage: "data:text/html,<script>alert(1)</script>",
        tokens: { "surface-canvas": "#101010" },
      }),
      "data-html-hero.json"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((err) => err.includes("heroImage"))).toBe(true);
  });

  it("preserves extensions without validating their values", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Extensions Theme",
        type: "dark",
        tokens: { "surface-canvas": "#101010" },
        extensions: {
          "toolbar-project-bg": "linear-gradient(180deg, #1a2027, #0f1115)",
        },
      }),
      "extensions.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.extensions?.["toolbar-project-bg"]).toContain("linear-gradient");
  });
});
