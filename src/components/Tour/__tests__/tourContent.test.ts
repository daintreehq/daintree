import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOUR_CHAPTERS } from "../tourChapters";
import { narrationFingerprint, parseNarration } from "../tourNarration";
import { resolveChapterTiming } from "../tourTiming";
import { TOUR_TIMING_MANIFEST } from "../tourTiming.generated";
import type { TourTimingManifest } from "../tourTypes";

const SCENES_DIR = join(__dirname, "..", "scenes");
const SCENE_FILES: Record<string, string> = {
  welcome: "WelcomeScene.tsx",
  worktrees: "WorktreesScene.tsx",
  agents: "AgentsScene.tsx",
  state: "StateScene.tsx",
  fleet: "FleetScene.tsx",
  review: "ReviewScene.tsx",
};

/** Every cue id a scene reads, by the two shapes scenes use to name one. */
function cuesReadBy(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(/useCue\("([a-z0-9-]+)"/g)) ids.add(match[1]!);
  for (const match of source.matchAll(/cue(?:=|: )"([a-z0-9-]+)"/g)) ids.add(match[1]!);
  return ids;
}

describe("tour content", () => {
  it("gives every chapter a scene and every scene a chapter", () => {
    expect(new Set(TOUR_CHAPTERS.map((c) => c.id))).toEqual(new Set(Object.keys(SCENE_FILES)));
    expect(new Set(readdirSync(SCENES_DIR))).toEqual(new Set(Object.values(SCENE_FILES)));
  });

  // A narration edit that drops or renames a marker would leave the scene's
  // animation waiting on a cue that never fires — silently, since unknown
  // cues are inert by design.
  it.each(TOUR_CHAPTERS.map((c) => [c.id, c] as const))(
    "%s: the scene only reads cues its narration defines, and uses all of them",
    (id, chapter) => {
      const defined = new Set(Object.keys(parseNarration(chapter.narration).cueWordIndex));
      const read = cuesReadBy(readFileSync(join(SCENES_DIR, SCENE_FILES[id]!), "utf8"));
      expect(read).toEqual(defined);
    }
  );

  it("writes narration the voice can read without guessing", () => {
    for (const chapter of TOUR_CHAPTERS) {
      expect(parseNarration(chapter.narration).text).not.toMatch(/[⌘⌥⇧→←/]|\bcmd\b|\bctrl\b/i);
    }
  });

  it("ships generated timing that matches the current narration", () => {
    for (const chapter of TOUR_CHAPTERS) {
      const entry = TOUR_TIMING_MANIFEST.chapters[chapter.id];
      if (!entry) continue;
      expect(entry.narrationHash, `${chapter.id} is stale — run npm run tour:audio`).toBe(
        narrationFingerprint(parseNarration(chapter.narration))
      );
    }
  });
});

describe("resolveChapterTiming", () => {
  const chapter = TOUR_CHAPTERS[0]!;
  const fingerprint = narrationFingerprint(parseNarration(chapter.narration));
  const manifestWith = (narrationHash: string): TourTimingManifest => ({
    version: 1,
    voice: "test",
    chapters: {
      [chapter.id]: {
        duration: 99,
        cues: { first: 1, grid: 2 },
        captions: [],
        audioUrl: "https://cdn.daintree.org/tour/test.ogg",
        narrationHash,
      },
    },
  });

  it("uses generated timing and audio when it was made from this narration", () => {
    const timing = resolveChapterTiming(chapter, manifestWith(fingerprint));
    expect(timing.duration).toBe(99);
    expect(timing.audioUrl).toBe("https://cdn.daintree.org/tour/test.ogg");
  });

  it("falls back to an estimate, without audio, when the narration has changed", () => {
    const timing = resolveChapterTiming(chapter, manifestWith("00000000"));
    expect(timing.audioUrl).toBeNull();
    expect(Object.keys(timing.cues).sort()).toEqual(["first", "grid"]);
  });
});
