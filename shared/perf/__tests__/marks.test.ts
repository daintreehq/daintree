import { describe, expect, it } from "vitest";
import { PERF_MARKS } from "../marks.js";

describe("PERF_MARKS", () => {
  it("has unique values", () => {
    const values = Object.values(PERF_MARKS);
    expect(new Set(values).size).toBe(values.length);
  });
});
