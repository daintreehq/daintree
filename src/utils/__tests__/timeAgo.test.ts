import { describe, it, expect, vi, afterEach } from "vitest";
import { formatTimeAgo } from "../timeAgo";

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

  it("returns a locale date string for timestamps older than 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));
    const result = formatTimeAgo("2024-01-15T12:00:00Z");
    expect(result).toBe(new Date("2024-01-15T12:00:00Z").toLocaleDateString());
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
  });
});
