import { extractLocalhostUrls, stripAnsiAndOscCodes } from "../../shared/utils/urlUtils.js";
import { detectDevServerError, type DevServerError } from "../../shared/utils/devServerErrors.js";

export interface ScanResult {
  url: string | null;
  error: DevServerError | null;
  buffer: string;
  readyMarker: boolean;
  compileMarker: boolean;
}

// Startup readiness lines printed by common dev servers once the HTTP server is
// bound and serving. Matched against ANSI/OSC-stripped output so colour-wrapped
// glyphs (Next.js green ✓, Vite bold) still match.
const READY_MARKERS: RegExp[] = [
  // Vite 5–8 (also SvelteKit/Remix/Astro on Vite): "VITE v6.3.1  ready in 312 ms"
  /VITE\s+v\d+[^\n]*ready\s+in\s+\d+/i,
  // Next.js 14/15 (Turbopack + webpack): "✓ Ready in 1234ms"
  /[✓✔]\s+Ready\s+in/u,
  // Next.js legacy / Windows fallback where the glyph degrades
  /ready\s+-\s+started\s+server\s+on/i,
  // webpack-dev-server / CRA / webpack-dev-middleware
  /webpack\s+compiled\s+successfully/i,
  /\[webpack-dev-middleware\]\s+compiled\s+successfully/i,
];

// HMR / recompilation start patterns emitted during a running session. These
// signal the framework is actively rebuilding, distinct from startup readiness
// markers which signal the first bind.
const COMPILE_MARKERS: RegExp[] = [
  // webpack: "compiling..." (webpack-dev-server, CRA, Storybook)
  /compiling\.\.\./i,
  // Vite HMR: "[vite] hmr update /src/App.tsx"
  /\[vite\]\s+hmr\s+update/i,
  // Vite full reload: "[vite] page reload src/main.tsx"
  /\[vite\]\s+page\s+reload/i,
  // Next.js webpack mode: "Compiling /route" (word-anchored to avoid matching "Compiled")
  /\bcompiling\s+\//i,
];

// How much of the previous buffer is prepended before matching markers. PTY
// transport splits output at arbitrary byte offsets, so a marker line can
// straddle two chunks; every pattern above is far shorter than this window, so
// prepending it is enough to reunite any split marker with its own tail.
const MARKER_CARRY_MAX = 512;

function toGlobal(pattern: RegExp): RegExp {
  return pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

// Global clones so every occurrence in the window can be walked, not just the
// first — see matchesAcrossBoundary.
const READY_MARKERS_GLOBAL = READY_MARKERS.map(toGlobal);
const COMPILE_MARKERS_GLOBAL = COMPILE_MARKERS.map(toGlobal);

/**
 * Match `patterns` against the boundary between the carried tail of previous
 * output and the newly arrived chunk, accepting only matches that *end* inside
 * the new text.
 *
 * That end-position rule is what makes this fire exactly once: a marker wholly
 * contained in the carry has already been reported by the scan that received
 * it, and a marker completed by this chunk necessarily ends past the boundary.
 * Scanning the full 8192-char buffer instead would re-report every marker on
 * every subsequent chunk, which for the ready marker means restarting the
 * readiness poll on each keystroke of server output.
 *
 * Every occurrence has to be walked, not just the first: when the same marker
 * appears twice — an HMR update already in the carry and a fresh one in the new
 * chunk — the leading match ends inside the carry and would mask the one that
 * actually just landed.
 *
 * Not strictly exactly-once. A pattern ending in `\d+` re-matches when the next
 * chunk extends the digits ("ready in 8" then "7 ms"), and a straddling escape
 * shifts the boundary early enough to re-report a marker that sits wholly in the
 * carry. Both cost an extra `marker-recognized` row; a repeated ready marker is
 * otherwise inert (`markerSeen` gates acceleration, and clearing an already
 * clear compile phase is a no-op), while a repeated compile marker can re-arm
 * the Compiling label for its debounce window. Cheap enough to accept, and far
 * cheaper than missing the marker outright.
 */
function matchesAcrossBoundary(patterns: RegExp[], window: string, boundary: number): boolean {
  if (window.length <= boundary) return false;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(window)) !== null) {
      if (match.index + match[0].length > boundary) {
        pattern.lastIndex = 0;
        return true;
      }
      // These patterns cannot match empty, but a zero-width match would spin
      // the loop forever on `lastIndex` — advance defensively.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return false;
}

export class UrlDetector {
  scanOutput(data: string, buffer: string): ScanResult {
    const newBuffer =
      data.length < 8192
        ? buffer.slice(Math.max(0, buffer.length - 8192 + data.length)) + data
        : data.slice(-8192);

    let urls = extractLocalhostUrls(data);
    if (urls.length === 0) {
      const bufferUrls = extractLocalhostUrls(newBuffer);
      if (bufferUrls.length > 0) {
        urls = [bufferUrls[bufferUrls.length - 1]];
      }
    }

    const preferredUrl = urls.length > 0 ? this.selectPreferredUrl(urls) : null;
    const error = detectDevServerError(newBuffer);

    // Strip the joined window, not each half: an escape sequence can itself be
    // split by the transport ("\x1b[3" + "2m"), and stripping the halves apart
    // leaves that residue sitting inside the very marker we are trying to match.
    //
    // When nothing straddles, the two halves strip independently and their
    // lengths give the boundary exactly. When something does, the joined strip
    // is shorter, and deriving the boundary from the intact chunk side puts it
    // slightly early — which re-reports a marker rather than losing one. That is
    // the right direction to err, and it is now confined to actual straddles.
    const carry = buffer.slice(-MARKER_CARRY_MAX);
    const strippedWindow = stripAnsiAndOscCodes(carry + data);
    const strippedChunk = stripAnsiAndOscCodes(data);
    const strippedCarry = stripAnsiAndOscCodes(carry);
    const boundary =
      strippedCarry.length + strippedChunk.length === strippedWindow.length
        ? strippedCarry.length
        : Math.max(0, strippedWindow.length - strippedChunk.length);
    const readyMarker = matchesAcrossBoundary(READY_MARKERS_GLOBAL, strippedWindow, boundary);
    const compileMarker = matchesAcrossBoundary(COMPILE_MARKERS_GLOBAL, strippedWindow, boundary);

    return {
      url: preferredUrl,
      error,
      buffer: newBuffer,
      readyMarker,
      compileMarker,
    };
  }

  private selectPreferredUrl(urls: string[]): string | null {
    if (urls.length === 0) return null;
    if (urls.length === 1) return urls[0];

    const localPattern = /localhost/i;
    const localUrls = urls.filter((url) => localPattern.test(url));
    return localUrls.length > 0 ? localUrls[localUrls.length - 1] : urls[urls.length - 1];
  }
}
