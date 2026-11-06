import { describe, expect, it } from "vitest";
import { IssueNumberIndex, beadNumber } from "../issueNumbers.js";

describe("beadNumber", () => {
  it("is a stable positive safe integer that tells hierarchical ids apart", () => {
    const ids = ["dfat-39kl", "dfat-1234", "dfat-1234.1", "bd-a1b2c3"];
    const numbers = ids.map(beadNumber);
    for (const n of numbers) {
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
    expect(new Set(numbers).size).toBe(ids.length);
    expect(beadNumber("dfat-39kl")).toBe(numbers[0]);
    // An all-digit hash must not read as its own digits, as a branch claim would.
    expect(beadNumber("dfat-1234")).not.toBe(1234);
  });
});

describe("IssueNumberIndex", () => {
  it("maps numbers back per server", () => {
    const index = new IssueNumberIndex();
    const n = index.remember("https://a", "dfat-1");
    expect(index.lookup("https://a", n)).toBe("dfat-1");
    expect(index.lookup("https://b", n)).toBeNull();
  });

  it("refuses a number two ids share instead of picking one", () => {
    const index = new IssueNumberIndex();
    // Two different ids can't be made to collide on demand, so the index is
    // driven through the same slot the way a real collision would reach it.
    const n = index.remember("s", "dfat-1");
    const internal = (index as unknown as { servers: Map<string, Map<number, unknown>> }).servers;
    internal.get("s")!.set(n, "dfat-other");
    index.remember("s", "dfat-1");
    expect(() => index.lookup("s", n)).toThrow(/share issue number/);
  });
});
