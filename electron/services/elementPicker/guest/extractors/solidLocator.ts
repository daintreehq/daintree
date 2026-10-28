/// <reference lib="dom" />
/**
 * What solid-devtools' locator stamps on an element when the user turned it
 * on: `data-source-loc="<path>:<line>:<column>"`, the element's own JSX site as
 * Babel numbered it — 1-based line, 0-based column in UTF-16 units — with the
 * path relative to the dev server's root. It says where this element was
 * created, never where a component is defined, and nothing here checks it
 * against the file: it is the page's report, quoted with the attribute it came
 * from.
 */

import type { Capability } from "../../../../../shared/elementPicker/observation.js";
import type { ExtractorContribution } from "../types.js";

export const SOURCE_LOC_ATTRIBUTE = "data-source-loc";

/** Restated from `ReportedFileSchema` and `MAX_SOURCE_COORDINATE`: a value import would bundle zod into the page. */
const MAX_FILE = 2048;
const MAX_COORDINATE = 10_000_000;
/** The longest value a well-formed path and two coordinates can make; anything longer is not read. */
const MAX_VALUE = MAX_FILE + 2 * (String(MAX_COORDINATE).length + 1);
/** Split from the right, so a Windows drive or any other colon stays in the path. */
const LOCATION = /^(.+):(\d+):(\d+)$/;

export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}

export function parseSourceLoc(value: string): SourceLoc | null {
  if (value.length > MAX_VALUE) return null;
  const match = LOCATION.exec(value);
  if (match === null) return null;
  const [, file, lineText, columnText] = match;
  if (file === undefined || lineText === undefined || columnText === undefined) return null;
  if (file.length > MAX_FILE) return null;
  const line = Number(lineText);
  const column = Number(columnText);
  if (!(line >= 1 && line <= MAX_COORDINATE) || !(column <= MAX_COORDINATE)) return null;
  return { file, line, column };
}

const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };

/**
 * The element's own creation site, or nothing: an ancestor's site is another
 * element's, and a malformed value is no location at all rather than a guess
 * at one.
 */
export function solidContribution(element: Element): ExtractorContribution | null {
  const value = element.getAttribute(SOURCE_LOC_ATTRIBUTE);
  if (value === null) return null;
  const location = parseSourceLoc(value);
  if (location === null) return null;
  return {
    sourceCandidates: [
      {
        kind: "element-creation",
        candidateId: "solid-source-loc",
        framework: "solid",
        extraction: { kind: "attribute", attribute: SOURCE_LOC_ATTRIBUTE },
        file: location.file,
        location: {
          lineBase: 1,
          columnBase: 0,
          columnUnit: "utf16",
          line: location.line,
          column: location.column,
        },
      },
    ],
    // A creation site has a file and a line; no component is named, and the
    // locator reports a position, not a range.
    capabilities: {
      names: NOT_EXPOSED,
      chain: NOT_EXPOSED,
      componentSelection: NOT_EXPOSED,
      file: { state: "available" },
      line: { state: "available" },
      exactRange: NOT_EXPOSED,
    },
  };
}
