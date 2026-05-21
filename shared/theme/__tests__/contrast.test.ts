import { describe, expect, it } from "vitest";
import { contrastRatio, getThemeContrastWarnings, isHexColor } from "../contrast.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import type { AppColorScheme, AppColorSchemeTokens, AppThemeTokenKey } from "./../types.js";

function makeScheme(overrides: Partial<AppColorSchemeTokens>): AppColorScheme {
  const base = BUILT_IN_APP_SCHEMES[0]!;
  return {
    ...base,
    id: "test-scheme",
    name: "Test Scheme",
    builtin: false,
    tokens: { ...base.tokens, ...overrides } as AppColorSchemeTokens,
  };
}

describe("isHexColor", () => {
  it("accepts hex colors in 3/4/6/8 digit forms", () => {
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#abcd")).toBe(true);
    expect(isHexColor("#aabbcc")).toBe(true);
    expect(isHexColor("#aabbccdd")).toBe(true);
    expect(isHexColor("#ABCDEF")).toBe(true);
    expect(isHexColor("#12345678")).toBe(true);
  });

  it("rejects malformed or non-hex values", () => {
    expect(isHexColor("abc")).toBe(false);
    expect(isHexColor("#")).toBe(false);
    expect(isHexColor("#ab")).toBe(false);
    expect(isHexColor("#abcde")).toBe(false);
    expect(isHexColor("#1234567")).toBe(false);
    expect(isHexColor("#123456789")).toBe(false);
    expect(isHexColor("#gggggg")).toBe(false);
    expect(isHexColor("rgba(0,0,0,1)")).toBe(false);
    expect(isHexColor("oklch(0.5 0.1 200)")).toBe(false);
    expect(isHexColor("var(--foo)")).toBe(false);
    expect(isHexColor("")).toBe(false);
  });
});

describe("contrastRatio", () => {
  it("computes black-on-white as 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
  });

  it("computes same-color as 1:1", () => {
    expect(contrastRatio("#888888", "#888888")).toBeCloseTo(1, 5);
  });

  it("treats 4-digit alpha hex as opaque, equivalent to its 6-digit form", () => {
    expect(contrastRatio("#000f", "#ffff")).toBeCloseTo(contrastRatio("#000000", "#ffffff"), 5);
  });

  it("treats 8-digit alpha hex as opaque, equivalent to its 6-digit form", () => {
    expect(contrastRatio("#000000ff", "#ffffffff")).toBeCloseTo(
      contrastRatio("#000000", "#ffffff"),
      5
    );
    expect(contrastRatio("#11223344", "#aabbccdd")).toBeCloseTo(
      contrastRatio("#112233", "#aabbcc"),
      5
    );
  });

  it("expands 3-digit hex consistently with 6-digit", () => {
    expect(contrastRatio("#abc", "#fff")).toBeCloseTo(contrastRatio("#aabbcc", "#ffffff"), 5);
  });
});

