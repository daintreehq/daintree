import { describe, it, expect } from "vitest";
import { describeExitStatus } from "../exitStatus";

describe("describeExitStatus", () => {
  it("treats only a non-zero code as a failure", () => {
    for (const code of [1, 2, 127, 130, 255, -1]) {
      expect(describeExitStatus(code).failed).toBe(true);
    }
    expect(describeExitStatus(0).failed).toBe(false);
    expect(describeExitStatus(null).failed).toBe(false);
    expect(describeExitStatus(undefined).failed).toBe(false);
  });

  it("names the code in both the badge and the detail when there is one", () => {
    for (const code of [0, 1, 137]) {
      const { badge, detail } = describeExitStatus(code);
      expect(badge).toContain(String(code));
      expect(detail).toContain(String(code));
    }
  });

  it("never leaves a dangling 'exit' with no code after it", () => {
    for (const code of [null, undefined]) {
      const { badge, detail } = describeExitStatus(code);
      expect(badge).not.toMatch(/exit\s*\]/);
      expect(badge).not.toMatch(/\d/);
      expect(detail).not.toMatch(/:\s*$/);
      expect(detail).not.toMatch(/\d/);
    }
  });
});
