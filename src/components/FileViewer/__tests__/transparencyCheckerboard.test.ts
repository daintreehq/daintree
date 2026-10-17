import { describe, expect, it } from "vitest";
import {
  TRANSPARENCY_CHECKERBOARD_STYLE,
  transparencyCheckerboardUnderScale,
} from "../transparencyCheckerboard";

const tileOf = (size: unknown) => parseFloat(String(size));

describe("transparencyCheckerboardUnderScale", () => {
  it("keeps the on-screen tile the same size at every zoom", () => {
    const base = tileOf(TRANSPARENCY_CHECKERBOARD_STYLE.backgroundSize);
    for (const scale of [0.1, 0.5, 1, 2.5, 16]) {
      const tile = tileOf(transparencyCheckerboardUnderScale(scale).backgroundSize);
      expect(tile * scale).toBeCloseTo(base);
    }
  });
});
