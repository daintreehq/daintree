import { describe, it, expect } from "vitest";
import { formatScratchCleanupCountdown } from "../ProjectSwitcherPalette";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const TTL_DAYS = 30;

describe("formatScratchCleanupCountdown", () => {
  it("returns null for fresh scratches outside the visibility window", () => {
    // 25 days left -> outside the 7-day window
    const lastOpened = NOW - 5 * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBeNull();
  });

  it("renders 'in N days' inside the visibility window", () => {
    // 5 days left
    const lastOpened = NOW - (TTL_DAYS - 5) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup in 5 days");
  });

  it("renders 'tomorrow' when 1 day left", () => {
    const lastOpened = NOW - (TTL_DAYS - 1) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup tomorrow");
  });

  it("renders 'today' when 0 days left", () => {
    const lastOpened = NOW - TTL_DAYS * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup today");
  });

  it("clamps negative remaining time to 'today'", () => {
    const lastOpened = NOW - (TTL_DAYS + 5) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup today");
  });

  it("returns null for falsy lastOpened (defensive against bad data)", () => {
    expect(formatScratchCleanupCountdown(0, NOW)).toBeNull();
  });
});
