import { describe, it, expect } from "vitest";
import { formatTokenCount } from "../formatTokenCount";

describe("formatTokenCount", () => {
  it("returns raw number below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1499)).toBe("1k");
    expect(formatTokenCount(1500)).toBe("2k");
    expect(formatTokenCount(45000)).toBe("45k");
  });

  it("formats millions with m suffix", () => {
    expect(formatTokenCount(1000000)).toBe("1.0m");
    expect(formatTokenCount(2300000)).toBe("2.3m");
  });
});
