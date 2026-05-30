import { describe, expect, it } from "vitest";
import { shouldDeferRendererLoadForE2E } from "../earlyRenderer.js";

describe("shouldDeferRendererLoadForE2E", () => {
  it("returns true only for the explicit E2E deferral flag", () => {
    expect(shouldDeferRendererLoadForE2E({ env: { DAINTREE_E2E_DEFER_RENDERER_LOAD: "1" } })).toBe(
      true
    );

    for (const value of [undefined, "", "0", "true", "yes"]) {
      expect(
        shouldDeferRendererLoadForE2E({
          env: value === undefined ? {} : { DAINTREE_E2E_DEFER_RENDERER_LOAD: value },
        })
      ).toBe(false);
    }
  });
});
