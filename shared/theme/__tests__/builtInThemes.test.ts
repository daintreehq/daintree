import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { getThemeContrastWarnings } from "../contrast.js";
import { getSurfaceRampMetrics, hexToOklchL } from "../oklch.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { APP_THEME_TOKEN_KEYS } from "../types.js";

const normalizeHex = (hex: string): string => hex.trim().toUpperCase();

const hexToOklab = (hex: string): [number, number, number] => {
  const normalized = normalizeHex(hex).replace(/^#/, "");
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lr = lin(r);
  const lg = lin(g);
  const lb = lin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const oklabDistance = (a: [number, number, number], b: [number, number, number]): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

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

  it("no two built-in themes share an identical primary accent hex", () => {
    const seen = new Map<string, string>();
    for (const source of BUILT_IN_THEME_SOURCES) {
      const hex = normalizeHex(source.palette.accent);
      const prior = seen.get(hex);
      expect(prior, `${source.id} primary accent ${hex} duplicates ${prior}`).toBeUndefined();
      seen.set(hex, source.id);
    }
  });

  it("no two built-in themes share an identical accentSecondary hex", () => {
    const seen = new Map<string, string>();
    for (const source of BUILT_IN_THEME_SOURCES) {
      const secondary = source.palette.accentSecondary;
      if (!secondary) continue;
      const hex = normalizeHex(secondary);
      const prior = seen.get(hex);
      expect(prior, `${source.id} accentSecondary ${hex} duplicates ${prior}`).toBeUndefined();
      seen.set(hex, source.id);
    }
  });

  it("all pairwise primary accent OKLab distances are perceptually distinct", () => {
    // Guards against the #9225 regression: galapagos `#4A9E7F` and redwoods `#4E9A53` were
    // 0.056 apart in OKLab, which sits below the categorical-distinctness floor for a
    // 14-theme palette set. The 0.065 threshold gates that pair without failing on the
    // pre-existing fiordland/namib pair (≈0.068), which is out of scope for this issue.
    const THRESHOLD = 0.065;
    const labs = BUILT_IN_THEME_SOURCES.map((source) => ({
      id: source.id,
      hex: normalizeHex(source.palette.accent),
      lab: hexToOklab(source.palette.accent),
    }));
    for (let i = 0; i < labs.length; i++) {
      const a = labs[i]!;
      for (let j = i + 1; j < labs.length; j++) {
        const b = labs[j]!;
        const distance = oklabDistance(a.lab, b.lab);
        expect(
          distance,
          `${a.id} (${a.hex}) and ${b.id} (${b.hex}) primary accents are ` +
            `${distance.toFixed(3)} apart in OKLab — below the ${THRESHOLD} categorical floor`
        ).toBeGreaterThanOrEqual(THRESHOLD);
      }
    }
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

  it("hexToOklchL matches known sRGB reference points", () => {
    // Sanity-pin Ottosson's sRGB→LMS path. Endpoints (black=0, white=1) confirm gamma
    // and overall scaling; mid gray (#808080→0.5999) confirms the cube-root nonlinearity;
    // pure red (#FF0000→0.6279) confirms the chromatic LMS matrix rows (a swapped R/B
    // channel or wrong matrix coefficient would shift this materially).
    expect(hexToOklchL("#000000")).toBeCloseTo(0, 4);
    expect(hexToOklchL("#ffffff")).toBeCloseTo(1, 4);
    expect(hexToOklchL("#808080")).toBeCloseTo(0.5999, 3);
    expect(hexToOklchL("#ff0000")).toBeCloseTo(0.6279, 3);
  });

  it("hexToOklchL rejects non-#rrggbb input", () => {
    // The contract is strict #rrggbb (lowercase or uppercase). All built-in theme
    // palettes use that form; shorthand, alpha, or non-hex chars would be silently
    // misparsed by parseInt and yield a phantom L value — the throw makes that loud.
    expect(() => hexToOklchL("#fff")).toThrow();
    expect(() => hexToOklchL("#ffffffff")).toThrow();
    expect(() => hexToOklchL("#E8E6CG")).toThrow();
    expect(() => hexToOklchL("")).toThrow();
  });

  it("every built-in source surfaces value is strict #rrggbb hex", () => {
    // The ramp gate below depends on hexToOklchL, which only accepts #rrggbb. Catch
    // any future theme that ships shorthand or alpha-channel hex before it reaches
    // hexToOklchL's throw at runtime.
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    for (const source of BUILT_IN_THEME_SOURCES) {
      for (const key of ["grid", "sidebar", "canvas", "panel", "elevated"] as const) {
        const value = source.palette.surfaces[key];
        expect(value, `${source.id} surfaces.${key} "${value}" must be #rrggbb`).toMatch(hexRe);
      }
    }
  });

  it.each(BUILT_IN_THEME_SOURCES.map((s) => [s.id, s] as const))(
    "surface ramp for %s is monotonic, perceptible, and not runaway",
    (_id, source) => {
      // Surface elevation ramps (grid → sidebar → canvas → panel → elevated) must:
      // (1) be monotonically lighter so depth ordering is unambiguous;
      // (2) keep every adjacent step at or above the just-noticeable-difference
      //     floor — dark themes get 0.015 ΔL (≈1 OKLCH JND, shadows can't compensate
      //     at low luminance); light themes get 0.020 ΔL (1 JND is sufficient because
      //     ambient cues help, and white-ceiling headroom is tight);
      // (3) keep the largest step within 2.0× the smallest — a runaway elevated jump
      //     reads as a discontinuity rather than the next floor in the ramp.
      const metrics = getSurfaceRampMetrics(source.palette.surfaces);
      const minStepFloor = source.type === "dark" ? 0.015 : 0.02;
      const maxRatio = 2.0;
      const diag = `${source.id} L=[grid=${metrics.lightness.grid.toFixed(4)}, sidebar=${metrics.lightness.sidebar.toFixed(4)}, canvas=${metrics.lightness.canvas.toFixed(4)}, panel=${metrics.lightness.panel.toFixed(4)}, elevated=${metrics.lightness.elevated.toFixed(4)}] steps=[${metrics.steps.gridToSidebar.toFixed(4)}, ${metrics.steps.sidebarToCanvas.toFixed(4)}, ${metrics.steps.canvasToPanel.toFixed(4)}, ${metrics.steps.panelToElevated.toFixed(4)}] min=${metrics.minStep.toFixed(4)} max=${metrics.maxStep.toFixed(4)} ratio=${metrics.ratio.toFixed(2)}`;
      expect(
        metrics.monotonic,
        `${diag} — surfaces must be monotonically lighter from grid to elevated`
      ).toBe(true);
      expect(
        metrics.minStep,
        `${diag} — smallest step is below the ${minStepFloor} ΔL floor for ${source.type} themes`
      ).toBeGreaterThanOrEqual(minStepFloor);
      expect(
        metrics.ratio,
        `${diag} — step-uniformity ratio exceeds the ${maxRatio} ceiling`
      ).toBeLessThanOrEqual(maxRatio);
    }
  );

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
