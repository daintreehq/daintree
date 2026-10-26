import { describe, expect, it } from "vitest";
import { mapTextRange, minimalDocChange, type TrackedTextRange } from "../textRangeMapping";

// "Fix the bug. " typed, then "hello world" dictated after it.
const DRAFT = "Fix the bug. hello world";
const DICTATED: TrackedTextRange = { from: 13, to: 24, edited: false };

function edit(draft: string, from: number, to: number, insert: string): string {
  return draft.slice(0, from) + insert + draft.slice(to);
}

function follow(range: TrackedTextRange, prev: string, next: string): TrackedTextRange {
  const change = minimalDocChange(prev, next);
  return change ? mapTextRange(range, change) : range;
}

function textOf(draft: string, range: TrackedTextRange): string {
  return draft.slice(range.from, range.to);
}

describe("mapTextRange", () => {
  it("shifts past text typed before the range", () => {
    const next = edit(DRAFT, 0, 0, "Please ");
    const range = follow(DICTATED, DRAFT, next);
    expect(textOf(next, range)).toBe("hello world");
    expect(range.edited).toBe(false);
  });

  it("stays put when text is typed after the range", () => {
    const next = DRAFT + " and more";
    const range = follow(DICTATED, DRAFT, next);
    expect(range).toEqual(DICTATED);
    expect(textOf(next, range)).toBe("hello world");
  });

  it("keeps text typed right at either boundary outside the range", () => {
    const atStart = edit(DRAFT, 13, 13, ">> ");
    expect(textOf(atStart, follow(DICTATED, DRAFT, atStart))).toBe("hello world");
    expect(follow(DICTATED, DRAFT, atStart).edited).toBe(false);

    const atEnd = DRAFT + "!";
    expect(textOf(atEnd, follow(DICTATED, DRAFT, atEnd))).toBe("hello world");
    expect(follow(DICTATED, DRAFT, atEnd).edited).toBe(false);
  });

  it("grows over text typed inside the range and reports the edit", () => {
    const next = edit(DRAFT, 18, 18, " there");
    const range = follow(DICTATED, DRAFT, next);
    expect(textOf(next, range)).toBe("hello there world");
    expect(range.edited).toBe(true);
  });

  it("trims to what survives a delete across the start boundary", () => {
    // Deletes "bug. hel".
    const next = edit(DRAFT, 8, 16, "");
    const range = follow(DICTATED, DRAFT, next);
    expect(next).toBe("Fix the lo world");
    expect(textOf(next, range)).toBe("lo world");
    expect(range.edited).toBe(true);
  });

  it("trims to what survives a delete across the end boundary", () => {
    const withTail = DRAFT + " tail";
    // Deletes "world t".
    const next = edit(withTail, 19, 26, "");
    const range = follow(DICTATED, withTail, next);
    expect(next).toBe("Fix the bug. hello ail");
    expect(textOf(next, range)).toBe("hello ");
    expect(range.edited).toBe(true);
  });

  it("keeps a replacement that straddles a boundary outside the range", () => {
    // Selects "bug. hello" and types "issue: hi".
    const next = edit(DRAFT, 8, 18, "issue: hi");
    const range = follow(DICTATED, DRAFT, next);
    expect(textOf(next, range)).toBe(" world");
    expect(range.edited).toBe(true);
  });

  it("collapses to an empty, edited range when its whole text is replaced", () => {
    const next = edit(DRAFT, 13, 24, "goodbye");
    const range = follow(DICTATED, DRAFT, next);
    expect(range.from).toBe(range.to);
    expect(range.edited).toBe(true);
    expect(next.slice(0, range.from)).toBe("Fix the bug. goodbye");
  });

  it("collapses when select-all pastes over the draft", () => {
    const next = "something else entirely";
    const range = follow(DICTATED, DRAFT, next);
    expect(range.from).toBe(range.to);
    expect(range.edited).toBe(true);
  });

  it("stays edited after later edits elsewhere", () => {
    const touched = edit(DRAFT, 18, 18, ",");
    const first = follow(DICTATED, DRAFT, touched);
    const next = edit(touched, 0, 0, "Now: ");
    const range = follow(first, touched, next);
    expect(textOf(next, range)).toBe("hello, world");
    expect(range.edited).toBe(true);
  });

  it("moves an empty range past text inserted at it without flagging it", () => {
    const anchor: TrackedTextRange = { from: 5, to: 5, edited: false };
    expect(mapTextRange(anchor, { from: 5, to: 5, insert: "abc" })).toEqual({
      from: 8,
      to: 8,
      edited: false,
    });
    expect(mapTextRange(anchor, { from: 2, to: 9, insert: "x" })).toEqual({
      from: 3,
      to: 3,
      edited: false,
    });
    expect(mapTextRange(anchor, { from: 6, to: 6, insert: "abc" })).toBe(anchor);
  });

  it("never reports an unedited range whose text changed", () => {
    // A single-span diff can't tell which of two identical characters was
    // typed. Whatever it guesses, an unflagged range must still hold its text.
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const alphabet = "aab ";
    const word = (length: number) =>
      Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");

    for (let i = 0; i < 2000; i++) {
      const draft = word(4 + random(12));
      const from = random(draft.length);
      const to = from + random(draft.length - from + 1);
      const range: TrackedTextRange = { from, to, edited: false };
      const cut = random(draft.length + 1);
      const next = edit(draft, cut, cut + random(draft.length - cut + 1), word(random(4)));

      const mapped = follow(range, draft, next);
      expect(mapped.from).toBeGreaterThanOrEqual(0);
      expect(mapped.to).toBeGreaterThanOrEqual(mapped.from);
      expect(mapped.to).toBeLessThanOrEqual(next.length);
      if (!mapped.edited) expect(textOf(next, mapped)).toBe(textOf(draft, range));
    }
  });
});
