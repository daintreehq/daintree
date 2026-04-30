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
});
