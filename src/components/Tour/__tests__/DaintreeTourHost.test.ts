import { describe, expect, it } from "vitest";
import { resolveOpenState } from "../DaintreeTourHost";
import { TOUR_CHAPTERS } from "../tourChapters";

const base = { completed: false, dismissed: false, lastChapter: 0 };

describe("resolveOpenState", () => {
  it("resumes an unfinished tour where it was left", () => {
    expect(resolveOpenState({ ...base, lastChapter: 2 }, false).initialChapter).toBe(2);
  });

  it("starts a finished tour over", () => {
    expect(
      resolveOpenState({ ...base, completed: true, lastChapter: 4 }, false).initialChapter
    ).toBe(0);
  });

  it("ignores a chapter index the current tour no longer has", () => {
    expect(
      resolveOpenState({ ...base, lastChapter: TOUR_CHAPTERS.length }, false).initialChapter
    ).toBe(0);
  });

  it("carries the global mute preference", () => {
    expect(resolveOpenState(base, true).initialMuted).toBe(true);
    expect(resolveOpenState(base, false).initialMuted).toBe(false);
  });
});
