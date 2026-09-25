import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { narrationFingerprint, parseNarration, type TourTimingManifest } from "@daintreehq/tour";
import { describe, expect, it } from "vitest";
import { TOUR_CHAPTERS } from "../tourChapters";
import {
  narrationVariant,
  narrationVariants,
  resolveKeyTokens,
  TOUR_KEYBOARDS,
  tourKeycaps,
  tourShortcutHint,
} from "../tourKeys";
import { TOUR_CHAPTER_TITLES, TOUR_MINUTES } from "../tourSummary.generated";
import { resolveChapterTiming, resolveTourTimings, tourMinutes } from "../tourTiming";
import { TOUR_TIMING_MANIFEST } from "../tourTiming.generated";

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
const TOUR_PACKAGE_SRC = join(REPO_ROOT, "packages", "tour", "src");
// The app resolves the tour engine to its source, as vite.config.ts does.
const PACKAGE_ENTRIES: Record<string, string> = {
  "@daintreehq/tour": join(TOUR_PACKAGE_SRC, "index.ts"),
  "@daintreehq/tour/react": join(TOUR_PACKAGE_SRC, "react.ts"),
};

function resolveSource(specifier: string, from: string): string | null {
  const entry = PACKAGE_ENTRIES[specifier];
  if (entry) return entry;
  const alias = Object.keys(ALIASES).find((prefix) => specifier.startsWith(prefix));
  const base = alias
    ? join(ALIASES[alias]!, specifier.slice(alias.length))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier.replace(/\.js$/, ""))
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

const HEAVY_MODULES = [
  "src/components/Tour/tourChapters.ts",
  "src/components/Tour/tourTiming.ts",
  "src/components/Tour/tourTiming.generated.ts",
  "packages/tour/src/tourNarration.ts",
  "packages/tour/src/tourTiming.ts",
];

function heavyModulesReachedFrom(file: string): string[] {
  return [...staticImportGraph(join(TOUR_DIR, file))]
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
    .filter((path) => HEAVY_MODULES.includes(path))
    .sort();
}

/** Every cue id a scene reads, by the two shapes scenes use to name one. */
function cuesReadBy(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(/useCue\("([a-z0-9-]+)"/g)) ids.add(match[1]!);
  for (const match of source.matchAll(/cue(?:=|: )"([a-z0-9-]+)"/g)) ids.add(match[1]!);
  return ids;
}

/** A modifier then a key, however it's written: "Command J", "Ctrl+Shift+P", "Command-P". "Shift-click" is prose. */
const SPELLED_OUT_SHORTCUT =
  /\b(?:cmd|ctrl|command|control|option|alt)-[a-z0-9]\b|\b(?:cmd|ctrl|command|control|option|alt|shift)(?:\s*\+\s*|\s+)(?:[a-z0-9]\b|enter\b|return\b|escape\b|esc\b|tab\b|shift\b|option\b|alt\b|control\b|ctrl\b)/i;

describe("spelled-out shortcut guard", () => {
  it.each([
    "press Command J",
    "Ctrl+Shift+P",
    "cmd+k",
    "press Shift Enter",
    "Option Return",
    "press Command-P",
  ])("catches %s", (text) => expect(text).toMatch(SPELLED_OUT_SHORTCUT));
  it.each(["Shift-click a panel's title bar", "press Enter to send it", "any control you like"])(
    "leaves %s alone",
    (text) => expect(text).not.toMatch(SPELLED_OUT_SHORTCUT)
  );
});

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
      const read = cuesReadBy(readFileSync(join(SCENES_DIR, SCENE_FILES[id]!), "utf8"));
      // One scene plays every keyboard's reading, so each must define the same cues.
      for (const variant of narrationVariants(chapter)) {
        const defined = new Set(Object.keys(parseNarration(variant.narration).cueWordIndex));
        expect(read, variant.key).toEqual(defined);
      }
    }
  );

  it("writes narration the voice can read without guessing", () => {
    for (const chapter of TOUR_CHAPTERS) {
      for (const variant of narrationVariants(chapter)) {
        expect(parseNarration(variant.narration).text, variant.key).not.toMatch(
          /[⌘⌥⇧→←/{}]|\bcmd\b|\bctrl\b/i
        );
      }
    }
  });

  // Prerecorded audio can't follow the viewer's platform, so any shortcut it
  // names has to be a token, voiced once per keyboard.
  it("never spells out a shortcut in the narration source", () => {
    for (const chapter of TOUR_CHAPTERS) {
      const untokenized = chapter.narration.replace(/\{\{[^{}]*\}\}/g, "");
      expect(untokenized, chapter.id).not.toMatch(SPELLED_OUT_SHORTCUT);
      expect(chapter.summary, chapter.id).not.toMatch(SPELLED_OUT_SHORTCUT);
    }
  });

  it("speaks each keyboard's own key names", () => {
    const pilot = TOUR_CHAPTERS.find((c) => c.id === "pilot")!;
    expect(narrationVariant(pilot, "mac").narration).toContain("press Command Option O");
    expect(narrationVariant(pilot, "pc").narration).toContain("press Control Alt O");
    const palette = TOUR_CHAPTERS.find((c) => c.id === "palette")!;
    expect(narrationVariant(palette, "mac").narration).toContain("press Command Shift P");
    expect(narrationVariant(palette, "pc").narration).toContain("press Control Shift P");
    // A chapter with no shortcut is voiced once and shared.
    const welcome = TOUR_CHAPTERS[0]!;
    expect(narrationVariants(welcome).map((v) => v.key)).toEqual(["welcome"]);
  });

  it("ships generated timing that matches the current narration", () => {
    const keys = TOUR_CHAPTERS.flatMap((chapter) => narrationVariants(chapter));
    for (const { key, narration } of keys) {
      const entry = TOUR_TIMING_MANIFEST.chapters[key];
      expect(entry, `${key} has no generated timing — run npm run tour:audio`).toBeDefined();
      if (!entry) continue;
      // Every cue the narration names was voiced, and lands inside the chapter.
      const parsed = parseNarration(narration);
      expect(Object.keys(entry.cues).sort()).toEqual(Object.keys(parsed.cueWordIndex).sort());
      for (const [cue, at] of Object.entries(entry.cues)) {
        expect(at >= 0 && at < entry.duration, `${key}.${cue} at ${at}s`).toBe(true);
      }
      expect(entry.narrationHash, `${key} is stale — run npm run tour:audio`).toBe(
        narrationFingerprint(parsed)
      );
      // Captions are the narration as voiced, word for word.
      expect(entry.captions.map((caption) => caption.text).join(" "), key).toBe(parsed.text);
      expect(entry.audioUrl, `${key} has no published audio`).toMatch(
        /^https:\/\/cdn\.daintree\.org\//
      );
    }
    // Nothing left over from a chapter or keyboard that no longer exists.
    expect(Object.keys(TOUR_TIMING_MANIFEST.chapters).sort()).toEqual(
      keys.map((v) => v.key).sort()
    );
  });
});

