import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldDeferRendererLoadForE2E } from "../earlyRenderer.js";

describe("shouldDeferRendererLoadForE2E", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true only for the explicit E2E deferral flag", () => {
    vi.stubEnv("DAINTREE_E2E_DEFER_RENDERER_LOAD", "1");
    expect(shouldDeferRendererLoadForE2E()).toBe(true);

    for (const value of [undefined, "", "0", "true", "yes"]) {
      vi.stubEnv("DAINTREE_E2E_DEFER_RENDERER_LOAD", value);
      expect(shouldDeferRendererLoadForE2E()).toBe(false);
    }
  });
});
