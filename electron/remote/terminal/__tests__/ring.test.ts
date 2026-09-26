import { describe, expect, it } from "vitest";
import { RingBudget, TerminalRing } from "../ring.js";

function frame(seq: number, size: number) {
  return { seq, data: new Uint8Array(size), bytes: size };
}

describe("TerminalRing", () => {
  it("keeps contiguous frames and serves them by seq", () => {
    const ring = new TerminalRing(10_000, new RingBudget(100_000));
    for (let seq = 1; seq <= 5; seq++) ring.push(frame(seq, 10));
    expect(ring.firstSeq).toBe(1);
    expect(ring.get(3)?.seq).toBe(3);
    expect(ring.get(6)).toBeNull();
    expect(ring.covers(0, 5)).toBe(true);
    expect(ring.covers(5, 5)).toBe(true);
  });

  it("evicts oldest-first past its own cap", () => {
    const ring = new TerminalRing(3 * (100 + 64), new RingBudget(100_000));
    for (let seq = 1; seq <= 5; seq++) ring.push(frame(seq, 100));
    expect(ring.length).toBe(3);
    expect(ring.firstSeq).toBe(3);
    expect(ring.get(2)).toBeNull();
    expect(ring.covers(1, 5)).toBe(false);
    expect(ring.covers(2, 5)).toBe(true);
  });

  it("starts over when the sequence jumps", () => {
    const ring = new TerminalRing(10_000, new RingBudget(100_000));
    ring.push(frame(1, 10));
    ring.push(frame(2, 10));
    ring.push(frame(1, 10));
    expect(ring.length).toBe(1);
    expect(ring.firstSeq).toBe(1);
  });
});

describe("RingBudget", () => {
  it("caps the total across rings by evicting from the largest", () => {
    const budget = new RingBudget(1_000);
    const big = new TerminalRing(10_000, budget);
    const small = new TerminalRing(10_000, budget);
    small.push(frame(1, 36));
    for (let seq = 1; seq <= 10; seq++) big.push(frame(seq, 136));
    expect(budget.usedBytes).toBeLessThanOrEqual(1_000);
    expect(small.length).toBe(1);
    expect(big.firstSeq).toBeGreaterThan(1);
  });

  it("releases a ring's bytes when it is disposed", () => {
    const budget = new RingBudget(10_000);
    const ring = new TerminalRing(10_000, budget);
    ring.push(frame(1, 500));
    expect(budget.usedBytes).toBeGreaterThan(0);
    ring.dispose();
    expect(budget.usedBytes).toBe(0);
  });
});
