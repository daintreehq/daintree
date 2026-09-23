import { describe, it, expect } from "vitest";
import { moveFallback } from "../FallbackChainEditor";

const CHAIN = ["a", "b", "c", "d"];

describe("moveFallback", () => {
  it("keeps every entry exactly once", () => {
    for (let from = 0; from < CHAIN.length; from++) {
      for (const to of [from - 1, from + 1]) {
        const next = moveFallback(CHAIN, from, to);
        expect([...next].sort()).toEqual([...CHAIN].sort());
      }
    }
  });

  it("moves only the chosen entry, leaving the others in their relative order", () => {
    for (let from = 0; from < CHAIN.length; from++) {
      for (const to of [from - 1, from + 1]) {
        if (to < 0 || to >= CHAIN.length) continue;
        const next = moveFallback(CHAIN, from, to);
        expect(next[to]).toBe(CHAIN[from]);
        const others = (list: string[]) => list.filter((x) => x !== CHAIN[from]);
        expect(others(next)).toEqual(others(CHAIN));
      }
    }
  });

  it("leaves the chain alone for a move past either end", () => {
    expect(moveFallback(CHAIN, 0, -1)).toEqual(CHAIN);
    expect(moveFallback(CHAIN, CHAIN.length - 1, CHAIN.length)).toEqual(CHAIN);
  });
});
