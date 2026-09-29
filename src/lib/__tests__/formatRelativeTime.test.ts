import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../formatRelativeTime";
import { formatAbsoluteDate } from "@/utils/timeAgo";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const DAY = 86_400_000;

describe("formatRelativeTime", () => {
  it("spells the unit out inside 30 days", () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toMatch(/minutes ago$/);
    expect(formatRelativeTime(NOW - 12 * DAY, NOW)).toMatch(/days ago$/);
  });

  it("falls back to the same short date as formatTimeAgo past 30 days", () => {
    const old = NOW - 45 * DAY;
    expect(formatRelativeTime(old, NOW)).toBe(formatAbsoluteDate(old, NOW));
    expect(formatRelativeTime(old, NOW)).not.toMatch(/ago$/);
  });

  it("still reads future timestamps relatively", () => {
    expect(formatRelativeTime(NOW + 3 * 60 * 60_000, NOW)).toMatch(/^in /);
  });
});
