import { describe, it, expect } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { blendOverBackground, contrastRatio } from "@shared/theme/contrast";
import { DROP_INDICATOR_INK, DROP_INDICATOR_LINE, DROP_SLOT_FRAME } from "../dropIndicator";

const alpha = Number(DROP_INDICATOR_INK.split("/")[1]) / 100;

// The surfaces an insertion line or slot frame is ever drawn over: the dock and
// sidebar rails, the grid gutter, and the canvas the grid inherits when a theme
// declares no grid surface of its own.
const DROP_SURFACES = ["surface-sidebar", "surface-grid", "surface-canvas"] as const;

/**
 * An insertion line is the only thing telling the user where the drop will
 * land, which makes it a state indicator under WCAG 1.4.11: 3:1 against its
 * surface, on every theme. The rule is pinned as the measurement, not the
 * alpha, so a theme added later or a retuned ink both have to keep clearing it.
 */
describe("drop indicator ink", () => {
  it("names an alpha composite of the primary text ink", () => {
    expect(DROP_INDICATOR_INK).toMatch(/^text-primary\/\d+$/);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThanOrEqual(1);
  });

  it("clears 3:1 against every built-in theme's drop surfaces", () => {
    expect(BUILT_IN_APP_SCHEMES.length).toBeGreaterThan(0);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const ink = scheme.tokens["text-primary"];
      for (const key of DROP_SURFACES) {
        const surface = scheme.tokens[key];
        const line = blendOverBackground(ink, surface, alpha);
        expect(contrastRatio(line, surface), `${scheme.id}: ${key}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("uses the one ink for lines and slot frames alike", () => {
    expect(DROP_INDICATOR_LINE).toContain(`bg-${DROP_INDICATOR_INK}`);
    expect(DROP_SLOT_FRAME).toContain(`border-${DROP_INDICATOR_INK}`);
  });

  it("repaints in a system colour under forced colours, the way the app's state marks do", () => {
    expect(DROP_INDICATOR_LINE).toMatch(/forced-colors:bg-\[CanvasText\]/);
    expect(DROP_SLOT_FRAME).toMatch(/forced-colors:border-\[CanvasText\]/);
  });

  it("stays off the accent", () => {
    expect(`${DROP_INDICATOR_LINE} ${DROP_SLOT_FRAME}`).not.toMatch(/accent/);
  });
});
