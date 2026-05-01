import { describe, expect, it } from "vitest";
import {
  MAX_NOTIFICATION_COUNT,
  formatNotificationCountAriaLabel,
  formatNotificationCountGlyph,
} from "../notificationCount";

describe("formatNotificationCountGlyph", () => {
  it("returns the bare number for values at or below the cap", () => {
    expect(formatNotificationCountGlyph(1)).toBe("1");
    expect(formatNotificationCountGlyph(50)).toBe("50");
    expect(formatNotificationCountGlyph(MAX_NOTIFICATION_COUNT)).toBe("99");
  });

  it("returns the capped sentinel for values above the cap", () => {
    expect(formatNotificationCountGlyph(MAX_NOTIFICATION_COUNT + 1)).toBe("99+");
    expect(formatNotificationCountGlyph(142)).toBe("99+");
    expect(formatNotificationCountGlyph(10_000)).toBe("99+");
  });

  it("supports an arbitrary prefix and applies the cap to the digits portion only", () => {
    expect(formatNotificationCountGlyph(5, "×")).toBe("×5");
    expect(formatNotificationCountGlyph(99, "×")).toBe("×99");
    expect(formatNotificationCountGlyph(150, "×")).toBe("×99+");
  });

  it("guards non-finite and negative values", () => {
    expect(formatNotificationCountGlyph(Number.NaN)).toBe("0");
    expect(formatNotificationCountGlyph(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatNotificationCountGlyph(-3)).toBe("0");
  });

  it("floors fractional counts toward the integer below", () => {
    // .floor (not .round) is intentional: 1.9 stays sub-threshold for the
    // chip's >1 visibility gate; 99.9 stays uncapped.
    expect(formatNotificationCountGlyph(1.9)).toBe("1");
    expect(formatNotificationCountGlyph(2.1)).toBe("2");
    expect(formatNotificationCountGlyph(99.9)).toBe("99");
    expect(formatNotificationCountGlyph(100.1)).toBe("99+");
  });
});

describe("formatNotificationCountAriaLabel", () => {
  it("returns the exact count even when the visible glyph is capped", () => {
    expect(formatNotificationCountAriaLabel(1)).toBe("1 events");
    expect(formatNotificationCountAriaLabel(99)).toBe("99 events");
    expect(formatNotificationCountAriaLabel(142)).toBe("142 events");
    expect(formatNotificationCountAriaLabel(10_000)).toBe("10000 events");
  });

  it("guards non-finite and negative values", () => {
    expect(formatNotificationCountAriaLabel(Number.NaN)).toBe("0 events");
    expect(formatNotificationCountAriaLabel(-3)).toBe("0 events");
  });
});
