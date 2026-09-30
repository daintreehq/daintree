import { describe, expect, it } from "vitest";
import { parseE2ETimerOverrideMs } from "../e2eTimerOverrides.js";

describe("parseE2ETimerOverrideMs", () => {
  it.each([
    ["3000", 3000],
    [" 8000 ", 8000],
    ["100", 100],
    ["600000", 600_000],
  ])("accepts %j", (raw, expected) => {
    expect(parseE2ETimerOverrideMs(raw)).toBe(expected);
  });

  it.each([undefined, "", "  ", "abc", "3s", "-1", "1.5", "1e4", "0", "99", "600001"])(
    "rejects %j",
    (raw) => {
      expect(parseE2ETimerOverrideMs(raw)).toBeNull();
    }
  );
});
