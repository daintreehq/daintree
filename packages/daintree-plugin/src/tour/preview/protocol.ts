// Shared by the preview server (Node) and the harness (browser), so it imports
// nothing from either side.
import type { CanvasRect } from "../../../../tour/src/kit/tourAnchors.js";
import type { TourChapterTiming } from "../../../../tour/src/tourTypes.js";

export type { CanvasRect };

/**
 * Where a chapter's timing came from. `stale` is the manifest's timing made
 * from different narration, previewed as-is so the author sees what ships;
 * `estimate` stands in for a chapter that has never been voiced.
 */
export type PreviewTimingSource = "manifest" | "stale" | "estimate";

export interface PreviewChapter {
  id: string;
  /** Cue ids the narration marks, in narration order. */
  narrationCues: string[];
  /** `audioUrl` is already a URL the page can load. */
  timing: TourChapterTiming;
  timingSource: PreviewTimingSource;
}

export interface TourPreviewConfig {
  version: 1;
  tourId: string;
  title: string;
  /** URL of the plugin's built `componentPath` module. */
  componentUrl: string;
  chapters: PreviewChapter[];
  /** Warnings found before the page loaded (stale or missing timing). */
  warnings: string[];
}

/** Element id of the `application/json` script the config is embedded in. */
export const CONFIG_ELEMENT_ID = "tour-preview-config";
/** Where the harness posts what it observed, so the terminal can warn too. */
export const REPORT_PATH = "/_preview/report";

/** What the page has observed in one chapter so far. */
export interface PreviewChapterReport {
  chapterId: string;
  /** Cues a scene waited on that the narration never marks, so they never fire. */
  undefinedCues: string[];
  /** The scene threw while rendering. */
  error?: string;
}

export interface PreviewSnapshot {
  chapterId: string;
  time: number;
  canvas: { width: number; height: number };
  /** Every rendered `data-tour-anchor`, in canvas space. */
  anchors: Record<string, CanvasRect>;
  report: PreviewChapterReport;
}

/** `window.__tourPreview`, driven by headless capture and available to specs. */
export interface TourPreviewHandle {
  ready: boolean;
  /** Set instead of `ready` when the tour module can't be played at all. */
  error: string | null;
  chapters: string[];
  /** Open a chapter paused at 0 and resolve once it has rendered. */
  goTo(chapterId: string): Promise<void>;
  /** Move the paused timeline and resolve once the scene has rendered it. */
  seek(seconds: number): Promise<void>;
  snapshot(): PreviewSnapshot;
}

export const PREVIEW_HANDLE = "__tourPreview";

/** Stage width in capture mode: the 640×360 canvas at exactly 2×. */
export const CAPTURE_WIDTH = 1280;

/**
 * Wrap a chapter's cue table so every lookup is recorded. All three cue hooks
 * (`useCue`, `useSecondsSinceCue`, `useTimelineIndex`), and the kit parts built
 * on them, read `player.timing.cues[id]`, so observing the table catches every
 * cue a rendered scene waits on without replacing any of the tour's modules.
 */
export function recordCueReads(
  cues: Record<string, number>,
  onRead: (cue: string) => void
): Record<string, number> {
  return new Proxy(cues, {
    get(target, key, receiver) {
      if (typeof key === "string") onRead(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

/**
 * The player as one chapter's scene sees it: everything live, except that
 * `timing` stays that chapter's. When the player moves on, the outgoing scene
 * re-reads its cues once more before it unmounts; through its own view those
 * reads land on its own cue table, not the next chapter's.
 */
export function pinTiming<P extends { timing: unknown }>(player: P, timing: P["timing"]): P {
  return new Proxy(player, {
    get(target, key, receiver) {
      return key === "timing" ? timing : (Reflect.get(target, key, receiver) as unknown);
    },
  });
}

/** Referenced cues the narration doesn't mark, sorted. */
export function undefinedCues(referenced: Iterable<string>, narrationCues: string[]): string[] {
  const known = new Set(narrationCues);
  return [...new Set(referenced)].filter((cue) => !known.has(cue)).sort();
}

function isComponent(value: unknown): boolean {
  if (typeof value === "function") return true;
  // memo, forwardRef and lazy wrappers are objects tagged with `$$typeof`.
  return typeof value === "object" && value !== null && "$$typeof" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tour module's contract, the same one Daintree loads it by: a default
 * export of `{ scenes, chapterTitles?, mockKit? }`, where `scenes` maps each
 * chapter id to the component that draws it. Returns what's wrong, or null
 * when every chapter has a scene.
 */
export function sceneMapProblem(module: unknown, chapterIds: string[]): string | null {
  const exported = isRecord(module) ? module.default : undefined;
  if (!isRecord(exported)) {
    return "The tour module must default-export { scenes, chapterTitles?, mockKit? }, e.g. export default { scenes: { intro: IntroScene } }";
  }
  const scenes = exported.scenes;
  if (!isRecord(scenes)) {
    return "The tour module's default export has no scenes object; export default { scenes: { intro: IntroScene } }";
  }
  const missing = chapterIds.filter((id) => !Object.hasOwn(scenes, id));
  if (missing.length > 0) {
    return `The tour module's scenes have no scene for ${missing.map((id) => `"${id}"`).join(", ")}`;
  }
  const invalid = chapterIds.filter((id) => !isComponent(scenes[id]));
  if (invalid.length > 0) {
    return `The scene for ${invalid.map((id) => `"${id}"`).join(", ")} is not a React component`;
  }
  return null;
}

/** A chapter's cues in firing order; ties break by id so captures are stable. */
export function cuesInOrder(cues: Record<string, number>): Array<{ cue: string; time: number }> {
  return Object.entries(cues)
    .map(([cue, time]) => ({ cue, time }))
    .sort((a, b) => a.time - b.time || a.cue.localeCompare(b.cue));
}
