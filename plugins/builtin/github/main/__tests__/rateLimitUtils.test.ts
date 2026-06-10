import { describe, expect, it } from "vitest";
import { toRateLimitInfo } from "../rateLimitUtils.js";

describe("toRateLimitInfo", () => {
  it("forwards the observed budget when not blocked", () => {
    expect(
      toRateLimitInfo({
        blocked: false,
        kind: null,
        limit: 5000,
        remaining: 1200,
        throttleMultiplier: 2,
      })
    ).toEqual({ limit: 5000, remaining: 1200, resetAt: null, throttleMultiplier: 2 });
  });

  it("nulls absent budget fields when not blocked", () => {
    expect(toRateLimitInfo({ blocked: false, kind: null })).toEqual({
      limit: null,
      remaining: null,
      resetAt: null,
      throttleMultiplier: undefined,
    });
  });

  it("forces remaining to 0 when blocked so the hard-stop band can't leak", () => {
    const info = toRateLimitInfo({
      blocked: true,
      kind: "primary",
      limit: 5000,
      remaining: 37,
      resetAt: 99,
      throttleMultiplier: 4,
    });
    expect(info.remaining).toBe(0);
    expect(info.resetAt).toBe(99);
    expect(info.throttleMultiplier).toBe(4);
    expect(info.secondaryThrottled).toBeUndefined();
  });

  it("flags secondary throttling only for secondary blocks", () => {
    const info = toRateLimitInfo({ blocked: true, kind: "secondary" });
    expect(info.secondaryThrottled).toBe(true);
    expect(info.remaining).toBe(0);
    expect(info.resetAt).toBeNull();
  });
});
