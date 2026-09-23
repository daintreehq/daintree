import { describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES, blendOverBackground, contrastRatio, parseRgba } from "../index.js";

/**
 * The selected segment of `SegmentedRadioGroup` (the settings scope switch, every
 * settings preset row, the create-worktree mode switches) is marked by a
 * `text-secondary` boundary on the `surface-inset` track. Its fill barely moves off the
 * track, so the boundary is the state indicator WCAG 1.4.11 asks 3:1 of. The rule, not
 * the hex: any theme whose secondary ink clears the ratio on its inset track passes.
 */
const SELECTION_INDICATOR_MIN_CONTRAST = 3;

describe("segmented selection boundary", () => {
  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "clears 3:1 against the inset track on %s",
    (_id, scheme) => {
      const ink = scheme.tokens["text-secondary"];
      const inset = scheme.tokens["surface-inset"];
      // Dark themes author the track as a wash, so it is measured where the control
      // actually sits: on a settings group (panel-elevated) and on a bare panel.
      for (const surface of ["surface-panel-elevated", "surface-panel"] as const) {
        const base = scheme.tokens[surface];
        const insetAlpha = parseRgba(inset);
        const track = insetAlpha
          ? blendOverBackground(insetAlpha.hex, base, insetAlpha.opacity)
          : inset;
        const inkAlpha = parseRgba(ink);
        const ratio = contrastRatio(
          inkAlpha ? blendOverBackground(inkAlpha.hex, track, inkAlpha.opacity) : ink,
          track
        );
        expect(
          ratio,
          `${scheme.id}: text-secondary (${ink}) is ${ratio.toFixed(2)}:1 on the inset track over ${surface}`
        ).toBeGreaterThanOrEqual(SELECTION_INDICATOR_MIN_CONTRAST);
      }
    }
  );
});
