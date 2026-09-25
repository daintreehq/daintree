/**
 * Reserved first path segment carrying a plugin view's load generation, e.g.
 * `plugin://acme.tools/__dtv-7/dist/view.js` (#11301).
 *
 * It exists purely to give V8's module map a specifier it has never seen after
 * a plugin is replaced — Chromium has no way to evict a cached ESM module
 * record, so an unchanged URL keeps serving the previous version until a full
 * renderer reload. The segment is virtual: it never corresponds to a directory
 * on disk and is stripped before the file is resolved.
 *
 * `__dtv-` is reserved. A plugin shipping a real top-level directory with this
 * name would have it shadowed, which is why the prefix is deliberately ugly.
 */
export const PLUGIN_VIEW_GENERATION_PREFIX = "__dtv-";

/** Whole-segment match: the prefix followed by one or more digits, nothing else. */
const GENERATION_SEGMENT_RE = /^__dtv-(\d+)$/;

export interface StrippedPluginViewPath {
  /** Path with the generation segment removed; unchanged when there was none. */
  path: string;
  /** The parsed generation, or `null` for a plain (ungenerated) asset path. */
  generation: number | null;
}

/**
 * Remove a leading view-generation segment from a `plugin://` pathname.
 *
 * Returns `null` for a path whose first segment *looks* reserved but isn't a
 * valid generation (`__dtv-`, `__dtv-x`, `__dtv-1.2`). Callers must treat that
 * as a 404 rather than falling through to a disk lookup: passing it through
 * would let a crafted URL address a real `__dtv-…` directory, and silently
 * accepting it would hide a genuine URL-construction bug.
 *
 * `pathValue` is expected without a leading slash, matching the decoded
 * pathname the protocol handler works with.
 */
export function stripPluginViewGeneration(pathValue: string): StrippedPluginViewPath | null {
  if (!pathValue.startsWith(PLUGIN_VIEW_GENERATION_PREFIX)) {
    return { path: pathValue, generation: null };
  }
  const slash = pathValue.indexOf("/");
  // A bare `__dtv-7` with no remainder addresses no asset — the generation is a
  // namespace, never a file.
  if (slash === -1) return null;
  const match = GENERATION_SEGMENT_RE.exec(pathValue.slice(0, slash));
  if (!match) return null;
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation)) return null;
  const rest = pathValue.slice(slash + 1);
  if (rest.length === 0) return null;
  return { path: rest, generation };
}

/**
 * Reserved first segment (after any view generation) of the host's route to a
 * tour chapter's remote narration: `__dta/<tourId>/<chapterId>`. The renderer's
 * `media-src` cannot list every host a plugin declares, so remote audio plays
 * through `plugin://` and main fetches it from the URL its own registry holds —
 * the request names a chapter, never a destination. Reserved like `__dtv-`.
 */
export const PLUGIN_TOUR_AUDIO_SEGMENT = "__dta";

/** Plugin-relative path of a chapter's remote-audio route. */
export function pluginTourAudioPath(tourId: string, chapterId: string): string {
  return `${PLUGIN_TOUR_AUDIO_SEGMENT}/${encodeURIComponent(tourId)}/${encodeURIComponent(chapterId)}`;
}

/**
 * Parse a generation-stripped, decoded path as a remote-audio route. `null`
 * when the path is not under the reserved segment; `"invalid"` when it is but
 * does not name exactly one tour and one chapter.
 */
export function parsePluginTourAudioPath(
  pathValue: string
): { tourId: string; chapterId: string } | "invalid" | null {
  const segments = pathValue.split("/");
  if (segments[0] !== PLUGIN_TOUR_AUDIO_SEGMENT) return null;
  if (segments.length !== 3 || !segments[1] || !segments[2]) return "invalid";
  return { tourId: segments[1], chapterId: segments[2] };
}
