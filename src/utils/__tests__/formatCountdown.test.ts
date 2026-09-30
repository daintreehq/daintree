import { describe, it, expect } from "vitest";
import { formatCountdown } from "../formatCountdown";

describe("formatCountdown", () => {
  it("renders sub-minute durations as bare seconds", () => {
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(1)).toBe("1s");
    expect(formatCountdown(59)).toBe("59s");
  });

  it("renders an exact minute without a trailing seconds component", () => {
    expect(formatCountdown(60)).toBe("1m");
    expect(formatCountdown(120)).toBe("2m");
  });

  it("renders mixed minute+second durations", () => {
    expect(formatCountdown(61)).toBe("1m 1s");
    expect(formatCountdown(125)).toBe("2m 5s");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatCountdown(61.9)).toBe("1m 1s");
    expect(formatCountdown(-5)).toBe("0s");
  });
});
