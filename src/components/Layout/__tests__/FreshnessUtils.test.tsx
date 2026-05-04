import { describe, it, expect } from "vitest";
import { freshnessOpacityClass, formatTimeSince, freshnessSuffix } from "../FreshnessUtils";

describe("freshnessOpacityClass", () => {
  it("returns empty string for fresh level", () => {
    expect(freshnessOpacityClass("fresh")).toBe("");
  });

  it("returns opacity-75 for aging level", () => {
    expect(freshnessOpacityClass("aging")).toBe("opacity-75");
  });

  it("returns opacity-60 for stale-disk level", () => {
    expect(freshnessOpacityClass("stale-disk")).toBe("opacity-60");
  });

  it("returns opacity-50 for errored level", () => {
    expect(freshnessOpacityClass("errored")).toBe("opacity-50");
  });
});

describe("formatTimeSince", () => {
  const now = 10_000_000_000;

  it('returns "unknown" for null timestamp', () => {
    expect(formatTimeSince(null, now)).toBe("unknown");
  });

  it('returns "just now" for timestamps under 60s ago', () => {
    expect(formatTimeSince(now - 0, now)).toBe("just now");
    expect(formatTimeSince(now - 30_000, now)).toBe("just now");
    expect(formatTimeSince(now - 59_999, now)).toBe("just now");
  });

  it('returns "1m ago" at the 60s boundary', () => {
    expect(formatTimeSince(now - 60_000, now)).toBe("1m ago");
  });

  it("returns minutes for timestamps under 60m ago", () => {
    expect(formatTimeSince(now - 120_000, now)).toBe("2m ago");
    expect(formatTimeSince(now - 3_540_000, now)).toBe("59m ago");
  });

  it('returns "1h ago" at the 60m boundary', () => {
    expect(formatTimeSince(now - 3_600_000, now)).toBe("1h ago");
  });

  it("returns hours for timestamps under 24h ago", () => {
    expect(formatTimeSince(now - 7_200_000, now)).toBe("2h ago");
    expect(formatTimeSince(now - 82_800_000, now)).toBe("23h ago");
  });

  it('returns "1d ago" at the 24h boundary', () => {
    expect(formatTimeSince(now - 86_400_000, now)).toBe("1d ago");
  });

  it("returns days for timestamps 24h+ ago", () => {
    expect(formatTimeSince(now - 172_800_000, now)).toBe("2d ago");
  });
});

describe("freshnessSuffix", () => {
  const now = 10_000_000_000;

  it("returns empty string for fresh level", () => {
    expect(freshnessSuffix("fresh", null, now)).toBe("");
  });

  it("returns aging suffix with time for aging level", () => {
    const suffix = freshnessSuffix("aging", now - 120_000, now);
    expect(suffix).toContain("updated");
    expect(suffix).toContain("2m ago");
  });

  it("returns cached message for stale-disk level", () => {
    expect(freshnessSuffix("stale-disk", null, now)).toBe(" · cached from previous session");
  });

  it("returns error message for errored level", () => {
    expect(freshnessSuffix("errored", null, now)).toBe(" · couldn't reach GitHub");
  });
});
