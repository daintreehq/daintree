import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { getThemeContrastWarnings } from "../contrast.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { APP_THEME_TOKEN_KEYS } from "../types.js";

describe("built-in themes", () => {
  it("every source compiles to a valid AppColorScheme", () => {
    expect(BUILT_IN_THEME_SOURCES.length).toBeGreaterThan(0);
    expect(BUILT_IN_APP_SCHEMES).toHaveLength(BUILT_IN_THEME_SOURCES.length);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(scheme.id).toBeTruthy();
      expect(scheme.name).toBeTruthy();
      expect(["dark", "light"]).toContain(scheme.type);
      expect(scheme.builtin).toBe(true);
      expect(scheme.tokens).toBeDefined();
    }
  });

  it("all theme IDs are unique", () => {
    const ids = BUILT_IN_APP_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "scheme %s passes WCAG contrast checks",
    (_id, scheme) => {
      const warnings = getThemeContrastWarnings(scheme);
      expect(warnings, warnings.map((w) => w.message).join("; ")).toHaveLength(0);
    }
  );

  it("every compiled scheme has all required token keys", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const key of APP_THEME_TOKEN_KEYS) {
        expect(scheme.tokens[key], `${scheme.id} missing token: ${key}`).toBeTruthy();
      }
    }
  });

  it("source palette type matches declared type", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(source.palette.type, `${source.id} palette.type mismatch`).toBe(source.type);
    }
  });

  it("every source has location and heroImage metadata", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(source.location, `${source.id} missing location`).toBeTruthy();
      expect(source.heroImage, `${source.id} missing heroImage`).toBeTruthy();
    }
  });

  it("every source palette has all required surface, text, and status fields", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      const { surfaces, text, status, activity, syntax } = source.palette;
      expect(surfaces.grid, `${source.id} missing surfaces.grid`).toBeTruthy();
      expect(surfaces.sidebar, `${source.id} missing surfaces.sidebar`).toBeTruthy();
      expect(surfaces.canvas, `${source.id} missing surfaces.canvas`).toBeTruthy();
      expect(surfaces.panel, `${source.id} missing surfaces.panel`).toBeTruthy();
      expect(surfaces.elevated, `${source.id} missing surfaces.elevated`).toBeTruthy();
      expect(text.primary, `${source.id} missing text.primary`).toBeTruthy();
      expect(text.secondary, `${source.id} missing text.secondary`).toBeTruthy();
      expect(text.muted, `${source.id} missing text.muted`).toBeTruthy();
      expect(text.inverse, `${source.id} missing text.inverse`).toBeTruthy();
      expect(status.success, `${source.id} missing status.success`).toBeTruthy();
      expect(status.warning, `${source.id} missing status.warning`).toBeTruthy();
      expect(status.danger, `${source.id} missing status.danger`).toBeTruthy();
      expect(status.info, `${source.id} missing status.info`).toBeTruthy();
      expect(activity.active, `${source.id} missing activity.active`).toBeTruthy();
      expect(activity.idle, `${source.id} missing activity.idle`).toBeTruthy();
      expect(activity.working, `${source.id} missing activity.working`).toBeTruthy();
      expect(activity.waiting, `${source.id} missing activity.waiting`).toBeTruthy();
      for (const key of Object.keys(syntax) as (keyof typeof syntax)[]) {
        expect(syntax[key], `${source.id} missing syntax.${key}`).toBeTruthy();
      }
    }
  });

  it("every source has a material blur strategy", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(
        source.palette.strategy?.materialBlur,
        `${source.id} missing materialBlur`
      ).toBeGreaterThan(0);
      expect(
        source.palette.strategy?.materialSaturation,
        `${source.id} missing materialSaturation`
      ).toBeGreaterThan(0);
    }
  });

  it("surface-disabled token derives as opaque color (not rgba)", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const surfaceDisabled = scheme.tokens["surface-disabled"];
      expect(surfaceDisabled, `${scheme.id} surface-disabled should exist`).toBeTruthy();
      expect(surfaceDisabled, `${scheme.id} surface-disabled should be opaque`).not.toMatch(
        /^rgba\(/
      );
      expect(
        surfaceDisabled,
        `${scheme.id} surface-disabled should not contain undefined`
      ).not.toContain("undefined");
    }
  });

  it("status-danger-surface token derives as transparent wash", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(
        scheme.tokens["status-danger-surface"],
        `${scheme.id} status-danger-surface should be transparent wash`
      ).toMatch(
        /rgba\(.*,\s*0\.\d+\)|color-mix\(in oklab,\s*var\(--theme-status-danger\)\s*\d+%,\s*transparent\)/
      );
    }
  });

  it("knob-base token is polarity-aware (dark vs light)", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const knobBase = scheme.tokens["knob-base"];
      expect(knobBase, `${scheme.id} knob-base should be oklch`).toMatch(/oklch\(/);
      if (scheme.type === "dark") {
        expect(knobBase, `${scheme.id} dark theme knob should be light`).toMatch(
          /oklch\([0-9]\.[8-9]/
        );
      } else {
        expect(knobBase, `${scheme.id} light theme knob should be dark`).toMatch(
          /oklch\([0-1]\.[0-2]/
        );
      }
    }
  });

  it("state-modified token derives from status-info base", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const modified = scheme.tokens["state-modified"];
      expect(modified, `${scheme.id} state-modified should derive from status-info`).toContain(
        "color-mix"
      );
    }
  });

  it("every source defines perceptible sidebar hover and active extension tokens", () => {
    // Both extensions must exist (daintree previously omitted sidebar-hover-bg, leaving the
    // sidebar WorktreeCard with an invisible 1.5% fallback). Hover must be at or above the
    // overlay-subtle baseline (3% dark / 2.5% light) and active must be one step stronger
    // so the selected row is distinguishable from the hovered row. Polarity must also match
    // the theme type — a light theme using white tint or a dark theme using black would
    // render invisibly even at the right alpha.
    const minHoverAlpha = { dark: 0.03, light: 0.025 } as const;
    const minActiveAlpha = { dark: 0.05, light: 0.04 } as const;
    const expectedTint = {
      dark: /rgba\(\s*255\s*,\s*255\s*,\s*255/,
      light: /rgba\(\s*0\s*,\s*0\s*,\s*0/,
    } as const;
    const parseAlpha = (value: string): number => {
      const match = value.match(/rgba?\([^)]*?,\s*([0-9.]+)\s*\)/);
      return match ? Number(match[1]) : NaN;
    };
    for (const source of BUILT_IN_THEME_SOURCES) {
      const hover = source.extensions?.["sidebar-hover-bg"];
      const active = source.extensions?.["sidebar-active-bg"];
      expect(hover, `${source.id} missing sidebar-hover-bg extension`).toBeTruthy();
      expect(active, `${source.id} missing sidebar-active-bg extension`).toBeTruthy();
      const polarity = source.type;
      expect(
        parseAlpha(hover!),
        `${source.id} sidebar-hover-bg ${hover} below ${minHoverAlpha[polarity]} threshold`
      ).toBeGreaterThanOrEqual(minHoverAlpha[polarity]);
      expect(
        parseAlpha(active!),
        `${source.id} sidebar-active-bg ${active} below ${minActiveAlpha[polarity]} threshold`
      ).toBeGreaterThanOrEqual(minActiveAlpha[polarity]);
      expect(
        parseAlpha(active!),
        `${source.id} sidebar-active-bg ${active} should be stronger than sidebar-hover-bg ${hover}`
      ).toBeGreaterThan(parseAlpha(hover!));
      expect(
        hover,
        `${source.id} sidebar-hover-bg ${hover} polarity does not match theme type ${polarity}`
      ).toMatch(expectedTint[polarity]);
      expect(
        active,
        `${source.id} sidebar-active-bg ${active} polarity does not match theme type ${polarity}`
      ).toMatch(expectedTint[polarity]);
    }
  });

  it("never ships a dock-shadow extension that overrides the fix with a weak alpha (#8156)", () => {
    // applyAppThemeToRoot sets extensions["dock-shadow"] as an inline style,
    // which beats the corrected src/index.css base value. Any theme that opts
    // back in must use the alpha-pinned relative-color form so it stays visible
    // on light themes — never a raw low-alpha rgba() like the original bug.
    for (const source of BUILT_IN_THEME_SOURCES) {
      const dockShadow = source.extensions?.["dock-shadow"];
      if (dockShadow === undefined) continue;
      const pinned = dockShadow.match(/rgb\(from var\(--theme-shadow-color\) r g b \/ ([0-9.]+)\)/);
      expect(
        pinned,
        `${source.id} dock-shadow "${dockShadow}" must use the alpha-pinned relative-color form`
      ).toBeTruthy();
      expect(
        Number(pinned![1]),
        `${source.id} dock-shadow alpha ${pinned![1]} below 0.25 visibility threshold`
      ).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("dark themes override toolbar-control-armed-shadow with a white-tinted hairline; light themes inherit the black-tinted CSS fallback", () => {
    // Dark themes must provide a white-tinted hairline override — the CSS fallback
    // is black-tinted (rgba(0,0,0,0.18)) so on dark surfaces it would render
    // invisibly. Light themes must NOT define this extension; a copy-paste from a
    // dark theme would put a white ring on a light toolbar, which inverts the
    // original #8175 bug.
    const parseAlpha = (value: string): number => {
      const match = value.match(/rgba?\([^)]*?,\s*([0-9.]+)\s*\)/);
      return match ? Number(match[1]) : NaN;
    };
    for (const source of BUILT_IN_THEME_SOURCES) {
      const armed = source.extensions?.["toolbar-control-armed-shadow"];
      if (source.type === "dark") {
        expect(
          armed,
          `${source.id} (dark) missing toolbar-control-armed-shadow override`
        ).toBeTruthy();
        expect(
          armed,
          `${source.id} toolbar-control-armed-shadow must use the hairline geometry`
        ).toMatch(/inset\s+0\s+0\s+0\s+1px/);
        expect(
          armed,
          `${source.id} toolbar-control-armed-shadow must be white-tinted on a dark theme`
        ).toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/);
        const alpha = parseAlpha(armed!);
        expect(
          alpha,
          `${source.id} toolbar-control-armed-shadow alpha ${alpha} outside [0.08, 0.25]`
        ).toBeGreaterThanOrEqual(0.08);
        expect(alpha).toBeLessThanOrEqual(0.25);
      } else {
        expect(
          armed,
          `${source.id} (light) must not override toolbar-control-armed-shadow; it should inherit the black-tinted CSS fallback`
        ).toBeUndefined();
      }
    }
  });
});
