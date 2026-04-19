import { describe, expect, it } from "vitest";
import { shouldEnableEarlyRenderer } from "../earlyRenderer.js";

describe("shouldEnableEarlyRenderer", () => {
  it("returns false when DAINTREE_EARLY_RENDERER is unset", () => {
    expect(shouldEnableEarlyRenderer({ isSmokeTest: false, env: {} })).toBe(false);
  });

  it("returns true when DAINTREE_EARLY_RENDERER=1 and not in smoke test", () => {
    expect(
      shouldEnableEarlyRenderer({
        isSmokeTest: false,
        env: { DAINTREE_EARLY_RENDERER: "1" },
      })
    ).toBe(true);
  });

  it("returns false when DAINTREE_EARLY_RENDERER is any value other than '1'", () => {
    for (const value of ["0", "true", "yes", "on", ""]) {
      expect(
        shouldEnableEarlyRenderer({
          isSmokeTest: false,
          env: { DAINTREE_EARLY_RENDERER: value },
        })
      ).toBe(false);
    }
  });

  it("returns false in smoke-test mode even with DAINTREE_EARLY_RENDERER=1", () => {
    // Smoke tests assert deterministic readiness — keep them on the serial path.
    expect(
      shouldEnableEarlyRenderer({
        isSmokeTest: true,
        env: { DAINTREE_EARLY_RENDERER: "1" },
      })
    ).toBe(false);
  });
});
