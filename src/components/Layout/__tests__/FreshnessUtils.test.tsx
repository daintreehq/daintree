// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  freshnessClass,
  FreshnessGlyph,
  formatTimeSince,
  freshnessSuffix,
  badgeFreshnessSuffix,
} from "../FreshnessUtils";

describe("freshnessClass", () => {
  it("returns empty string for fresh level", () => {
    expect(freshnessClass("fresh")).toBe("");
  });

  it("returns opacity-75 for aging level", () => {
    expect(freshnessClass("aging")).toBe("opacity-75");
  });

  it("returns border-l-2 border-border-default italic for stale-disk level, not opacity", () => {
    const result = freshnessClass("stale-disk");
    expect(result).toBe("border-l-2 border-border-default italic");
    expect(result).not.toMatch(/\bopacity-/);
  });

  it("returns border-l-2 border-border-default italic for errored level, not opacity", () => {
    const result = freshnessClass("errored");
    expect(result).toBe("border-l-2 border-border-default italic");
    expect(result).not.toMatch(/\bopacity-/);
  });
});

describe("FreshnessGlyph", () => {
  it("renders nothing for fresh level", () => {
    const { container } = render(<FreshnessGlyph level="fresh" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders a clock glyph for aging level (issue #8180 — replaces opacity dim)", () => {
    const { container } = render(<FreshnessGlyph level="aging" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("renders a clock glyph for stale-disk level", () => {
    const { container } = render(<FreshnessGlyph level="stale-disk" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("renders nothing for errored level (covered by GitHubStatusIndicator)", () => {
    const { container } = render(<FreshnessGlyph level="errored" />);
    expect(container.querySelector("svg")).toBeNull();
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

describe("badgeFreshnessSuffix", () => {
  const now = 10_000_000_000;

  it("returns empty string for undefined cause", () => {
    expect(badgeFreshnessSuffix(undefined, null, now)).toBe("");
  });

  it("returns aging suffix with time for stale cause", () => {
    const suffix = badgeFreshnessSuffix("stale", now - 120_000, now);
    expect(suffix).toContain("updated");
    expect(suffix).toContain("2m ago");
  });

  it("returns rate limited suffix without reset time when resetAt is null", () => {
    const suffix = badgeFreshnessSuffix("rate-limit", null, now, null);
    expect(suffix).toBe(" · rate limited");
  });

  it("returns rate limited suffix without reset time when resetAt is in the past", () => {
    const suffix = badgeFreshnessSuffix("rate-limit", null, now, now - 1000);
    expect(suffix).toBe(" · rate limited");
  });

  it("returns rate limited suffix with retry time when resetAt is in the future", () => {
    // 1 hour from now
    const resetAt = now + 3_600_000;
    const suffix = badgeFreshnessSuffix("rate-limit", null, now, resetAt);
    expect(suffix).toContain("rate limited");
    expect(suffix).toContain("retry at");
  });

  it("returns circuit-breaker suffix", () => {
    const suffix = badgeFreshnessSuffix("circuit-breaker", null, now);
    expect(suffix).toBe(" · data may be stale — PR detection paused");
  });
});