// The invitation renders at startup and reads only the registered summary, so
// the summary has to say what the player would.
describe("tour summary", () => {
  it("quotes the length the player's timings add up to", () => {
    expect(TOUR_MINUTES, "the tour summary is stale — run npm run tour:audio").toBe(
      Math.max(...TOUR_KEYBOARDS.map((keyboard) => tourMinutes(resolveTourTimings(keyboard))))
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
  it.each(["TourInviteCard.tsx", "TourHost.tsx", "tourRegistry.ts"])(
    "%s reaches no narration, timing or parser module statically",
    (file) => {
      expect(heavyModulesReachedFrom(file)).toEqual([]);
    }
  );

  it("sees the heavy modules from the lazily loaded Daintree definition", () => {
    expect(heavyModulesReachedFrom("daintreeTour.tsx")).toEqual([...HEAVY_MODULES].sort());
  });

  // The player plays whatever definition it is handed; no tour's content is built in.
  it("keeps the player free of any one tour's content", () => {
    const daintreeContent = heavyModulesReachedFrom("TourDialog.tsx").filter((path) =>
      path.startsWith("src/components/Tour/")
    );
    expect(daintreeContent).toEqual([]);
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
    const timing = resolveChapterTiming(chapter, "mac", manifestWith(fingerprint));
    expect(timing.duration).toBe(99);
    expect(timing.audioUrl).toBe("https://cdn.daintree.org/tour/test.ogg");
  });

  it("falls back to an estimate, without audio, when the narration has changed", () => {
    const timing = resolveChapterTiming(chapter, "mac", manifestWith("00000000"));
    expect(timing.audioUrl).toBeNull();
    expect(Object.keys(timing.cues).sort()).toEqual(
      Object.keys(parseNarration(chapter.narration).cueWordIndex).sort()
    );
  });
});

describe("resolveChapterTiming on each keyboard", () => {
  const pilot = TOUR_CHAPTERS.find((c) => c.id === "pilot")!;
  const manifest: TourTimingManifest = {
    version: 1,
    voice: "test",
    chapters: Object.fromEntries(
      TOUR_KEYBOARDS.map((keyboard) => {
        const variant = narrationVariant(pilot, keyboard);
        return [
          variant.key,
          {
            duration: 50,
            cues: {},
            captions: [],
            audioUrl: `https://cdn.daintree.org/tour/${variant.key}.ogg`,
            narrationHash: narrationFingerprint(parseNarration(variant.narration)),
          },
        ];
      })
    ),
  };

  it("plays the recording voiced for the viewer's keyboard", () => {
    expect(resolveChapterTiming(pilot, "mac", manifest).audioUrl).toContain("pilot.mac");
    expect(resolveChapterTiming(pilot, "pc", manifest).audioUrl).toContain("pilot.pc");
  });

  it("falls back silently, with that keyboard's captions, when its recording is missing", () => {
    const { ["pilot.pc"]: _missing, ...rest } = manifest.chapters;
    const timing = resolveChapterTiming(pilot, "pc", { ...manifest, chapters: rest });
    expect(timing.audioUrl).toBeNull();
    expect(timing.captions.map((c) => c.text).join(" ")).toContain("Control Alt O");
  });
});

describe("tour shortcut tokens", () => {
  it("rejects a token that is neither an action nor a key combo", () => {
    expect(() => resolveKeyTokens("press {{Pilot.toggle}}", "mac")).toThrow(/neither/);
    expect(() => resolveKeyTokens("press {{pilot.toggel}}", "pc")).toThrow(/neither/);
  });

  it("speaks a literal combo and a chord in each keyboard's words", () => {
    expect(resolveKeyTokens("{{Alt+Enter}}", "mac")).toBe("Option Return");
    expect(resolveKeyTokens("{{Alt+Enter}}", "pc")).toBe("Alt Enter");
    expect(resolveKeyTokens("{{ worktree.createDialog.open }}", "pc")).toBe(
      "Control K, then Control N"
    );
  });

  it("draws keycaps for one step only, and a chord as a hint", () => {
    expect(() => tourKeycaps("worktree.createDialog.open", "mac")).toThrow(/single-step/);
    expect(tourShortcutHint("worktree.createDialog.open", "mac")).toBe("⌘K ⌘N");
    expect(tourShortcutHint("worktree.createDialog.open", "pc")).toBe("Ctrl+K Ctrl+N");
  });
});
