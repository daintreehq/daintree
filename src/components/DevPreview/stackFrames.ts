import type { CdpStackFrame } from "@shared/types/ipc/webviewConsole";

// Dev servers stamp module URLs with cache-busting queries (Vite's `?t=` on
// HMR updates, `?v=` on pre-bundled deps, `?import` on asset imports). They
// change on every edit and say nothing about where the code lives.
const CACHE_BUST_PARAMS = new Set(["t", "v", "import", "direct"]);

// Frames from dependencies and dev-server runtime rather than the user's own
// source — what DevTools ignore-lists by default.
const LIBRARY_PATTERNS = [/\/node_modules\//, /\/@vite\//, /\/@react-refresh/, /\/@fs\//];

// V8 appends its own rendering of the stack to an exception's description:
// the message, then one `    at …` line per frame.
const V8_FRAME_LINE = /^\s+at\s/;

export function frameName(frame: CdpStackFrame): string {
  return frame.functionName || "(anonymous)";
}

export function isLibraryFrame(frame: CdpStackFrame): boolean {
  return LIBRARY_PATTERNS.some((pattern) => pattern.test(frame.url));
}

// Split by hand rather than through URLSearchParams, which would rewrite a
// bare flag like Vue's `?vue` as `vue=`.
function stripCacheBusting(search: string): string {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair && !CACHE_BUST_PARAMS.has(pair.split("=")[0]!));
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/**
 * The frame's source as a developer would name it: the path within the dev
 * server, without the origin every frame shares or the cache-busting query.
 * Empty for a frame with no source (native code, `eval`).
 */
export function framePath(frame: CdpStackFrame): string {
  const { url } = frame;
  if (!url) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    return `${path}${stripCacheBusting(parsed.search)}` || parsed.host;
  }
  if (parsed.protocol === "webpack-internal:") {
    return decodeURIComponent(url.slice("webpack-internal:".length)).replace(/^\/*\.?\//, "");
  }
  return url;
}

export function frameFileName(frame: CdpStackFrame): string {
  const path = framePath(frame);
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1) || path;
}

/** The complete, unshortened location — what a hover reveals. */
export function frameFullLocation(frame: CdpStackFrame): string {
  return frame.url ? `${frame.url}:${frame.lineNumber}:${frame.columnNumber}` : "";
}

/**
 * The frame that answers "where did this happen": the first one in the
 * user's own code, falling back to the call site when the whole stack is
 * library code.
 */
export function primaryFrame(frames: CdpStackFrame[]): CdpStackFrame | undefined {
  return frames.find((f) => f.url && !isLibraryFrame(f)) ?? frames.find((f) => f.url);
}

/**
 * An exception's summary with V8's trailing `    at …` lines removed, so a
 * row that also carries the structured frames doesn't print the stack twice.
 */
export function stripV8StackTail(summary: string): string {
  const lines = summary.split("\n");
  let end = lines.length;
  while (end > 1 && V8_FRAME_LINE.test(lines[end - 1]!)) end--;
  return end === lines.length ? summary : lines.slice(0, end).join("\n");
}

export type FrameSegment =
  | { kind: "frame"; frame: CdpStackFrame; index: number }
  | { kind: "library"; frames: { frame: CdpStackFrame; index: number }[]; start: number };

/**
 * Consecutive library frames fold into one collapsible run. A lone library
 * frame stays inline — a toggle to reveal one line saves nothing — and a
 * stack that is library code throughout is shown as is, since folding it
 * would hide everything.
 */
export function segmentFrames(frames: CdpStackFrame[]): FrameSegment[] {
  const indexed = frames.map((frame, index) => ({ frame, index }));
  if (indexed.every(({ frame }) => isLibraryFrame(frame))) {
    return indexed.map(({ frame, index }) => ({ kind: "frame", frame, index }));
  }
  const segments: FrameSegment[] = [];
  let run: { frame: CdpStackFrame; index: number }[] = [];
  const flush = () => {
    if (run.length === 1) segments.push({ kind: "frame", ...run[0]! });
    else if (run.length > 1) segments.push({ kind: "library", frames: run, start: run[0]!.index });
    run = [];
  };
  for (const entry of indexed) {
    if (isLibraryFrame(entry.frame)) {
      run.push(entry);
    } else {
      flush();
      segments.push({ kind: "frame", ...entry });
    }
  }
  flush();
  return segments;
}