describe("getThemeContrastWarnings", () => {
  it("emits an unevaluable warning when a checked token uses a non-hex value", () => {
    const scheme = makeScheme({
      "text-primary": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["text-primary"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const matching = warnings.filter((w) => w.message.includes("Cannot evaluate contrast"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]!.message).toContain("text-primary");
    expect(matching[0]!.message).toContain("oklch(0.5 0.1 200)");
  });

  it("emits an unevaluable warning when both tokens of a pair are non-hex", () => {
    const scheme = makeScheme({
      "text-primary": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "rgba(0, 0, 0, 1)" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const pairWarning = warnings.find(
      (w) =>
        w.message.includes("text-primary on surface-canvas") &&
        w.message.includes("Cannot evaluate")
    );
    expect(pairWarning).toBeDefined();
    expect(pairWarning!.message).toContain("text-primary");
    expect(pairWarning!.message).toContain("surface-canvas");
  });

  it("emits a contrast-ratio warning when foreground/background fail the threshold", () => {
    // #999999 on #ffffff is ~2.85:1, below 4.5 (text-primary minimum).
    const scheme = makeScheme({
      "text-primary": "#999999" as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) => w.message.includes("text-primary on surface-canvas") && w.message.includes("target is")
    );
    expect(failure).toBeDefined();
  });

  it("evaluates 8-digit alpha hex without emitting an unevaluable warning", () => {
    const scheme = makeScheme({
      "text-primary": "#000000ff" as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "#ffffffff" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const unevaluable = warnings.filter(
      (w) =>
        w.message.includes("Cannot evaluate") &&
        (w.message.includes("text-primary") || w.message.includes("surface-canvas"))
    );
    expect(unevaluable).toHaveLength(0);
  });

  it("emits a ratio warning when 8-digit alpha hex values fail the threshold", () => {
    // #999999ff on #ffffffff is ~2.85:1, below 4.5 — alpha-stripping must still produce a real check.
    const scheme = makeScheme({
      "text-primary": "#999999ff" as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "#ffffffff" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("text-primary on surface-canvas") &&
        w.message.includes("target is 4.5:1") &&
        !w.message.includes("Cannot evaluate")
    );
    expect(failure).toBeDefined();
  });

  it("emits an unevaluable warning when a non-hex value lands on a status-* pair", () => {
    const scheme = makeScheme({
      "status-success": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["status-success"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const matching = warnings.find(
      (w) =>
        w.message.includes("Cannot evaluate") &&
        w.message.includes("status-success on surface-panel")
    );
    expect(matching).toBeDefined();
    expect(matching!.message).toContain("oklch(0.5 0.1 200)");
  });

  it("treats whitespace-padded hex tokens as evaluable", () => {
    // Theme imports may store " #000000 " untrimmed; the checker should recover.
    const scheme = makeScheme({
      "text-primary": " #000000 " as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "  #ffffff" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const unevaluable = warnings.filter(
      (w) =>
        w.message.includes("Cannot evaluate") &&
        (w.message.includes("text-primary") || w.message.includes("surface-canvas"))
    );
    expect(unevaluable).toHaveLength(0);
  });

  it("checks the new text-secondary on surface-grid pair", () => {
    // #cccccc on #ffffff is ~1.61:1, well below 3.0.
    const scheme = makeScheme({
      "text-secondary": "#cccccc" as AppColorSchemeTokens["text-secondary"],
      "surface-grid": "#ffffff" as AppColorSchemeTokens["surface-grid"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find((w) => w.message.includes("text-secondary on surface-grid"));
    expect(failure).toBeDefined();
  });

  it("checks the new text-secondary on surface-sidebar pair", () => {
    const scheme = makeScheme({
      "text-secondary": "#cccccc" as AppColorSchemeTokens["text-secondary"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find((w) => w.message.includes("text-secondary on surface-sidebar"));
    expect(failure).toBeDefined();
  });

  it("checks each new status-* on surface-panel pair at minimum 3.0", () => {
    const lowContrast = "#dddddd";
    const scheme = makeScheme({
      "status-success": lowContrast as AppColorSchemeTokens["status-success"],
      "status-warning": lowContrast as AppColorSchemeTokens["status-warning"],
      "status-danger": lowContrast as AppColorSchemeTokens["status-danger"],
      "status-info": lowContrast as AppColorSchemeTokens["status-info"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    for (const status of [
      "status-success",
      "status-warning",
      "status-danger",
      "status-info",
    ] as AppThemeTokenKey[]) {
      const failure = warnings.find((w) => w.message.includes(`${status} on surface-panel`));
      expect(failure, `${status} on surface-panel should produce a warning`).toBeDefined();
      expect(failure!.message).toContain("target is 3.0:1");
    }
  });

  it("emits freshness opacity warning when attenuated text-primary at 75% fails threshold", () => {
    // #999999 on #ffffff at 75% blends to #a5a5a5 on #ffffff → ~2.59:1 (fails 4.5).
    // Only the aging tier (75%) is checked since stale-disk/errored now use border+italic.
    const scheme = makeScheme({
      "text-primary": "#999999" as AppColorSchemeTokens["text-primary"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const freshnessWarnings = warnings.filter(
      (w) => w.message.includes("opacity") && w.message.includes("text-primary")
    );
    // 5 surfaces × 1 tier = exactly 5 warnings for a low-contrast foreground
    expect(freshnessWarnings.length).toBe(5);
    expect(freshnessWarnings.every((w) => w.message.includes("75% opacity (aging)"))).toBe(true);
  });

  it("includes aging tier label in freshness opacity warning message", () => {
    const scheme = makeScheme({
      "text-primary": "#999999" as AppColorSchemeTokens["text-primary"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const freshnessWarnings = warnings.filter(
      (w) => w.message.includes("opacity") && w.message.includes("text-primary")
    );
    expect(freshnessWarnings.length).toBeGreaterThan(0);
    expect(freshnessWarnings.every((w) => w.message.includes("75% opacity (aging)"))).toBe(true);
  });

  it("emits no freshness warnings at 75% opacity for high-contrast themes", () => {
    // #000000 on #ffffff at 75% blends to #404040 on #ffffff → ~10.4:1, well above 4.5.
    // Override all 5 surfaces so the test doesn't depend on the base theme's other surfaces.
    const scheme = makeScheme({
      "text-primary": "#000000" as AppColorSchemeTokens["text-primary"],
      "surface-grid": "#ffffff" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#ffffff" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const aging75 = warnings.filter((w) => w.message.includes("75% opacity (aging)"));
    expect(aging75).toHaveLength(0);
  });

  it("skips freshness checks for non-hex text-primary without crashing, base warnings still fire", () => {
    const scheme = makeScheme({
      "text-primary": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["text-primary"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const freshnessWarnings = warnings.filter((w) => w.message.includes("opacity"));
    expect(freshnessWarnings).toHaveLength(0);
    const baseUnevaluable = warnings.filter((w) => w.message.includes("Cannot evaluate contrast"));
    expect(baseUnevaluable.length).toBeGreaterThan(0);
  });

  it("aging (75%) produces zero freshness warnings across all built-in themes", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const warnings = getThemeContrastWarnings(scheme);
      const agingFailures = warnings.filter((w) => w.message.includes("75% opacity (aging)"));
      expect(
        agingFailures,
        `${scheme.id}: aging tier must not produce contrast warnings`
      ).toHaveLength(0);
    }
  });

  it("emits no warnings when status-* tokens meet 3.0:1 against surface-panel", () => {
    // Pure black on white is 21:1 — well above any threshold.
    const scheme = makeScheme({
      "status-success": "#000000" as AppColorSchemeTokens["status-success"],
      "status-warning": "#000000" as AppColorSchemeTokens["status-warning"],
      "status-danger": "#000000" as AppColorSchemeTokens["status-danger"],
      "status-info": "#000000" as AppColorSchemeTokens["status-info"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    // Catch both ratio failures (start with "status-") and unevaluable warnings
    // (start with "Cannot evaluate" but mention the status token mid-string).
    const statusFailures = warnings.filter((w) => w.message.includes("status-"));
    expect(statusFailures).toHaveLength(0);
  });
});
