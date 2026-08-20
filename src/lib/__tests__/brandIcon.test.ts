import { describe, expect, it } from "vitest";
import { contrastRatio } from "@shared/theme";
import { resolveBrandBadge } from "../brandIcon";

const NON_TEXT_FLOOR = 3;

describe("resolveBrandBadge", () => {
  it("paints the tile in the color it was given, untouched", () => {
    // The whole point of the split: legibility is bought with the ink, never by
    // altering the identity color. A mid-tone that the old resolver would have
    // darkened must survive byte-for-byte.
    expect(resolveBrandBadge("#CC785C")?.tile).toBe("#CC785C");
    expect(resolveBrandBadge("#dddddd")?.tile).toBe("#dddddd");
  });

  it("picks whichever ink actually contrasts better with the tile", () => {
    for (const hex of ["#CC785C", "#1E90FF", "#8957e5", "#E8E8E8", "#111111", "#10a37f"]) {
      const badge = resolveBrandBadge(hex);
      expect(badge).not.toBeNull();
      const chosen = contrastRatio(badge!.glyph, hex);
      const rejected = contrastRatio(badge!.glyph === "#FFFFFF" ? "#000000" : "#FFFFFF", hex);
      expect(chosen).toBeGreaterThanOrEqual(rejected);
    }
  });

  it("clears the non-text floor against its own tile for any color", () => {
    // Sampled across the cube rather than a hand-picked list: the guarantee is
    // universal, so a color that breaks it should fail here and not in the UI.
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
          const badge = resolveBrandBadge(hex);
          expect(contrastRatio(badge!.glyph, badge!.tile)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
        }
      }
    }
  });

  it("rings the tile in its own ink, so an achromatic tile still has an edge", () => {
    // goose/interpreter sit within ~1.1:1 of a dark surface and grok of a light
    // one; the ring is the only thing that delimits them, and it has to flip
    // with the ink to stay visible.
    // Full value, not a substring: a fully opaque or fully transparent ring
    // would still contain the right channels and prove nothing.
    expect(resolveBrandBadge("#111111")?.ring).toBe("rgba(255, 255, 255, 0.15)");
    expect(resolveBrandBadge("#E8E8E8")?.ring).toBe("rgba(0, 0, 0, 0.15)");
  });

  it("expands shorthand hex", () => {
    expect(resolveBrandBadge("#fff")?.glyph).toBe(resolveBrandBadge("#ffffff")?.glyph);
    expect(resolveBrandBadge("#000")?.glyph).toBe(resolveBrandBadge("#000000")?.glyph);
  });

  it("flattens a translucent color instead of letting a surface through", () => {
    // A half-alpha tile would composite against the caller's chrome, which is
    // the surface dependence this module exists to remove.
    const badge = resolveBrandBadge("#00000080");
    expect(badge?.tile).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(badge!.glyph, badge!.tile)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
  });

  it("returns null when there is no usable color", () => {
    expect(resolveBrandBadge("not-a-color")).toBeNull();
    expect(resolveBrandBadge(undefined)).toBeNull();
    expect(resolveBrandBadge("")).toBeNull();
  });
});
