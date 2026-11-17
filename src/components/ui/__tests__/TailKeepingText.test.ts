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

  it("starts the tail at a separator in the final stretch", () => {
    const text = "feature/auth-token-refresh-retry";
    const split = tailStart(text);
    expect("/-_.").toContain(text[split]!);
    expect(text.length - split).toBeLessThanOrEqual(20);
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
    expect(isLowSurrogate(text, split)).toBe(false);
    expect(text.slice(0, split) + text.slice(split)).toBe(text);
  });
});
