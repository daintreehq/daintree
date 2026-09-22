import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "../index.js";

/**
 * `text-placeholder` on the default dark theme.
 *
 * The engine derives this token as `text-primary` at 35% alpha when a theme
 * declares nothing, which put daintree at 2.7–2.8:1 on every display surface —
 * below even this repo's own placeholder floor, which `MATRIX_CONTRAST_PAIRS`
 * sets at a 3:1 graphical tier. Nothing caught it because that pair carries
 * `appliesTo: "light"`, so no dark theme is measured against it.
 *
 * These assertions are about the RULE, not the value: any hex that keeps
 * placeholders legible on every surface passes, and the test says nothing about
 * which hex that is. What it refuses is the two ways this regressed before —
 * dropping back to the alpha derivation, and drifting under the floor.
 */
describe("daintree text-placeholder", () => {
  const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree");

  it("is a built-in scheme", () => {
    expect(daintree).toBeDefined();
  });

  it("declares the token solid rather than inheriting the alpha derivation", () => {
    // An alpha text colour bakes into `color-mix()` on `color`, and the design
    // system bans slash-alpha text precisely because the contrast cannot then
    // be recovered downstream. A solid token is the only correctable form.
    const raw = daintree?.tokens["text-placeholder"];
    expect(raw).toBeDefined();
    expect(parseRgba(raw as string)).toBeNull();
  });

  it("clears the placeholder floor on every display surface", () => {
    const raw = daintree?.tokens["text-placeholder"] as string;

    const failures: string[] = [];
    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;

      const alpha = parseRgba(raw);
      const fg = alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : raw;
      const ratio = contrastRatio(fg, bg);

      // 3:1, matching `MATRIX_CONTRAST_PAIRS` — this repo treats placeholder as
      // a graphical-tier de-emphasis, not 4.5:1 body text. That tier is the
      // house position and it outranks the stricter external reading: a
      // placeholder that clears AA stops receding from `text-muted`, which the
      // role ramp in `scripts/theme-text-contrast.test.ts` requires it to do.
      // The derivation this replaced sat at 2.7-2.8:1, under even this floor.
      if (ratio < 3) failures.push(`${surface}: ${ratio.toFixed(2)}:1`);
    }

    expect(failures).toEqual([]);
  });

  it("recedes from text-muted, so the role ramp keeps its order", () => {
    // The ramp is primary > secondary > muted > placeholder. A placeholder that
    // outruns muted inverts it, and "nearest role" stops meaning anything.
    const placeholder = daintree?.tokens["text-placeholder"] as string;
    const muted = daintree?.tokens["text-muted"] as string;

    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;
      expect(contrastRatio(placeholder, bg)).toBeLessThan(contrastRatio(muted, bg));
    }
  });
});
