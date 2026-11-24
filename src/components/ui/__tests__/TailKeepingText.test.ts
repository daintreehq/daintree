import { describe, expect, it } from "vitest";
import { tailStart } from "../TailKeepingText";

const isLowSurrogate = (text: string, at: number) => {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff;
};

describe("tailStart", () => {
  it("leaves a short text whole", () => {
    expect(tailStart("feature/short")).toBe(0);
  });

  it("starts the tail at the first separator in the final stretch", () => {
    const text = "feature/auth-token-refresh-retry";
    expect(text.slice(tailStart(text))).toBe("-token-refresh-retry");
  });

  it("falls back to a fixed-length tail when no separator is in reach", () => {
    const text = "abcdefghijklmnopqrstuvwxyzabcdef";
    expect(tailStart(text)).toBe(text.length - 12);
  });

  it("never splits an emoji between its two code units", () => {
    // The fixed-length fallback lands between the surrogates of the emoji.
    const text = "abcdefghijklm\u{1F600}abcdefghijk";
    expect(isLowSurrogate(text, text.length - 12)).toBe(true);
    const split = tailStart(text);
    expect(text.slice(0, split)).toBe("abcdefghijklm\u{1F600}");
    expect(text.slice(split)).toBe("abcdefghijk");
  });

  it("moves past whitespace that follows the emoji it just kept whole", () => {
    const text = "abcdefghijklm\u{1F600} abcdefghij";
    expect(text.slice(tailStart(text))).toBe("bcdefghij");
  });

  it("keeps a trailing emoji whole, with the words before it, when no seam ahead is safe", () => {
    const text = "abcdefghijklmnop a b c d e \u{1F600}";
    expect(text.slice(tailStart(text))).toBe("p a b c d e \u{1F600}");
  });

  it("keeps a bounded tail, and no emoji split, when no seam in reach is safe", () => {
    const spaced = "AB" + " W".repeat(50);
    expect(spaced.length - tailStart(spaced)).toBeLessThanOrEqual(20);
    const emoji = "\u{1F600} ".repeat(8) + "Z";
    expect(tailStart(emoji)).toBe(emoji.length - 13);
  });
});
