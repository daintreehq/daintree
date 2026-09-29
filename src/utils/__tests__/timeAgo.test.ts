import { describe, it, expect, vi, afterEach } from "vitest";
import { formatAbsoluteDate, formatLastChecked, formatTimeAgo } from "../timeAgo";

describe("formatTimeAgo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than 60 seconds ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:30Z"));
    expect(formatTimeAgo("2024-01-15T12:00:00Z")).toBe("just now");
  });

  it("returns minutes ago for timestamps less than 1 hour ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:05:00Z"));
    expect(formatTimeAgo("2024-01-15T12:00:00Z")).toBe("5m ago");
  });

  it("returns hours ago for timestamps less than 1 day ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T15:00:00Z"));
    expect(formatTimeAgo("2024-01-15T12:00:00Z")).toBe("3h ago");
  });

  it("returns days ago for timestamps less than 30 days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00Z"));
    expect(formatTimeAgo("2024-01-15T12:00:00Z")).toBe("5d ago");
  });

  it("returns 'Unknown' for invalid date strings", () => {
    expect(formatTimeAgo("not-a-date")).toBe("Unknown");
    expect(formatTimeAgo("")).toBe("Unknown");
    expect(formatTimeAgo("garbage|data")).toBe("Unknown");
  });

  it("falls back to a short month-day date past 30 days, never a numeric date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));
    const result = formatTimeAgo("2024-01-15T12:00:00Z");
    expect(result).toBe(formatAbsoluteDate(Date.parse("2024-01-15T12:00:00Z"), Date.now()));
    expect(result).not.toMatch(/^\d+[/.-]\d+/);
    expect(result).not.toMatch(/ago$/);
  });

  it("adds the year only when the date is outside the current one", () => {
    const now = Date.parse("2024-03-15T12:00:00Z");
    expect(formatAbsoluteDate(Date.parse("2024-01-15T12:00:00Z"), now)).not.toMatch(/2024/);
    expect(formatAbsoluteDate(Date.parse("2023-01-15T12:00:00Z"), now)).toMatch(/2023/);
  });

  describe("numeric epoch ms input", () => {
    it("returns 'just now' for epoch ms less than 60 seconds ago", () => {
      vi.useFakeTimers();
      const now = new Date("2024-01-15T12:00:30Z");
      vi.setSystemTime(now);
      expect(formatTimeAgo(now.getTime() - 10_000)).toBe("just now");
    });

    it("returns minutes ago for epoch ms less than 1 hour ago", () => {
      vi.useFakeTimers();
      const now = new Date("2024-01-15T12:05:00Z");
      vi.setSystemTime(now);
      expect(formatTimeAgo(now.getTime() - 5 * 60_000)).toBe("5m ago");
    });

    it("returns hours ago for epoch ms less than 1 day ago", () => {
      vi.useFakeTimers();
      const now = new Date("2024-01-15T15:00:00Z");
      vi.setSystemTime(now);
      expect(formatTimeAgo(now.getTime() - 3 * 3_600_000)).toBe("3h ago");
    });

    it("returns days ago for epoch ms less than 30 days ago", () => {
      vi.useFakeTimers();
      const now = new Date("2024-01-20T12:00:00Z");
      vi.setSystemTime(now);
      expect(formatTimeAgo(now.getTime() - 5 * 86_400_000)).toBe("5d ago");
    });

    it("returns the short date for epoch ms older than 30 days", () => {
      vi.useFakeTimers();
      const now = new Date("2024-03-15T12:00:00Z");
      vi.setSystemTime(now);
      const oldDate = new Date("2024-01-15T12:00:00Z");
      expect(formatTimeAgo(oldDate.getTime())).toBe(
        formatAbsoluteDate(oldDate.getTime(), now.getTime())
      );
    });

    it("returns 'Unknown' for NaN input", () => {
      expect(formatTimeAgo(NaN)).toBe("Unknown");
    });
  });

  describe("formatLastChecked", () => {
    it("is the compact age behind one fixed prefix, with no trailing period", () => {
      const now = Date.parse("2024-01-15T12:05:00Z");
      const label = formatLastChecked(now - 5 * 60_000, now);
      expect(label).toMatch(/^Last checked \d+m ago$/);
    });
  });
});
