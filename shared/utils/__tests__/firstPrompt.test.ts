import { describe, expect, it } from "vitest";
import { buildFirstPrompt, FIRST_PROMPT_MAX_CHARS, sanitizeFirstPrompt } from "../firstPrompt.js";

describe("buildFirstPrompt", () => {
  it("records the text exactly as written, line breaks and edges included", () => {
    const text = "  Fix the login bug.\n\nThen run the tests.\n";
    expect(buildFirstPrompt(text, "launch", 5)).toEqual({ text, via: "launch", at: 5 });
  });

  it("records nothing for a launch with no prompt", () => {
    expect(buildFirstPrompt(undefined, "launch", 5)).toBeUndefined();
    expect(buildFirstPrompt("", "launch", 5)).toBeUndefined();
    expect(buildFirstPrompt(" \n\t ", "send", 5)).toBeUndefined();
  });

  it("keeps a prompt at the cap whole and flags one past it", () => {
    const atCap = `HEAD${"a".repeat(FIRST_PROMPT_MAX_CHARS - 4)}`;
    expect(buildFirstPrompt(atCap, "launch", 1)).toEqual({ text: atCap, via: "launch", at: 1 });

    expect(buildFirstPrompt(`${atCap}TAIL`, "launch", 1)).toEqual({
      text: atCap,
      via: "launch",
      at: 1,
      truncated: true,
    });
  });

  it("records nothing when all it would keep is blank", () => {
    const text = `${" ".repeat(FIRST_PROMPT_MAX_CHARS)}Fix this`;
    expect(buildFirstPrompt(text, "launch", 1)).toBeUndefined();
  });

  it("builds only records that restore accepts back unchanged", () => {
    for (const length of [1, FIRST_PROMPT_MAX_CHARS - 1, FIRST_PROMPT_MAX_CHARS, 9_000]) {
      const record = buildFirstPrompt(`x${" y".repeat(length)}`, "launch", 3);
      expect(sanitizeFirstPrompt(record)).toEqual(record);
    }
  });

  it("never cuts between the halves of a surrogate pair", () => {
    const text = `${"a".repeat(FIRST_PROMPT_MAX_CHARS - 1)}😀tail`;
    const record = buildFirstPrompt(text, "launch", 1);
    expect(record?.text).toBe("a".repeat(FIRST_PROMPT_MAX_CHARS - 1));
    expect(record?.truncated).toBe(true);
  });
});

describe("sanitizeFirstPrompt", () => {
  it("passes a well-formed record through", () => {
    const record = { text: "Ship it", via: "send", at: 10, truncated: true };
    expect(sanitizeFirstPrompt(record)).toEqual(record);
  });

  it("drops unknown keys and a non-true truncation flag", () => {
    expect(
      sanitizeFirstPrompt({ text: "Ship it", via: "launch", at: 10, truncated: "yes", extra: 1 })
    ).toEqual({ text: "Ship it", via: "launch", at: 10 });
  });

  it.each([
    ["a non-object", "Ship it"],
    ["null", null],
    ["a non-string text", { text: 4, via: "launch", at: 1 }],
    ["a blank text", { text: "   ", via: "launch", at: 1 }],
    ["an unknown label", { text: "Ship it", via: "recipe", at: 1 }],
    ["a missing time", { text: "Ship it", via: "launch" }],
    ["a non-finite time", { text: "Ship it", via: "launch", at: Number.NaN }],
  ])("falls back to no record for %s", (_label, value) => {
    expect(sanitizeFirstPrompt(value)).toBeUndefined();
  });

  it("caps an oversized record at its start and flags it", () => {
    const kept = `HEAD${"x".repeat(FIRST_PROMPT_MAX_CHARS - 4)}`;
    const record = sanitizeFirstPrompt({ text: `${kept}TAIL`, via: "launch", at: 1 });
    expect(record).toEqual({ text: kept, via: "launch", at: 1, truncated: true });
  });
});
