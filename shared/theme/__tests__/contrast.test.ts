import { assert, describe, expect, it } from "vitest";
import {
  accentOverrideHasLowContrast,
  contrastRatio,
  deltaEOK,
  getThemeContrastWarnings,
  isHexColor,
} from "../contrast.js";
import { applyAccentOverrideToScheme, BUILT_IN_APP_SCHEMES } from "../themes.js";
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

  it("emits no warnings when status-* tokens meet 3.0:1 against all surfaces", () => {
    // Pure black on white is 21:1 — well above any threshold.
    const scheme = makeScheme({
      "status-success": "#000000" as AppColorSchemeTokens["status-success"],
      "status-warning": "#000000" as AppColorSchemeTokens["status-warning"],
      "status-danger": "#000000" as AppColorSchemeTokens["status-danger"],
      "status-info": "#000000" as AppColorSchemeTokens["status-info"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
      "surface-grid": "#ffffff" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel-elevated": "#ffffff" as AppColorSchemeTokens["surface-panel-elevated"],
      "search-highlight-background":
        "#fffde0" as AppColorSchemeTokens["search-highlight-background"],
      "search-highlight-text": "#333333" as AppColorSchemeTokens["search-highlight-text"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    // Catch both ratio failures (start with "status-") and unevaluable warnings
    // (start with "Cannot evaluate" but mention the status token mid-string).
    const statusFailures = warnings.filter((w) => w.message.includes("status-"));
    expect(statusFailures).toHaveLength(0);
  });

  it("emits a 3:1 outline warning when accent-primary fails against a surface", () => {
    // #A28224 (Serengeti pre-bump accent) on #F0E8D0 (surface-grid) is ~2.98:1, just below 3.0.
    const scheme = makeScheme({
      "accent-primary": "#A28224" as AppColorSchemeTokens["accent-primary"],
      "surface-grid": "#F0E8D0" as AppColorSchemeTokens["surface-grid"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("accent-primary outline on surface-grid") &&
        w.message.includes("target is 3.0:1") &&
        w.message.includes("WCAG 1.4.11")
    );
    expect(failure).toBeDefined();
  });

  it("emits no outline warning when accent-primary meets 3:1 across all surfaces", () => {
    // Pure black accent on white surfaces yields 21:1 — well above 3.0.
    const scheme = makeScheme({
      "accent-primary": "#000000" as AppColorSchemeTokens["accent-primary"],
      "surface-grid": "#ffffff" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#ffffff" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const outlineWarnings = warnings.filter((w) => w.message.includes("accent-primary outline on"));
    expect(outlineWarnings).toHaveLength(0);
  });

  it("emits an unevaluable warning when accent-primary is non-hex for the outline check", () => {
    const scheme = makeScheme({
      "accent-primary": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["accent-primary"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const outlineUnevaluable = warnings.filter(
      (w) =>
        w.message.includes("Cannot evaluate accent-primary outline contrast") &&
        w.message.includes("oklch(0.5 0.1 200)")
    );
    // 5 surfaces × 1 non-hex accent = 5 unevaluable outline warnings.
    expect(outlineUnevaluable.length).toBe(5);
  });

  it("emits an unevaluable warning when a surface is non-hex for the outline check", () => {
    const scheme = makeScheme({
      "surface-canvas": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["surface-canvas"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("Cannot evaluate accent-primary outline contrast on surface-canvas") &&
        w.message.includes("oklch(0.5 0.1 200)")
    );
    expect(failure).toBeDefined();
  });

  it("produces zero accent-primary outline warnings across all built-in themes", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const warnings = getThemeContrastWarnings(scheme);
      const outlineFailures = warnings.filter((w) =>
        w.message.includes("accent-primary outline on")
      );
      expect(
        outlineFailures,
        `${scheme.id}: accent-primary must hit 3:1 against all surfaces`
      ).toHaveLength(0);
    }
  });

  it("produces zero palette selection-outline warnings across all built-in themes", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const warnings = getThemeContrastWarnings(scheme);
      const selectionFailures = warnings.filter((w) => w.message.includes("selection-outline"));
      expect(
        selectionFailures,
        `${scheme.id}: selection-outline is the palette row's only non-text indicator (a leading rail) and must hit 3:1`
      ).toHaveLength(0);
    }
  });

  // The dark palette surface is the sidebar at 94% over whatever the palette
  // floats above, so these fixtures pin every backdrop to the sidebar's own
  // colour to isolate the pair under test from that blend.
  function makeFlatDarkScheme(overrides: Partial<AppColorSchemeTokens>): AppColorScheme {
    return makeScheme({
      "surface-sidebar": "#000000" as AppColorSchemeTokens["surface-sidebar"],
      "surface-grid": "#000000" as AppColorSchemeTokens["surface-grid"],
      "surface-canvas": "#000000" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#000000" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#000000" as AppColorSchemeTokens["surface-panel-elevated"],
      ...overrides,
    });
  }

  it("fails a rail that clears the surrounding surface but not the row fill it touches", () => {
    // The row lifts towards the rail on dark, so the surface pair is the
    // permissive one — a rail can pass it while vanishing into the fill it
    // touches. #5A5A5A is 3.04:1 on black and 1.52:1 on #767676.
    const scheme = makeFlatDarkScheme({
      "overlay-raised": "#767676" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "#5A5A5A" as AppColorSchemeTokens["selection-outline"],
    });
    const messages = getThemeContrastWarnings(scheme)
      .filter((w) => w.message.includes("selection-outline against"))
      .map((w) => w.message);
    expect(messages.some((m) => m.includes("the selected row fill"))).toBe(true);
    expect(messages.some((m) => m.includes("the surrounding palette surface"))).toBe(false);
  });

  it("fails a rail that clears both ordinary backdrops but not a destructive row's fill", () => {
    // The item primitives draw this rail as an inset focus ring, and a
    // destructive row swaps `overlay-raised` out for `status-danger/10`. A pale
    // danger token lifts that fill towards the rail: #5A5A5A is 3.04:1 on the
    // black surface and on a black raised fill, but only 2.68:1 on the 10%
    // wash #F5B5B5 leaves behind. Scoring the first two pairs alone calls this
    // compliant and loses the ring on exactly the row that most needs it.
    const scheme = makeFlatDarkScheme({
      "overlay-raised": "#000000" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "#5A5A5A" as AppColorSchemeTokens["selection-outline"],
      "status-danger": "#F5B5B5" as AppColorSchemeTokens["status-danger"],
    });
    const messages = getThemeContrastWarnings(scheme)
      .filter((w) => w.message.includes("selection-outline against"))
      .map((w) => w.message);
    expect(messages.some((m) => m.includes("a destructive menu row's fill"))).toBe(true);
    expect(messages.some((m) => m.includes("the selected row fill"))).toBe(false);
    expect(messages.some((m) => m.includes("the surrounding palette surface"))).toBe(false);
  });

  it("still reports the ordinary rail pairs when the destructive fill is unevaluable", () => {
    // An imported theme may spell `status-danger` in a syntax this math cannot read.
    // The destructive pair is the newest and least important of the three: losing it
    // is acceptable, but taking the two older ones down with it would send an author
    // who fixes the unreadable token away believing the rail was fine.
    const scheme = makeFlatDarkScheme({
      "overlay-raised": "#767676" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "#5A5A5A" as AppColorSchemeTokens["selection-outline"],
      "status-danger": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["status-danger"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    expect(
      warnings.some(
        (w) => w.kind === "low-contrast" && w.message.includes("selection-outline against")
      )
    ).toBe(true);
    expect(
      warnings.some((w) => w.kind === "unevaluable" && w.message.includes("status-danger"))
    ).toBe(true);
  });

  it("holds the rail to the surrounding surface on a destructive row too", () => {
    // A translucent rail is not the same pixel over the danger wash as it is over the
    // raised fill, and the ring's outer edge sits on the row's boundary — so the
    // surface pair has to be scored from the composited destructive ink as well.
    const scheme = makeFlatDarkScheme({
      "surface-sidebar": "#5A5A5A" as AppColorSchemeTokens["surface-sidebar"],
      "surface-grid": "#5A5A5A" as AppColorSchemeTokens["surface-grid"],
      "surface-canvas": "#5A5A5A" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#5A5A5A" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#5A5A5A" as AppColorSchemeTokens["surface-panel-elevated"],
      "overlay-raised": "#5A5A5A" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "rgba(252, 252, 252, 0.5)" as AppColorSchemeTokens["selection-outline"],
      "status-danger": "#000000" as AppColorSchemeTokens["status-danger"],
    });
    const messages = getThemeContrastWarnings(scheme)
      .filter((w) => w.message.includes("selection-outline against"))
      .map((w) => w.message);
    expect(messages.some((m) => m.includes("the surface behind a destructive row"))).toBe(true);
    // Named separately from the ordinary pair on purpose: that one passes here, and
    // pointing an author at a pair they can measure as compliant wastes the warning.
    expect(messages.some((m) => m.includes("the surrounding palette surface"))).toBe(false);
  });

  it("scores the dark palette surface as translucent, not as the solid sidebar", () => {
    // #5A5A5A clears 3:1 on a solid black sidebar, but the palette floats at 94%
    // over the app, and admitting 6% of a bright plane behind it drops the pair
    // below the floor. Scoring only the solid token would call this compliant.
    const scheme = makeFlatDarkScheme({
      "surface-panel-elevated": "#FFFFFF" as AppColorSchemeTokens["surface-panel-elevated"],
      "overlay-raised": "#000000" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "#5A5A5A" as AppColorSchemeTokens["selection-outline"],
    });
    const messages = getThemeContrastWarnings(scheme)
      .filter((w) => w.message.includes("selection-outline against"))
      .map((w) => w.message);
    expect(messages.some((m) => m.includes("the surrounding palette surface"))).toBe(true);
  });

  it("composites an rgba rail token over the row fill rather than reading its raw alpha", () => {
    // Opaque white would score 16.67:1 on this fill and sail through; at 10%
    // alpha the pixel that actually renders is #353535, which is 1.36:1.
    const scheme = makeFlatDarkScheme({
      "overlay-raised": "#1E1E1E" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "rgba(255, 255, 255, 0.1)" as AppColorSchemeTokens["selection-outline"],
    });
    const failures = getThemeContrastWarnings(scheme).filter((w) =>
      w.message.includes("selection-outline against the selected row fill")
    );
    expect(failures).toHaveLength(1);
  });

  it("composites an alpha-hex rail token instead of reading it as opaque", () => {
    // `#FFFFFF10` is 6% white. Read as opaque it would score 19.30:1 and pass;
    // the pixel that renders is #1D1D1D on this fill.
    const scheme = makeFlatDarkScheme({
      "overlay-raised": "#0E0E0E" as AppColorSchemeTokens["overlay-raised"],
      "selection-outline": "#FFFFFF10" as AppColorSchemeTokens["selection-outline"],
    });
    const failures = getThemeContrastWarnings(scheme).filter((w) =>
      w.message.includes("selection-outline against the selected row fill")
    );
    expect(failures).toHaveLength(1);
  });

  it("reports the palette selection check as unevaluable when the rail token is not hex or rgba", () => {
    const scheme = makeScheme({
      "selection-outline":
        "color-mix(in oklab, #ffffff 42%, transparent)" as AppColorSchemeTokens["selection-outline"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const unevaluable = warnings.find(
      (w) =>
        w.kind === "unevaluable" &&
        w.message.includes("Cannot evaluate palette selection contrast") &&
        w.message.includes("selection-outline")
    );
    expect(unevaluable).toBeDefined();
  });

  it("emits contrast warning when search-highlight-background rgba is composited over a surface", () => {
    const scheme = makeScheme({
      "search-highlight-text": "#cccccc" as AppColorSchemeTokens["search-highlight-text"],
      "search-highlight-background":
        "rgba(0,0,0,0.1)" as AppColorSchemeTokens["search-highlight-background"],
      "surface-grid": "#ffffff" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#ffffff" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#ffffff" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#ffffff" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#ffffff" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const compositedWarnings = warnings.filter(
      (w) =>
        w.message.includes("search-highlight-text on search-highlight-background (over") &&
        w.message.includes("target is 3.0:1")
    );
    expect(compositedWarnings.length).toBeGreaterThan(0);
  });

  it("treats opaque rgba as direct hex check", () => {
    const scheme = makeScheme({
      "search-highlight-text": "#999999" as AppColorSchemeTokens["search-highlight-text"],
      "search-highlight-background":
        "rgba(136,136,136,1)" as AppColorSchemeTokens["search-highlight-background"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const opaqueWarnings = warnings.filter(
      (w) =>
        w.message.includes("search-highlight-text on search-highlight-background") &&
        !w.message.includes("(over")
    );
    expect(opaqueWarnings.length).toBeGreaterThan(0);
  });

  it("emits unevaluable warning for malformed rgba in a pair", () => {
    const scheme = makeScheme({
      "search-highlight-background":
        "rgba(0,0,0,)" as AppColorSchemeTokens["search-highlight-background"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const unevaluable = warnings.filter(
      (w) =>
        w.message.includes("Cannot evaluate contrast") &&
        w.message.includes("search-highlight-background")
    );
    expect(unevaluable.length).toBe(1);
    expect(unevaluable[0]!.message).toContain("rgba(0,0,0,)");
  });

  it("produces zero accent-secondary outline warnings across all built-in themes", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const warnings = getThemeContrastWarnings(scheme);
      const outlineFailures = warnings.filter((w) =>
        w.message.includes("accent-secondary outline on")
      );
      expect(
        outlineFailures,
        `${scheme.id}: accent-secondary must hit 3:1 against all surfaces`
      ).toHaveLength(0);
    }
  });
});

describe("accentOverrideHasLowContrast", () => {
  const lightScheme = BUILT_IN_APP_SCHEMES.find((s) => s.type === "light")!;
  const darkScheme = BUILT_IN_APP_SCHEMES.find((s) => s.type !== "light")!;

  it("flags a white accent override on a light theme (invisible on light surfaces)", () => {
    const patched = applyAccentOverrideToScheme(lightScheme, "#ffffff");
    const result = accentOverrideHasLowContrast(patched);
    assert(result !== null);
    // White accent on a light theme has legible button text but vanishes on surfaces.
    expect(result.mode).toBe("surface");
    expect(result.worstRatio).toBeLessThan(4.5);
    expect(result.worstSurface).not.toBeNull();
  });

  it("does not flag a white accent override on a dark theme", () => {
    const patched = applyAccentOverrideToScheme(darkScheme, "#ffffff");
    expect(accentOverrideHasLowContrast(patched)).toBeNull();
  });

  it("does not flag a strong dark accent override on a light theme", () => {
    const patched = applyAccentOverrideToScheme(lightScheme, "#1a1a1a");
    expect(accentOverrideHasLowContrast(patched)).toBeNull();
  });

  it("flags via the accent-foreground/accent-primary pair when surfaces are fine", () => {
    // Light accent on black surfaces passes the surface check (~9:1), but the near-match
    // accent-foreground fails on the accent itself — isolates the button-label branch.
    const scheme = makeScheme({
      "accent-primary": "#aaaaaa" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "#a4a4a4" as AppColorSchemeTokens["accent-foreground"],
      "surface-grid": "#000000" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#000000" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#000000" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#000000" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#000000" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const result = accentOverrideHasLowContrast(scheme);
    assert(result !== null);
    // Foreground branch: the offending pair is the near-match label, not a surface.
    expect(result.mode).toBe("foreground");
    expect(result.worstRatio).toBeLessThan(4.5);
    expect(result.worstSurface).toBeNull();
  });

  it("reports the surface with the worst ratio, not just the first failing one", () => {
    // Mid-grey accent fails harder against the lighter surface than the darker one;
    // the scan must surface the lowest ratio and its key, not short-circuit on the first.
    const scheme = makeScheme({
      "accent-primary": "#808080" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "#000000" as AppColorSchemeTokens["accent-foreground"],
      "surface-grid": "#000000" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#000000" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#000000" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#000000" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#9a9a9a" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const result = accentOverrideHasLowContrast(scheme);
    assert(result !== null);
    expect(result.mode).toBe("surface");
    expect(result.worstSurface).toBe("surface-panel-elevated");
    // The reported ratio must be the lowest of all surface pairs.
    const reported = result.worstRatio;
    for (const key of [
      "surface-grid",
      "surface-sidebar",
      "surface-canvas",
      "surface-panel",
      "surface-panel-elevated",
    ] as const) {
      expect(reported).toBeLessThanOrEqual(contrastRatio("#808080", scheme.tokens[key]));
    }
  });

  it("prioritizes the foreground failure when both modes fail", () => {
    // Near-match foreground AND a vanishing accent on a same-toned surface: foreground wins.
    const scheme = makeScheme({
      "accent-primary": "#aaaaaa" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "#a4a4a4" as AppColorSchemeTokens["accent-foreground"],
      "surface-grid": "#a8a8a8" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#a8a8a8" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#a8a8a8" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#a8a8a8" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#a8a8a8" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const result = accentOverrideHasLowContrast(scheme);
    assert(result !== null);
    expect(result.mode).toBe("foreground");
    // The foreground branch must not leak a surface key, and the reported ratio
    // must be the foreground pair's ratio — not whichever surface scored worst.
    expect(result.worstSurface).toBeNull();
    expect(result.worstRatio).toBeCloseTo(contrastRatio("#a4a4a4", "#aaaaaa"), 5);
  });

  it("returns the foreground failure mode when a non-hex accent-foreground is paired with a failing surface", () => {
    // Non-hex foreground skips the foreground branch; a low-contrast surface then governs.
    const scheme = makeScheme({
      "accent-primary": "#ffffff" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["accent-foreground"],
      "surface-grid": "#fdfdfd" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#fdfdfd" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#fdfdfd" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#fdfdfd" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#fdfdfd" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    const result = accentOverrideHasLowContrast(scheme);
    assert(result !== null);
    // Foreground skipped (non-hex) → surface branch reports the near-white-on-white failure.
    expect(result.mode).toBe("surface");
    expect(result.worstRatio).toBeLessThan(4.5);
    expect(result.worstSurface).not.toBeNull();
  });

  it("treats the 4.5:1 gate as strict — passes just above, fails just below", () => {
    // WCAG reference greys on white: #767676 = 4.54:1 (clears), #777777 = 4.48:1 (fails).
    // Surfaces are black so the surface branch never fires; the foreground gate governs.
    const baseSurfaces = {
      "surface-grid": "#000000",
      "surface-sidebar": "#000000",
      "surface-canvas": "#000000",
      "surface-panel": "#000000",
      "surface-panel-elevated": "#000000",
    } as Partial<AppColorSchemeTokens>;

    const justAbove = makeScheme({
      "accent-primary": "#ffffff" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "#767676" as AppColorSchemeTokens["accent-foreground"],
      ...baseSurfaces,
    });
    // Sanity-check the fixtures straddle the boundary so the test stays meaningful.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(accentOverrideHasLowContrast(justAbove)).toBeNull();

    const justBelow = makeScheme({
      "accent-primary": "#ffffff" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "#777777" as AppColorSchemeTokens["accent-foreground"],
      ...baseSurfaces,
    });
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    const result = accentOverrideHasLowContrast(justBelow);
    assert(result !== null);
    expect(result.mode).toBe("foreground");
  });

  it("skips the foreground pair when accent-foreground is non-hex but still checks surfaces", () => {
    // Non-hex accent-foreground must not throw; the surface check still governs.
    const scheme = makeScheme({
      "accent-primary": "#ffffff" as AppColorSchemeTokens["accent-primary"],
      "accent-foreground": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["accent-foreground"],
      "surface-grid": "#000000" as AppColorSchemeTokens["surface-grid"],
      "surface-sidebar": "#000000" as AppColorSchemeTokens["surface-sidebar"],
      "surface-canvas": "#000000" as AppColorSchemeTokens["surface-canvas"],
      "surface-panel": "#000000" as AppColorSchemeTokens["surface-panel"],
      "surface-panel-elevated": "#000000" as AppColorSchemeTokens["surface-panel-elevated"],
    });
    // White accent on black surfaces is high-contrast → no warning despite non-hex fg.
    expect(accentOverrideHasLowContrast(scheme)).toBeNull();
  });

  it("does not flag when a non-hex accent-primary cannot be evaluated", () => {
    const scheme = makeScheme({
      "accent-primary": "oklch(0.5 0.1 200)" as AppColorSchemeTokens["accent-primary"],
    });
    expect(accentOverrideHasLowContrast(scheme)).toBeNull();
  });
});

describe("deltaEOK", () => {
  it("returns 0 for identical colors", () => {
    expect(deltaEOK("#ff0000", "#ff0000")).toBeCloseTo(0, 5);
    expect(deltaEOK("#000000", "#000000")).toBeCloseTo(0, 5);
    expect(deltaEOK("#123456", "#123456")).toBeCloseTo(0, 5);
  });

  it("returns a large value for black vs white", () => {
    const d = deltaEOK("#000000", "#ffffff");
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(1.0);
  });

  it("returns a small value for similar colors", () => {
    const d = deltaEOK("#ff0000", "#ee0000");
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.05);
  });

  it("is symmetric", () => {
    expect(deltaEOK("#112233", "#aabbcc")).toBeCloseTo(deltaEOK("#aabbcc", "#112233"), 10);
  });

  it("handles 3-digit hex", () => {
    const d = deltaEOK("#f00", "#ff0000");
    expect(d).toBeCloseTo(0, 5);
  });
});

describe("terminal/syntax validation", () => {
  it("emits legibility warning when an ANSI color is too close to terminal-background", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-yellow": "#151515" as AppColorSchemeTokens["terminal-yellow"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("terminal-yellow on terminal-background") &&
        w.message.includes("OKLab lightness diff")
    );
    expect(failure).toBeDefined();
  });

  it("emits legibility warning when a syntax role is too close to terminal-background", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "syntax-keyword": "#111111" as AppColorSchemeTokens["syntax-keyword"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("syntax-keyword on terminal-background") &&
        w.message.includes("OKLab lightness diff")
    );
    expect(failure).toBeDefined();
  });

  it("uses softer floor for syntax-comment", () => {
    // #101010 on #000000 → OKLab ΔL ≈ 0.14, fails SOFT (0.22) but is above STANDARD (0.18)? No...
    // Actually #101010 on #000000 ΔL ≈ 0.14, which fails both. Let's use #111111.
    // #111111 on #000000 → ΔL ≈ 0.17, fails SOFT (0.22) and STANDARD (0.18).
    const scheme = makeScheme({
      "terminal-background": "#000000" as AppColorSchemeTokens["terminal-background"],
      "syntax-comment": "#080808" as AppColorSchemeTokens["syntax-comment"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const commentFailure = warnings.find((w) => w.message.includes("syntax-comment on"));
    expect(commentFailure).toBeDefined();
    expect(commentFailure!.message).toContain("floor is 0.18");
  });

  it("uses softer floor for syntax-quote", () => {
    const scheme = makeScheme({
      "terminal-background": "#000000" as AppColorSchemeTokens["terminal-background"],
      "syntax-quote": "#080808" as AppColorSchemeTokens["syntax-quote"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const quoteFailure = warnings.find((w) => w.message.includes("syntax-quote on"));
    expect(quoteFailure).toBeDefined();
    expect(quoteFailure!.message).toContain("floor is 0.18");
  });

  it("uses primary floor for terminal-foreground", () => {
    const scheme = makeScheme({
      "terminal-background": "#000000" as AppColorSchemeTokens["terminal-background"],
      "terminal-foreground": "#666666" as AppColorSchemeTokens["terminal-foreground"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const fgFailure = warnings.find((w) => w.message.includes("terminal-foreground on"));
    expect(fgFailure).toBeDefined();
    expect(fgFailure!.message).toContain("floor is 0.55");
  });

  it("skips legibility check for terminal-black", () => {
    // terminal-black = same as background → should NOT produce legibility warning
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-black": "#111111" as AppColorSchemeTokens["terminal-black"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const blackLegibility = warnings.find(
      (w) =>
        w.message.includes("terminal-black on terminal-background") &&
        w.message.includes("OKLab lightness diff")
    );
    expect(blackLegibility).toBeUndefined();
  });

  it("emits distinctness warning when base and bright colors are too similar", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-green": "#00aa55" as AppColorSchemeTokens["terminal-green"],
      "terminal-bright-green": "#00aa55" as AppColorSchemeTokens["terminal-bright-green"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) => w.message.includes("green vs bright-green") && w.message.includes("deltaEOK")
    );
    expect(failure).toBeDefined();
  });

  it("emits distinctness warning for blue vs cyan", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-blue": "#4488cc" as AppColorSchemeTokens["terminal-blue"],
      "terminal-cyan": "#4488cc" as AppColorSchemeTokens["terminal-cyan"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) => w.message.includes("blue vs cyan") && w.message.includes("deltaEOK")
    );
    expect(failure).toBeDefined();
  });

  it("emits distinctness warning for keyword vs function", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "syntax-keyword": "#8866cc" as AppColorSchemeTokens["syntax-keyword"],
      "syntax-function": "#8866cc" as AppColorSchemeTokens["syntax-function"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) => w.message.includes("keyword vs function") && w.message.includes("deltaEOK")
    );
    expect(failure).toBeDefined();
  });

  it("emits distinctness warning for string vs number", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "syntax-string": "#aaaa66" as AppColorSchemeTokens["syntax-string"],
      "syntax-number": "#aaaa66" as AppColorSchemeTokens["syntax-number"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) => w.message.includes("string vs number") && w.message.includes("deltaEOK")
    );
    expect(failure).toBeDefined();
  });

  it("emits unevaluable warning when terminal-background is non-hex", () => {
    const scheme = makeScheme({
      "terminal-background": "oklch(0.2 0.01 250)" as AppColorSchemeTokens["terminal-background"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("Cannot evaluate terminal/syntax legibility") &&
        w.message.includes("terminal-background")
    );
    expect(failure).toBeDefined();
  });

  it("emits unevaluable warning when a checked token is non-hex", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-blue": "oklch(0.5 0.1 250)" as AppColorSchemeTokens["terminal-blue"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("Cannot evaluate legibility for terminal-blue") &&
        w.message.includes("non-hex")
    );
    expect(failure).toBeDefined();
  });

  it("emits unevaluable distinctness warning when one of a pair is non-hex", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111" as AppColorSchemeTokens["terminal-background"],
      "terminal-blue": "oklch(0.5 0.1 250)" as AppColorSchemeTokens["terminal-blue"],
      "terminal-cyan": "#22d3ee" as AppColorSchemeTokens["terminal-cyan"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const failure = warnings.find(
      (w) =>
        w.message.includes("Cannot evaluate distinctness for blue vs cyan") &&
        w.message.includes("non-hex")
    );
    expect(failure).toBeDefined();
  });

  it("produces zero terminal/syntax warnings across all built-in themes", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const warnings = getThemeContrastWarnings(scheme);
      const terminalWarnings = warnings.filter(
        (w) =>
          w.message.includes("terminal-") ||
          w.message.includes("syntax-") ||
          w.message.includes("OKLab") ||
          w.message.includes("deltaEOK")
      );
      expect(
        terminalWarnings,
        `${scheme.id}: terminal/syntax validation must produce zero warnings, got: ${terminalWarnings.map((w) => w.message).join("; ")}`
      ).toHaveLength(0);
    }
  });

  it("handles 8-digit alpha hex in terminal tokens", () => {
    const scheme = makeScheme({
      "terminal-background": "#111111ff" as AppColorSchemeTokens["terminal-background"],
      "terminal-red": "#ff6666ff" as AppColorSchemeTokens["terminal-red"],
      "terminal-bright-red": "#ff8888ff" as AppColorSchemeTokens["terminal-bright-red"],
    });
    const warnings = getThemeContrastWarnings(scheme);
    const unevaluable = warnings.filter(
      (w) =>
        w.message.includes("Cannot evaluate") &&
        (w.message.includes("terminal-red") || w.message.includes("terminal-bright-red"))
    );
    expect(unevaluable).toHaveLength(0);
  });
});

// The high-contrast neutral CTA (`variant="contrast"`) is the standard dialog primary
// action: it fills itself with the theme's body-text colour and paints its label in the
// inverse. Every other text-primary pair puts that token on a *surface*, so nothing else
// in the matrix notices when a theme collapses the fill against its own label.
describe("contrast-CTA pair (text-inverse on text-primary)", () => {
  const findWarning = (scheme: AppColorScheme) =>
    getThemeContrastWarnings(scheme).find(
      (w) => w.kind === "low-contrast" && w.message.startsWith("text-inverse on text-primary")
    );

  it("flags a theme whose inverse label collapses against the fill", () => {
    const scheme = makeScheme({
      "text-primary": "#767676" as AppColorSchemeTokens["text-primary"],
      "text-inverse": "#8a8a8a" as AppColorSchemeTokens["text-inverse"],
    });
    const warning = findWarning(scheme);
    expect(warning).toBeDefined();
    // The message carries the measured ratio, so a regression says how far off it is.
    expect(warning!.message).toMatch(/is \d+\.\d\d:1; target is 4\.5:1/);
  });

  it("flags a near-miss that still reads as two distinct colours", () => {
    // ~4.3:1 — visibly different, but under the AA floor for a normal-sized label.
    const scheme = makeScheme({
      "text-primary": "#7a7a7a" as AppColorSchemeTokens["text-primary"],
      "text-inverse": "#ffffff" as AppColorSchemeTokens["text-inverse"],
    });
    expect(contrastRatio("#ffffff", "#7a7a7a")).toBeLessThan(4.5);
    expect(findWarning(scheme)).toBeDefined();
  });

  it("stays quiet for a legible inverse pair in either polarity", () => {
    const dark = makeScheme({
      "text-primary": "#e8e8e8" as AppColorSchemeTokens["text-primary"],
      "text-inverse": "#141414" as AppColorSchemeTokens["text-inverse"],
    });
    const light = makeScheme({
      "text-primary": "#141414" as AppColorSchemeTokens["text-primary"],
      "text-inverse": "#e8e8e8" as AppColorSchemeTokens["text-inverse"],
    });
    expect(findWarning(dark)).toBeUndefined();
    expect(findWarning(light)).toBeUndefined();
  });
});
