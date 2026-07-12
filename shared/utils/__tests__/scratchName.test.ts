import { describe, it, expect } from "vitest";
import { defaultScratchName } from "../scratchName";

describe("defaultScratchName", () => {
  // Named for what it can actually prove: on a UTC CI runner a getUTC* implementation
  // would be indistinguishable from a local-time one, so this asserts field mapping.
  it("maps each rendered field to the date's corresponding getter", () => {
    const date = new Date(2026, 0, 5, 9, 7);
    const name = defaultScratchName(date);
    const match = /^Scratch (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(name);

    expect(match).not.toBeNull();
    const [, year, month, day, hours, minutes] = match!;
    expect(Number(year)).toBe(date.getFullYear());
    // getMonth() is zero-based; the rendered month must not be.
    expect(Number(month)).toBe(date.getMonth() + 1);
    expect(Number(day)).toBe(date.getDate());
    expect(Number(hours)).toBe(date.getHours());
    expect(Number(minutes)).toBe(date.getMinutes());
  });

  it("zero-pads single-digit fields to a fixed width", () => {
    const name = defaultScratchName(new Date(2026, 8, 3, 4, 5));
    expect(name).toMatch(/^Scratch \d{4}-09-03 04:05$/);
  });

  it("keeps two-digit fields unpadded", () => {
    const name = defaultScratchName(new Date(2026, 10, 23, 14, 38));
    expect(name).toMatch(/^Scratch \d{4}-11-23 14:38$/);
  });

  it("uses a 24-hour clock", () => {
    const evening = defaultScratchName(new Date(2026, 0, 1, 23, 0));
    expect(evening).toContain(" 23:00");
  });

  it("produces distinct names for dates a minute apart", () => {
    const a = defaultScratchName(new Date(2026, 0, 1, 10, 30));
    const b = defaultScratchName(new Date(2026, 0, 1, 10, 31));
    expect(a).not.toBe(b);
  });
});
