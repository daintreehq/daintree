import { describe, expect, it } from "vitest";
import { isValidPastTimestamp } from "../timestamps";

describe("isValidPastTimestamp", () => {
  const now = 10_000;

  it("accepts positive timestamps through the supplied current time", () => {
    expect(isValidPastTimestamp(1, now)).toBe(true);
    expect(isValidPastTimestamp(now, now)).toBe(true);
  });

  it.each([undefined, null, 0, -1, Number.NaN, Infinity, now + 1])(
    "rejects an invalid or future timestamp (%s)",
    (timestamp) => {
      expect(isValidPastTimestamp(timestamp, now)).toBe(false);
    }
  );
});
