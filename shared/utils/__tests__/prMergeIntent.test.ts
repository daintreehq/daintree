import { describe, expect, it } from "vitest";
import { describeMergeIntent, mergeIntentEqual, mergeIntentLabel } from "../prMergeIntent.js";

describe("prMergeIntent", () => {
  it("labels only what the forge reported", () => {
    expect(mergeIntentLabel({ kind: "auto-merge", method: "squash", enabledAt: 1 })).toBe(
      "auto-merge · squash"
    );
    expect(mergeIntentLabel({ kind: "auto-merge", method: null, enabledAt: null })).toBe(
      "auto-merge"
    );
    expect(mergeIntentLabel({ kind: "queued", position: 3 })).toBe("queued #3");
    expect(mergeIntentLabel({ kind: "queued", position: null })).toBe("queued");
  });

  it("attributes who armed it when known", () => {
    expect(
      describeMergeIntent({
        kind: "auto-merge",
        method: "merge",
        enabledAt: 1,
        enabledBy: "octocat",
      })
    ).toBe("Auto-merge armed by octocat (merge commit) — GitHub merges it once requirements pass");
  });

  it("compares by value, keeping null and absent apart", () => {
    expect(mergeIntentEqual(null, undefined)).toBe(false);
    expect(mergeIntentEqual(null, null)).toBe(true);
    expect(
      mergeIntentEqual(
        { kind: "auto-merge", method: "squash", enabledAt: 1 },
        { kind: "auto-merge", method: "squash", enabledAt: 1 }
      )
    ).toBe(true);
    expect(
      mergeIntentEqual(
        { kind: "auto-merge", method: "squash", enabledAt: 1 },
        { kind: "auto-merge", method: "squash", enabledAt: 1, enabledBy: "x" }
      )
    ).toBe(false);
    expect(
      mergeIntentEqual(
        { kind: "queued", position: 1 },
        { kind: "auto-merge", method: null, enabledAt: 1 }
      )
    ).toBe(false);
  });
});
