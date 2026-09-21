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

  it("keeps placeholder text legible on every display surface", () => {
    const raw = daintree?.tokens["text-placeholder"] as string;

    const failures: string[] = [];
    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;

      const alpha = parseRgba(raw);
      const fg = alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : raw;
      const ratio = contrastRatio(fg, bg);

      // 4.5:1, not the 3:1 graphical tier: daintree's placeholders carry real
      // information ("Commit message…", "Search agents & panels…"), so they are
      // read as text. Clearing the stricter bar is a deliberate commitment for
      // this theme, not a claim about what every theme owes.
      if (ratio < 4.5) failures.push(`${surface}: ${ratio.toFixed(2)}:1`);
    }

    expect(failures).toEqual([]);
  });

  it("stays quieter than text-secondary, so a placeholder never reads as a value", () => {
    const placeholder = daintree?.tokens["text-placeholder"] as string;
    const secondary = daintree?.tokens["text-secondary"] as string;

    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;
      expect(contrastRatio(placeholder, bg)).toBeLessThan(contrastRatio(secondary, bg));
    }
  });
});
