/**
 * Reads the creation frames out of a React 19 `_debugStack`: the `Error` that
 * `jsxDEV`/`createElement` capture when an element is made. They are frames in
 * the module the dev server served, so they are reported exactly as V8 printed
 * them, in generated coordinates, for the host to map.
 *
 * Restated rather than imported: a value import from `shared/` would bundle
 * zod into the page.
 */

const TOP_FRAME = "Error: react-stack-top-frame\n";
const BOTTOM_FRAME = "react_stack_bottom_frame";
/** React captures at most ten frames; anything longer was not written by it. */
const MAX_STACK_CHARS = 16 * 1024;
const MAX_STACK_LINES = 32;
const MAX_FILE_CHARS = 2048;
const MAX_COORDINATE = 10_000_000;
const LOCATION = /^(.+):(\d+):(\d+)$/;

/**
 * One located frame. `index` is its position in the raw stack below the
 * message line, React's own factory frame being 0, so it names the same frame
 * however many around it had no location to report.
 */
export interface CreationFrame {
  index: number;
  file: string;
  line: number;
  column: number;
}

export interface CreationFrames {
  frames: CreationFrame[];
  /** Located frames past the limit, which a reader choosing between them did not get to see. */
  omitted: number;
}

/**
 * `.stack` formatted by V8 itself. A page that installed its own
 * `Error.prepareStackTrace` (source-map-support, an error reporter) would
 * otherwise decide the format, so it is set aside for the read and restored
 * before anything else can run — what React's own `formatOwnerStack` does with
 * these same errors. A page with no formatter is not touched at all.
 */
export function readRawStack(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const ctor = Error as unknown as { prepareStackTrace?: unknown };
  let previous: unknown;
  let swapped = false;
  try {
    previous = ctor.prepareStackTrace;
    if (previous !== undefined) {
      ctor.prepareStackTrace = undefined;
      swapped = true;
    }
  } catch {
    // A page that froze the hook still gets its stack read; it decided the format.
  }
  try {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === "string" ? stack : null;
  } catch {
    return null;
  } finally {
    if (swapped) {
      try {
        ctor.prepareStackTrace = previous;
      } catch {
        // Restoring cannot fail where setting it just succeeded.
      }
    }
  }
}

function parseLocation(text: string): { file: string; line: number; column: number } | null {
  const match = LOCATION.exec(text);
  if (match === null) return null;
  const file = match[1]!;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (file.length > MAX_FILE_CHARS) return null;
  if (line < 1 || column < 1 || line > MAX_COORDINATE || column > MAX_COORDINATE) return null;
  return { file, line, column };
}

const LOCATION_START = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

/**
 * `at name (location)` or `at location`. A function name and a file path can
 * both hold ` (`, so the location is the rightmost parenthesised tail that
 * starts like one — a URL, which is all a browser prints, or a path. A frame
 * with no such tail is skipped rather than misread.
 */
function parseFrame(line: string): { file: string; line: number; column: number } | null {
  const text = line.trim();
  if (!text.startsWith("at ")) return null;
  const body = text.slice(3);
  // Inside an eval: the position is in code no file holds.
  if (body.includes("eval at ")) return null;
  if (!body.endsWith(")")) return parseLocation(body);
  for (let open = body.lastIndexOf(" ("); open >= 0; open = body.lastIndexOf(" (", open - 1)) {
    const location = body.slice(open + 2, -1);
    if (LOCATION_START.test(location)) return parseLocation(location);
    if (open === 0) break;
  }
  return null;
}

/**
 * The frames between React's element factory and its render entry, top
 * first, in generated coordinates and unjudged: which one is the user's code
 * is the host's call to make once it can map them. The first is the call that
 * made the element — the JSX site — which says where it was created, not where
 * its component is defined. A stack deeper than React's capture limit has no
 * bottom marker; its frames are all above the render entry, so they are kept.
 */
export function creationFrames(error: unknown, limit: number): CreationFrames {
  const raw = readRawStack(error);
  if (raw === null || !raw.startsWith(TOP_FRAME)) return { frames: [], omitted: 0 };
  const lines = raw.slice(TOP_FRAME.length, MAX_STACK_CHARS).split("\n", MAX_STACK_LINES);
  const frames: CreationFrame[] = [];
  let omitted = 0;
  // Line 0 is React's own factory frame.
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes(BOTTOM_FRAME)) break;
    const location = parseFrame(line);
    if (location === null) continue;
    if (frames.length < limit) frames.push({ index, ...location });
    else omitted += 1;
  }
  return { frames, omitted };
}
