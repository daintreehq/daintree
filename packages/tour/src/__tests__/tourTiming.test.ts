import { describe, expect, it } from "vitest";
import { narrationFingerprint, parseNarration } from "../tourNarration.js";
import { resolveChapterTiming, resolveTourTimings, tourMinutes } from "../tourTiming.js";
import type { TourChapter, TourChapterTiming, TourTimingManifest } from "../tourTypes.js";

const chapter: TourChapter = {
  id: "intro",
  title: "Intro",
  summary: "Say hello.",
  narration: "Hello [[wave]]there, and [[bye]]goodbye.",
};

const manifestWith = (narrationHash: string): TourTimingManifest => ({
  version: 1,
  voice: "test",
  chapters: {
    intro: {
      duration: 42,
      cues: { wave: 1, bye: 2 },
      captions: [{ start: 0, end: 42, text: "Hello there, and goodbye." }],
      audioUrl: "https://example.com/intro.ogg",
      narrationHash,
    },
  },
});

const fingerprint = narrationFingerprint(parseNarration(chapter.narration));

describe("resolveChapterTiming", () => {
  it("estimates timing, without audio, when there is no manifest", () => {
    const timing = resolveChapterTiming(chapter);
    expect(timing.audioUrl).toBeNull();
    expect(Object.keys(timing.cues).sort()).toEqual(["bye", "wave"]);
  });

  it("uses a manifest entry made from this exact narration, minus its hash", () => {
    expect(resolveChapterTiming(chapter, manifestWith(fingerprint))).toEqual({
      duration: 42,
      cues: { wave: 1, bye: 2 },
      captions: [{ start: 0, end: 42, text: "Hello there, and goodbye." }],
      audioUrl: "https://example.com/intro.ogg",
    });
  });

  it("ignores a stale entry", () => {
    expect(resolveChapterTiming(chapter, manifestWith("00000000")).audioUrl).toBeNull();
  });

  it("estimates a chapter the manifest does not know", () => {
    const other = { ...chapter, id: "other" };
    expect(resolveChapterTiming(other, manifestWith(fingerprint)).audioUrl).toBeNull();
  });
});

describe("resolveTourTimings", () => {
  it("resolves every chapter in order", () => {
    const other = { ...chapter, id: "other" };
    const timings = resolveTourTimings([chapter, other], manifestWith(fingerprint));
    expect(timings.map((timing) => timing.audioUrl)).toEqual([
      "https://example.com/intro.ogg",
      null,
    ]);
  });
});

describe("tourMinutes", () => {
  const lasting = (duration: number): TourChapterTiming => ({
    duration,
    cues: {},
    captions: [],
    audioUrl: null,
  });

  it("rounds the total to whole minutes", () => {
    expect(tourMinutes([lasting(100), lasting(80)])).toBe(3);
  });

  it("never quotes less than a minute", () => {
    expect(tourMinutes([])).toBe(1);
    expect(tourMinutes([lasting(5)])).toBe(1);
  });
});
