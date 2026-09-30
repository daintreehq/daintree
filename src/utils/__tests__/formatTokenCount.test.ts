import { describe, it, expect } from "vitest";
import { formatTokenCount } from "../formatTokenCount";

describe("formatTokenCount", () => {
  it("returns the raw number below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("keeps one decimal for single-digit thousands", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1499)).toBe("1.5k");
    expect(formatTokenCount(9949)).toBe("9.9k");
  });

  it("rounds to whole thousands once the decimal would add a digit", () => {
    expect(formatTokenCount(9950)).toBe("10k");
    expect(formatTokenCount(45000)).toBe("45k");
  });

  it("formats millions with an upper-case M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_300_000)).toBe("2.3M");
  });

  it("never prints 1000k at the k/M boundary", () => {
    for (const n of [999_499, 999_500, 999_999]) {
      expect(formatTokenCount(n)).not.toMatch(/^1000k$/);
    }
    expect(formatTokenCount(999_500)).toBe("1.0M");
  });

  it("never uses a lower-case m", () => {
    for (const n of [1_000_000, 12_345_678]) {
      expect(formatTokenCount(n)).not.toMatch(/m$/);
    }
  });
});
