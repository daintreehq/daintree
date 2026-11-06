import { describe, expect, it } from "vitest";
import { IssueNumberIndex, beadNumber } from "../issueNumbers.js";

describe("beadNumber", () => {
  it("keeps the numbers already handed out", () => {
    // Pinned: links and the host's caches hold these, so the hash is a contract.
    expect(beadNumber("dfat-39kl")).toBe(4065058022750427);
    expect(beadNumber("bd-a1b2c3.1")).toBe(5722190205358972);
  });

  it("is a positive safe integer that tells hierarchical ids apart", () => {
    const ids = ["dfat-39kl", "dfat-1234", "dfat-1234.1", "bd-a1b2c3"];
    const numbers = ids.map(beadNumber);
    for (const n of numbers) {
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
    expect(new Set(numbers).size).toBe(ids.length);
    // An all-digit hash must not read as its own digits, as a branch claim would.
    expect(beadNumber("dfat-1234")).not.toBe(1234);
  });
});

describe("IssueNumberIndex", () => {
  it("maps numbers back per server", () => {
    const index = new IssueNumberIndex();
    index.remember("https://a", "dfat-1", 11);
    expect(index.lookup("https://a", 11)).toBe("dfat-1");
    expect(index.lookup("https://b", 11)).toBeNull();
    index.remember("https://a", "dfat-1", 11);
    expect(index.lookup("https://a", 11)).toBe("dfat-1");
  });

  it("refuses a shared number for good, even when one side is seen again", () => {
    const index = new IssueNumberIndex();
    index.remember("s", "dfat-1", 7);
    index.remember("s", "dfat-2", 7);
    expect(() => index.lookup("s", 7)).toThrow(/share issue number 7/);
    index.remember("s", "dfat-1", 7);
    expect(() => index.lookup("s", 7)).toThrow(/share/);
  });

  it("keeps a known collision through eviction of ordinary entries", () => {
    const index = new IssueNumberIndex();
    index.remember("s", "dfat-1", 7);
    index.remember("s", "dfat-2", 7);
    for (let i = 0; i < 20_001; i++) index.remember("s", `x-${i}`, 100 + i);
    index.remember("s", "dfat-1", 7);
    expect(() => index.lookup("s", 7)).toThrow(/share/);
  });

  it("forgets one server without touching another", () => {
    const index = new IssueNumberIndex();
    index.remember("a", "dfat-1", 1);
    index.remember("b", "dfat-1", 1);
    index.forget("a");
    expect(index.lookup("a", 1)).toBeNull();
    expect(index.lookup("b", 1)).toBe("dfat-1");
  });
});
