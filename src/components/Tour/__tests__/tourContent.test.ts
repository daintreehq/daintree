import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOUR_CHAPTERS } from "../tourChapters";
import { narrationFingerprint, parseNarration } from "../tourNarration";
import { TOUR_CHAPTER_TITLES, TOUR_MINUTES } from "../tourSummary.generated";
import { resolveChapterTiming, resolveTourTimings, tourMinutes } from "../tourTiming";
import { TOUR_TIMING_MANIFEST } from "../tourTiming.generated";
import type { TourTimingManifest } from "../tourTypes";

const TOUR_DIR = join(__dirname, "..");
const SCENES_DIR = join(TOUR_DIR, "scenes");
const SCENE_FILES: Record<string, string> = {
  welcome: "WelcomeScene.tsx",
  worktrees: "WorktreesScene.tsx",
  agents: "AgentsScene.tsx",
  state: "StateScene.tsx",
  fleet: "FleetScene.tsx",
  files: "FilesScene.tsx",
  context: "ContextScene.tsx",
  preview: "PreviewScene.tsx",
  github: "GitHubScene.tsx",
  review: "ReviewScene.tsx",
  pilot: "PilotScene.tsx",
  assistant: "AssistantScene.tsx",
  palette: "PaletteScene.tsx",
  outro: "OutroScene.tsx",
};

const REPO_ROOT = join(TOUR_DIR, "..", "..", "..");
const ALIASES: Record<string, string> = {
  "@/": join(REPO_ROOT, "src"),
  "@shared/": join(REPO_ROOT, "shared"),
};

function resolveSource(specifier: string, from: string): string | null {
  const alias = Object.keys(ALIASES).find((prefix) => specifier.startsWith(prefix));
  const base = alias
    ? join(ALIASES[alias]!, specifier.slice(alias.length))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (!base) return null;
  const candidates = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext);
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/** Every source file a module reaches through runtime static imports; `import()` is not an edge. */
function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?"([^"]+)"/gm
    )) {
      const resolved = resolveSource(match[1]!, file);
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
}

function heavyModulesReachedFrom(file: string): string[] {
  return [...staticImportGraph(join(TOUR_DIR, file))].filter((path) =>
    /\/Tour\/(tourChapters|tourTiming|tourTiming\.generated|tourNarration)\.ts$/.test(path)
  );
}

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
    const sceneFiles = readdirSync(SCENES_DIR).filter((name) => name.endsWith("Scene.tsx"));
    expect(new Set(sceneFiles)).toEqual(new Set(Object.values(SCENE_FILES)));
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
      expect(entry, `${chapter.id} has no generated timing — run npm run tour:audio`).toBeDefined();
      if (!entry) continue;
      // Every cue the narration names was voiced, and lands inside the chapter.
      expect(Object.keys(entry.cues).sort()).toEqual(
        Object.keys(parseNarration(chapter.narration).cueWordIndex).sort()
      );
      for (const [cue, at] of Object.entries(entry.cues)) {
        expect(at >= 0 && at < entry.duration, `${chapter.id}.${cue} at ${at}s`).toBe(true);
      }
      expect(entry.narrationHash, `${chapter.id} is stale — run npm run tour:audio`).toBe(
        narrationFingerprint(parseNarration(chapter.narration))
      );
    }
  });
});

// The invitation renders at startup and reads only the summary, so the summary
// has to say what the player would.
describe("tour summary", () => {
  it("quotes the length the player's timings add up to", () => {
    expect(TOUR_MINUTES, "the tour summary is stale — run npm run tour:audio").toBe(
      tourMinutes(resolveTourTimings())
    );
  });

  it("lists the chapter titles in play order", () => {
    expect(
      TOUR_CHAPTER_TITLES,
      "the tour summary is stale — run npm run tour:audio -- --no-upload for a title-only change"
    ).toEqual(TOUR_CHAPTERS.map((chapter) => chapter.title));
  });

  // One static import of these anywhere below a startup module pulls the
  // narration, the cue manifest and the parser back into the first-render graph.
  it.each(["TourInviteCard.tsx", "DaintreeTourHost.tsx"])(
    "%s reaches no narration, timing or parser module statically",
    (file) => {
      expect(heavyModulesReachedFrom(file)).toEqual([]);
    }
  );

  it("sees the heavy modules from the lazily loaded player", () => {
    expect(heavyModulesReachedFrom("TourDialog.tsx")).toHaveLength(4);
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
    expect(Object.keys(timing.cues).sort()).toEqual(
      Object.keys(parseNarration(chapter.narration).cueWordIndex).sort()
    );
  });
});
