import { describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES, blendOverBackground, contrastRatio, parseRgba } from "../index.js";

/**
 * `border-input` — the resting boundary of `Input` and `Textarea`.
 *
 * Split out of `border-strong` for the same reason `selection-outline` was: an
 * input boundary is a user-interface component under WCAG 1.4.11 and owes 3:1
 * on its own, while `border-strong` is a separation value shared with dividers
 * and card edges that reads as a hard ruled line at that weight. The engine
 * default is therefore whatever `border-strong` resolved to, and a theme moves
 * only by naming the token.
 *
 * These assertions are about the RULE, not the hex: any ink that clears the
 * ratio on both surfaces a field edge touches passes.
 */
const INPUT_BOUNDARY_MIN_CONTRAST = 3;

describe("border-input", () => {
  it("clears 3:1 on daintree against both surfaces a field edge touches", () => {
    const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree");
    expect(scheme, "daintree scheme").toBeDefined();
    if (!scheme) return;

    const ink = scheme.tokens["border-input"];
    // The edge sits between the field fill and the panel behind it, so it has to
    // carry the ratio against both — one side alone is not the indicator.
    for (const surface of ["surface-input", "surface-panel"] as const) {
      const bg = scheme.tokens[surface];
      // An alpha ink is composited against the surface it is measured on —
      // which is the whole reason this token wants a solid value: the same
      // rgba() lands on a different colour over the field fill than over the
      // panel, so clearing one side says nothing about the other.
      const alpha = parseRgba(ink);
      const ratio = contrastRatio(
        alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : ink,
        bg
      );
      expect(
        ratio,
        `daintree border-input (${ink}) is ${ratio.toFixed(2)}:1 on ${surface} (${scheme.tokens[surface]}); WCAG 1.4.11 wants ${INPUT_BOUNDARY_MIN_CONTRAST}:1`
      ).toBeGreaterThanOrEqual(INPUT_BOUNDARY_MIN_CONTRAST);
    }
  });

  it("is exactly border-strong on every theme that does not opt in", () => {
    const optedIn = new Set(["daintree"]);
    const others = BUILT_IN_APP_SCHEMES.filter((s) => !optedIn.has(s.id));
    expect(others.length).toBeGreaterThan(0);
    for (const scheme of others) {
      expect(
        scheme.tokens["border-input"],
        `${scheme.id} must inherit border-strong until it deliberately raises its field edge`
      ).toBe(scheme.tokens["border-strong"]);
    }
  });
});

describe("border-input on a partial import", () => {
  it("follows the resolved border-strong when the import names neither token", async () => {
    // Normalisation seeds a partial theme from a fallback scheme, and that
    // scheme can carry an explicit `border-input` of its own. An import that
    // never mentioned input borders must not inherit another theme's.
    const { normalizeAppColorScheme } = await import("../themes.js");
    const scheme = normalizeAppColorScheme({
      id: "partial-import",
      name: "Partial import",
      type: "dark",
      tokens: { "surface-canvas": "#101010" },
    } as never);
    expect(scheme.tokens["border-input"]).toBe(scheme.tokens["border-strong"]);
  });

  it("keeps an input border the import sets itself", async () => {
    const { normalizeAppColorScheme } = await import("../themes.js");
    const scheme = normalizeAppColorScheme({
      id: "explicit-import",
      name: "Explicit import",
      type: "dark",
      tokens: { "surface-canvas": "#101010", "border-input": "#abcdef" },
    } as never);
    expect(scheme.tokens["border-input"]).toBe("#abcdef");
  });
});
