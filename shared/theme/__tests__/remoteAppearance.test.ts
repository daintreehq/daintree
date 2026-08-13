import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_MAX_FRAME_BYTES,
  RemoteAppearanceSnapshotSchema,
} from "../../types/remote/index.js";
import { projectRemoteAppearance } from "../remoteAppearance.js";
import { compositedContrastRatio } from "../contrast.js";
import { APP_THEME_TOKEN_KEYS, type AppColorScheme } from "../types.js";
import { BUILT_IN_APP_SCHEMES, getBuiltInAppSchemeForType } from "../themes.js";

function flattenColors(value: unknown): string[] {
  if (typeof value === "string" && value.startsWith("#")) return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(flattenColors);
}

describe("projectRemoteAppearance", () => {
  it("projects every built-in theme deterministically into concrete portable colors", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const first = projectRemoteAppearance(scheme, { revision: 7 });
      const second = projectRemoteAppearance(scheme, { revision: 7 });

      expect(RemoteAppearanceSnapshotSchema.safeParse(first).success).toBe(true);
      expect(second).toEqual(first);
      expect(flattenColors(first).length).toBeGreaterThan(50);
      expect(flattenColors(first).every((value) => /^#[0-9a-f]{8}$/.test(value))).toBe(true);
    }
  });

  it("applies a persisted accent override without mutating the committed source theme", () => {
    const source = BUILT_IN_APP_SCHEMES[0]!;
    const originalTokens = structuredClone(source.tokens);

    const projected = projectRemoteAppearance(source, {
      revision: 1,
      accentColorOverride: "#123456",
    });

    expect(projected.accent.primary).toBe("#123456ff");
    expect(projected.accent.soft).not.toBe(projected.accent.primary);
    expect(source.tokens).toEqual(originalTokens);
  });

  it("falls back each hostile field to a safe built-in of the same polarity", () => {
    const fallback = getBuiltInAppSchemeForType("light");
    const tokens = Object.fromEntries(
      APP_THEME_TOKEN_KEYS.map((key) => [key, fallback.tokens[key]])
    ) as AppColorScheme["tokens"];
    tokens["surface-canvas"] = "#123456";
    tokens["surface-panel"] = "var(--stolen-panel)";
    tokens["text-primary"] = "linear-gradient(red, blue)";
    tokens["accent-primary"] = "url(https://example.invalid/pixel)";
    tokens["terminal-red"] = "data:image/png;base64,secret";

    const projected = projectRemoteAppearance(
      {
        id: "hostile-light",
        name: "Hostile light",
        type: "light",
        builtin: false,
        tokens,
        extensions: { "toolbar-bg": "url(file:///etc/passwd)" },
        heroImage: "https://example.invalid/hero.png",
      } as AppColorScheme,
      { revision: 2 }
    );
    const expectedFallback = projectRemoteAppearance(fallback, { revision: 2 });

    expect(projected.surfaces.canvas).toBe("#123456ff");
    expect(projected.surfaces.panel).toBe(expectedFallback.surfaces.panel);
    expect(
      compositedContrastRatio(projected.text.primary, projected.surfaces.canvas)
    ).toBeGreaterThanOrEqual(4.5);
    expect(projected.accent.primary).toBe(expectedFallback.accent.primary);
    expect(projected.terminal.red).toBe(expectedFallback.terminal.red);
    expect(JSON.stringify(projected)).not.toMatch(
      /var\(|gradient|url\(|data:image|hero|toolbar-bg/
    );
  });

  it("bounds identity, strategy, and output size without admitting extra fields", () => {
    const source = BUILT_IN_APP_SCHEMES[0]!;
    const projected = projectRemoteAppearance(
      {
        ...source,
        id: "../../unsafe id",
        name: "Unsafe\u0000name",
        tokens: { ...source.tokens, "radius-scale": "999999" },
      },
      { revision: 3 }
    );

    expect(projected.themeId).not.toContain("/");
    expect(projected.displayName).not.toContain("\u0000");
    expect(projected.strategy.radiusScale).toBeGreaterThanOrEqual(0.5);
    expect(projected.strategy.radiusScale).toBeLessThanOrEqual(2);
    expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBeLessThan(
      DEFAULT_REMOTE_MAX_FRAME_BYTES
    );
    expect(
      RemoteAppearanceSnapshotSchema.safeParse({ ...projected, metadata: { secret: true } }).success
    ).toBe(false);
    expect(
      RemoteAppearanceSnapshotSchema.safeParse({
        ...projected,
        surfaces: { ...projected.surfaces, canvas: "rgba(0, 0, 0, 1)" },
      }).success
    ).toBe(false);
  });

  it.each([
    ["valid custom", { "surface-canvas": "#123456", "text-primary": "#fedcba" }],
    ["incomplete custom", { "surface-canvas": "#123456" }],
    ["low-contrast custom", { "surface-canvas": "#777777", "text-primary": "#777777" }],
    ["malformed custom", { "surface-canvas": "not-a-color", "text-primary": "var(--x)" }],
    ["oversized custom", { "surface-canvas": `#${"a".repeat(4096)}` }],
    [
      "adversarial custom",
      {
        "surface-canvas": "url(file:///etc/passwd)",
        "text-primary": "data:text/plain,credential=secret",
        "terminal-cursor": "linear-gradient(red, blue)",
      },
    ],
  ])("safely projects a representative %s input", (_, overrides) => {
    const fallback = getBuiltInAppSchemeForType("dark");
    const projected = projectRemoteAppearance(
      {
        id: "acceptance-custom",
        name: "Acceptance custom",
        type: "dark",
        tokens: overrides,
      },
      { revision: 8 }
    );

    expect(RemoteAppearanceSnapshotSchema.safeParse(projected).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBeLessThan(
      DEFAULT_REMOTE_MAX_FRAME_BYTES
    );
    expect(JSON.stringify(projected)).not.toMatch(/var\(|gradient|url\(|data:|credential|secret/);
    if (overrides["surface-canvas"] === "#123456") {
      expect(projected.surfaces.canvas).toBe("#123456ff");
    } else if (overrides["surface-canvas"] === "#777777") {
      expect(
        compositedContrastRatio(projected.text.primary, projected.surfaces.canvas)
      ).toBeGreaterThanOrEqual(4.5);
    } else {
      expect(projected.surfaces.canvas).toBe(
        projectRemoteAppearance(fallback, { revision: 8 }).surfaces.canvas
      );
    }
  });

  it("keeps every built-in terminal palette concrete and visibly differentiated", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const { terminal } = projectRemoteAppearance(scheme, { revision: 1 });
      const ansi = [
        terminal.red,
        terminal.green,
        terminal.yellow,
        terminal.blue,
        terminal.magenta,
        terminal.cyan,
        terminal.white,
        terminal.brightRed,
        terminal.brightGreen,
        terminal.brightYellow,
        terminal.brightBlue,
        terminal.brightMagenta,
        terminal.brightCyan,
        terminal.brightWhite,
      ];

      expect(
        compositedContrastRatio(terminal.foreground, terminal.background)
      ).toBeGreaterThanOrEqual(4.5);
      expect(compositedContrastRatio(terminal.cursor, terminal.background)).toBeGreaterThanOrEqual(
        3
      );
      expect(
        compositedContrastRatio(terminal.selection, terminal.background)
      ).toBeGreaterThanOrEqual(1.15);
      expect(new Set(ansi).size).toBeGreaterThan(8);
      expect(ansi.every((color) => compositedContrastRatio(color, terminal.background) >= 4)).toBe(
        true
      );
    }
  });

  it.each(["#000001", "#ffffff00", "#ffffff10"])(
    "repairs a valid but unreadable %s portable color",
    (unreadable) => {
      const projected = projectRemoteAppearance(
        {
          id: "unreadable-colors",
          name: "Unreadable colors",
          type: "dark",
          tokens: {
            "surface-canvas": "#000000",
            "text-primary": unreadable,
            "terminal-background": "#000000",
            "terminal-foreground": unreadable,
            "terminal-cursor": unreadable,
            "terminal-selection": unreadable,
            "terminal-red": unreadable,
          },
        },
        { revision: 9 }
      );

      expect(
        compositedContrastRatio(projected.text.primary, projected.surfaces.canvas)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        compositedContrastRatio(projected.terminal.foreground, projected.terminal.background)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        compositedContrastRatio(projected.terminal.cursor, projected.terminal.background)
      ).toBeGreaterThanOrEqual(3);
      expect(
        compositedContrastRatio(projected.terminal.selection, projected.terminal.background)
      ).toBeGreaterThanOrEqual(1.15);
      expect(
        compositedContrastRatio(projected.terminal.red, projected.terminal.background)
      ).toBeGreaterThanOrEqual(4);
    }
  );
});
