import { describe, expect, it } from "vitest";
import { resolveOpenState } from "../TourHost";

const base = { completed: false, dismissed: false, lastChapter: 0 };
const CHAPTERS = 14;

describe("resolveOpenState", () => {
  it("resumes an unfinished tour where it was left", () => {
    expect(resolveOpenState({ ...base, lastChapter: 2 }, false, CHAPTERS).initialChapter).toBe(2);
  });

  it("starts a finished tour over", () => {
    expect(
      resolveOpenState({ ...base, completed: true, lastChapter: 4 }, false, CHAPTERS).initialChapter
    ).toBe(0);
  });

  it("ignores a chapter index the tour no longer has", () => {
    expect(
      resolveOpenState({ ...base, lastChapter: CHAPTERS }, false, CHAPTERS).initialChapter
    ).toBe(0);
  });

  it("carries the global mute preference", () => {
    expect(resolveOpenState(base, true, CHAPTERS).initialMuted).toBe(true);
    expect(resolveOpenState(base, false, CHAPTERS).initialMuted).toBe(false);
  });
});
