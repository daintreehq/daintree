import { describe, it, expect } from "vitest";
import { applyReplacementsCounted } from "../diagnosticsTransform.js";
import type { ReplacementRule } from "../diagnosticsTransform.js";
import { legacyApplyReplacementsCounted } from "../__bench__/legacyApplyReplacements.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = ["a", "b", "ab", "aa", " ", "x", "@", ".", "1", "\n", "abc"];
const RULE_POOL: ReplacementRule[] = [
  { kind: "literal", find: "a", replace: "" },
  { kind: "literal", find: "ab", replace: "[R]" },
  { kind: "literal", find: "aa", replace: "Z" },
  { kind: "literal", find: "[R]", replace: "!!!!" },
  { kind: "literal", find: "x", replace: "xxx" },
  { kind: "regex", find: "a+", replace: "#" },
  { kind: "regex", find: "b|c", replace: "[BC]" },
  { kind: "regex", find: "\\d", replace: "" },
  { kind: "regex", find: "a*", replace: "-" },
  { kind: "regex", find: "(?<=a)", replace: "|" },
  { kind: "regex", find: "x", replace: "$&$&" },
  { kind: "regex", find: "\\[", replace: "<<" },
  { kind: "regex", find: "(", replace: "bad" },
  { kind: "literal", find: "", replace: "skipped" },
];

describe("applyReplacementsCounted parity with the scan-based implementation", () => {
  it("matches on randomized inputs and rule stacks", () => {
    const rand = rng(12345);
    for (let iter = 0; iter < 1500; iter++) {
      const len = Math.floor(rand() * 60);
      let text = "";
      for (let i = 0; i < len; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const ruleCount = 1 + Math.floor(rand() * 5);
      const rules = Array.from(
        { length: ruleCount },
        () => RULE_POOL[Math.floor(rand() * RULE_POOL.length)]!
      );
      expect(applyReplacementsCounted(text, rules), JSON.stringify({ text, rules })).toEqual(
        legacyApplyReplacementsCounted(text, rules)
      );
    }
  });
});
