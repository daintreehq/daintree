import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { systemClient } from "@/clients";
import { basename, resolveWorktreePathScope } from "@shared/utils/path";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { isClientAppError } from "@/utils/clientAppError";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  DIR_PATH_REGEX,
  FILE_PATH_REGEX,
  FILE_URL_REGEX,
  isPathExcluded,
  resolveDirPathCandidate,
  resolveFilePathCandidate,
  resolveFileUrlCandidate,
} from "./filePathDetection";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import type { TerminalLink } from "./types";

// Coalesce key for file-link activation failures. A user who scrolls a stack
// trace and clicks 10 bad links shouldn't see 10 toasts; collapse the burst
// into a single updating toast over a short window. Class-level (not
// per-path) so 20 bad links across 20 paths still surface as one toast.
export const FILE_LINK_ACTIVATION_COALESCE_KEY = "filelink-activate-fail";

/**
 * Surface a file-link activation failure to the user as a single sticky,
 * coalesced error toast. The toast auto-promotes to `duration: 0` (sticky)
 * because its action button needs to stay clickable — the toaster's 3s
 * fallback would dismiss it before the user can act.
 *
 * The basename (not the full path) goes in the body so toast width stays
 * readable and so we don't echo long absolute paths into the persistent
 * inbox. The full path is only exposed on explicit user action.
 *
 * The recovery action branches on the failure code: an OUTSIDE_ROOT failure
 * offers "Reveal in File Manager" (the file is real, just outside the
 * project — the user cmd-clicked it with intent, so revealing it in the OS
 * file manager is the discoverable inverse), while every other failure keeps
 * "Copy path". Reveal runs through the unconfined IPC op, which skips roots
 * containment but keeps the executable deny-list.
 *
 * Coalesce caveat: when multiple failures fire inside the 1500ms window,
 * the `buildMessage`/`buildTitle` callbacks only know the *current* call's
 * body, so a coalesced toast can't honestly mix per-failure reasons. The
 * coalesced branch deliberately drops the per-failure body and shows a
 * generic "see inbox for details" message — every coalesced failure still
 * lands as its own inbox row carrying the real reason. notify() overwrites
 * the singular `action` with the latest call's on each coalesce tick, so the
 * key is split by affordance — otherwise a mixed OUTSIDE_ROOT / INVALID_PATH
 * burst would flip a coalesced toast's button between Reveal and Copy path.
 */
export function reportFileLinkFailure(
  reason: string,
  error: unknown,
  absolutePath: string,
  /** What the link pointed at — folder links must not fail as "file". */
  subject: "file" | "folder" = "file"
): void {
  const code = isClientAppError(error) ? error.code : undefined;
  const userMessage = isClientAppError(error) ? error.userMessage : undefined;

  let body: string;
  switch (code) {
    case "OUTSIDE_ROOT":
      body = "Path is outside your project roots";
      break;
    case "INVALID_PATH":
      body = `Path is not a valid ${subject}`;
      break;
    default:
      body = userMessage ?? formatErrorMessage(error, `Couldn't open this ${subject}`);
  }

  const name = basename(absolutePath) || absolutePath || "file";
  const singleMessage = `${body} (${name})`;
  const isOutsideRoot = code === "OUTSIDE_ROOT";
  const coalesceKey = isOutsideRoot
    ? `${FILE_LINK_ACTIVATION_COALESCE_KEY}:outside-root`
    : FILE_LINK_ACTIVATION_COALESCE_KEY;
  const copyPathAction = {
    label: "Copy path",
    onClick: () => {
      if (!navigator.clipboard) return;
      void navigator.clipboard.writeText(absolutePath).catch(() => {
        /* clipboard unavailable — sticky toast is the durable surface */
      });
    },
  };
  const action = isOutsideRoot
    ? {
        label: "Reveal in File Manager",
        onClick: () => {
          void systemClient.showItemInFolderUnconfined(absolutePath).catch((revealError) => {
            logError("[FileLinksAddon] Failed to reveal out-of-root file link", revealError, {
              absolutePath,
            });
            // The reveal was user-initiated, so a silent no-op is the wrong
            // UX — the file may have been moved/deleted/blocked since the link
            // was rendered. Surface the failure with Copy path as the recovery.
            notify({
              type: "error",
              title: "Couldn't reveal file",
              message: `${name} couldn't be revealed in your file manager`,
              context: { eventKind: "uiFeedback" },
              action: copyPathAction,
            });
          });
        },
      }
    : copyPathAction;

  notify({
    type: "error",
    title: `Couldn't open ${subject} link`,
    message: singleMessage,
    priority: "high",
    context: { eventKind: "uiFeedback" },
    coalesce: {
      key: coalesceKey,
      windowMs: 1500,
      // The coalesced form says "links" without a noun: the batch can mix
      // file and folder failures, and the shared key must not lie about it.
      buildTitle: (count) =>
        count <= 1 ? `Couldn't open ${subject} link` : `Couldn't open ${count} links`,
      // Per-failure bodies don't compose on coalesce: each call only sees one
      // error, so the first failure's reason would otherwise leak across the
      // whole batch. Drop the body in the batch case; the per-failure inbox
      // row carries the real reason.
      buildMessage: (count) =>
        count <= 1 ? singleMessage : `Couldn't open ${count} file links — see inbox for details`,
    },
    action,
  });

  logError(`[FileLinksAddon] ${reason}`, error, { absolutePath });
}

export type HoverCallback = (link: TerminalLink | null) => void;

interface DirCandidate {
  text: string;
  startIndex: number;
  absolutePath: string;
}

interface ScopedDirCandidate extends DirCandidate {
  worktreeId: string;
  relativePath: string;
}

/** A wrapped run of buffer rows, rejoined into the line the user sees. */
interface LogicalLine {
  text: string;
  /** 0-based buffer index of the first row in the window. */
  startRow: number;
  /** Where each row's text begins in `text`, indexed from `startRow`. */
  rowOffsets: number[];
  /**
   * The buffer column each row's text begins at, indexed from `startRow`.
   * Zero except past an app's own hard wrap, whose hanging indent is layout
   * rather than content and is left out of `text`.
   */
  rowColumns: number[];
  /** No real line start ended the window — `^` is a lie at `text`'s start. */
  clippedStart: boolean;
  /** No real line end ended the window — `$` is a lie at `text`'s end. */
  clippedEnd: boolean;
}

/** What the rejoin needs from a buffer row. */
interface RowSnapshot {
  /** Untrimmed, so a row's length is its width in cells for ASCII content. */
  text: string;
  isWrapped: boolean;
}

type RowReader = (row: number) => RowSnapshot | undefined;

// Matches xterm's own web-link provider: a rejoin budget that keeps a pathological
// unwrapped paste from turning every hover into a megabyte of string building.
const MAX_LOGICAL_LINE_LENGTH = 2048;

// Sentence punctuation an agent leaves glued to the end of a path token.
const TRAILING_PUNCTUATION = /[,.;:!?)\]}'"`>]+$/;

// A token that already reads as a whole file: `.ext`, maybe `:line[:col]`. The
// dot must follow a name character, so a hidden segment (`/.claude`) cut at the
// margin still reads as a directory to be continued.
const COMPLETE_FILE_TAIL = /[^\\/.]\.\w+(?::\d+(?::\d+)?)?$/;

function overlapsClaimed(
  claimed: ReadonlyArray<[number, number]>,
  startIndex: number,
  endIndex: number
): boolean {
  return claimed.some(([start, end]) => startIndex < end && endIndex > start);
}

/** Map an index in a rejoined logical line back to its buffer row and column. */
function mapToRow(logical: LogicalLine, index: number): { row: number; column: number } {
  let offsetIndex = 0;
  while (
    offsetIndex + 1 < logical.rowOffsets.length &&
    logical.rowOffsets[offsetIndex + 1]! <= index
  ) {
    offsetIndex++;
  }
  return {
    row: logical.startRow + offsetIndex,
    column: index - logical.rowOffsets[offsetIndex]! + logical.rowColumns[offsetIndex]!,
  };
}

/**
 * Project a logical-line span onto the hovered row, clamped to that row's
 * text, or null when the span never touches it.
 *
 * Every claim in `claimed` — and every overlap test against it — speaks this
 * coordinate space: the ledger is row-local, and the directory pass reading it
 * never leaves the row. Handing it a logical-line index typechecks fine and
 * silently stops shielding anything, so both scanning passes come through here
 * instead of doing the arithmetic themselves.
 *
 * The span is intersected with the row's own segment of the logical line
 * before it is shifted by `rowColumn`: a match ending on the row above ends
 * exactly where this row's segment begins, and shifting first would land it on
 * the dropped indent as if it touched this row.
 */
function projectToRow(
  rowOffset: number,
  rowColumn: number,
  rowLength: number,
  startIndex: number,
  endIndex: number
): [number, number] | null {
  const segmentLength = rowLength - rowColumn;
  const localStart = startIndex - rowOffset;
  const localEnd = endIndex - rowOffset;
  // Only tokens touching THIS row are ours to report. xterm projects a
  // returned range onto the requested row and evicts lower-priority links that
  // intersect it, so handing back a sibling row's link would blank a web link
  // the user can actually see.
  if (localEnd <= 0 || localStart >= segmentLength) return null;
  return [rowColumn + Math.max(0, localStart), rowColumn + Math.min(segmentLength, localEnd)];
}

/** Whether any cell between `from` and `to` is a space. */
function hasSpaceIn(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index++) {
    if (text.charCodeAt(index) === 32) return true;
  }
  return false;
}

/**
 * Whether a match sits inside a token the window's edge may have cut in half.
 *
 * A clipped edge is not a line boundary — the rejoin budget or a scrollback
 * eviction put it there — so the regexes' `^`/`$` lie about it. So does a
 * boundary CHARACTER that can appear mid-token: `(` is legal inside a file
 * URL, which is exactly how `file:///tmp/(src/foo.ts` offers `src/foo.ts` as a
 * bare path. Once the scheme has been cut away there is nothing left to claim
 * that span, so matching on `startIndex === 0` alone would let the fragment
 * through. Only a real space between the cut and the match proves the match's
 * own token began after it — and a space is the only whitespace a row can
 * translate to, since xterm stores tabs as cells and pads empty ones with it.
 *
 * Callers claim a rejected match anyway; claiming only ever suppresses links.
 * A token lying entirely outside the window stays invisible: bounding the
 * rejoin is what makes hover affordable, and reaching that bound needs a
 * logical line past 2048 columns.
 */
function touchesClippedEdge(logical: LogicalLine, startIndex: number, endIndex: number): boolean {
  return (
    (logical.clippedStart && !hasSpaceIn(logical.text, 0, startIndex)) ||
    (logical.clippedEnd && !hasSpaceIn(logical.text, endIndex, logical.text.length))
  );
}

/** Buffer range for a logical-line span, which may cover several rows. */
function rangeFor(logical: LogicalLine, startIndex: number, endIndex: number): IBufferRange {
  const start = mapToRow(logical, startIndex);
  const end = mapToRow(logical, endIndex - 1);
  return {
    // xterm rows are 1-based and the end column is inclusive, so `end`
    // addresses the token's last character rather than the one past it.
    start: { x: start.column + 1, y: start.row + 1 },
    end: { x: end.column + 1, y: end.row + 1 },
  };
}

/**
 * Whether two reads of the same row's rejoin window describe the same
 * geometry. Text alone isn't enough: a link spanning rows carries coordinates
 * derived from `startRow` and `rowOffsets`, so a re-wrap that moves a row
 * boundary without changing a character still invalidates the range it was
 * given.
 */
function sameLogicalLine(a: LogicalLine, b: LogicalLine): boolean {
  return (
    a.text === b.text &&
    a.startRow === b.startRow &&
    a.clippedStart === b.clippedStart &&
    a.clippedEnd === b.clippedEnd &&
    a.rowOffsets.length === b.rowOffsets.length &&
    a.rowOffsets.every((offset, index) => offset === b.rowOffsets[index]) &&
    a.rowColumns.every((column, index) => column === b.rowColumns[index])
  );
}

/** Index of a row's first non-space character, or -1 for a blank row. */
function firstNonSpace(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 32) return index;
  }
  return -1;
}

/**
 * Whether `lower` could be an app's own continuation of `upper`: the
 * indent it would carry, or null.
 *
 * Shape only. `upper` must run to the right edge and `lower` must be a row the
 * terminal didn't wrap, opening with a hanging indent of spaces. Both rows
 * must be exactly `cols` characters long. That's a total-length check, not a
 * cell-by-cell one: a wide character usually leaves a row short and turns it
 * away, but an emoji's surrogate pair or a combining mark can even the count
 * back out and misplace the underline. It never retargets the file.
 */
function hardWrapIndent(upper: RowSnapshot, lower: RowSnapshot, cols: number): number | null {
  if (lower.isWrapped) return null;
  if (upper.text.length !== cols || upper.text.charCodeAt(cols - 1) === 32) return null;
  if (lower.text.length !== cols) return null;
  const indent = firstNonSpace(lower.text);
  return indent >= 1 ? indent : null;
}

/**
 * Whether a joined token is one path from end to end: a single file-path or
 * `file://` match that opens the token and runs to its end, apart from
 * trailing sentence punctuation. A match that only crosses the join proves
 * nothing, because the row edge can land anywhere inside unrelated text. A
 * token carrying a scheme must be a file URL, so a web URL at the margin never
 * absorbs a path from the next row.
 */
function isWholePathToken(token: string): boolean {
  const body = token.replace(TRAILING_PUNCTUATION, "");
  const regex = body.includes("://") ? FILE_URL_REGEX : FILE_PATH_REGEX;
  const first = body.matchAll(regex).next();
  if (first.done) return false;
  const match = first.value;
  const capture = match[1];
  if (match.index !== 0 || capture === undefined) return false;
  return match[0].indexOf(capture) + capture.length === body.length;
}

/** The unbroken run of text in `text` starting at `from`. */
function leadingRun(text: string, from: number): string {
  const end = text.indexOf(" ", from);
  return text.slice(from, end === -1 ? text.length : end);
}

/** The unbroken run of text that ends a row. */
function trailingRun(text: string): string {
  return text.slice(text.lastIndexOf(" ") + 1);
}

/** Whether a token already reads as a whole file, sentence punctuation aside. */
function endsAsFile(token: string): boolean {
  return COMPLETE_FILE_TAIL.test(token.replace(TRAILING_PUNCTUATION, ""));
}

/**
 * Settle every app hard wrap in the run of rows one token crosses, starting
 * from the hard boundary below `upperRow`. The result maps each hard
 * boundary's upper row to whether its rows join.
 *
 * Agent TUIs (Claude Code's Ink, for one) wrap their own output: a word longer
 * than the text box is cut at the margin and resumed on the next row after a
 * hanging indent, with an explicit newline in between. xterm only flags
 * `isWrapped` for its own autowrap, so nothing in the buffer records that the
 * two rows are one token. Scanning them apart links the tail as a relative path
 * under the cwd, which is a live link to the wrong file.
 *
 * The run is found from shape alone. It walks up and down through every row
 * the token fills edge to edge, across xterm's own wraps as well as the app's.
 * It never crosses a hard wrap where the upper row's part of the token already
 * reads as a whole file (`src/a.ts`, then an unrelated indented line). That
 * test looks at one row only, so every boundary of a run arrives at the same
 * run and the same verdicts. Each row of a long path agrees whichever one the
 * pointer is on.
 *
 * Joining is a guess, so the run has to earn it:
 * - Before its first hard wrap, the token must carry a path separator.
 * - A word-wrapper only splits a word that can't fit on a line, and the box
 *   runs from the continuation's indent to the pane's right edge. A token no
 *   longer than that was two words that happened to meet at the margin.
 * - The joined token must be one path from end to end.
 *
 * The rows can't record where a newline really was, so a coincidence can still
 * pass: an extensionless path ending exactly at the margin, followed by an
 * indented path, joins the two. The opposite miss happens too: a cut that
 * leaves `.ex` behind, inside an extension or a dotted name, reads as a whole
 * file and isn't joined. Both need the cut to land in exactly the wrong place,
 * and the alternative is to link every hard-wrapped path to the wrong file.
 *
 * A run longer than the rejoin budget, or one whose start was trimmed out of
 * scrollback, can't be read end to end, so it isn't joined: every join is one
 * the token has earned. Its rows are scanned as they stand, the way every hard
 * wrap was before this existed. That leaves a token over 2048 characters to
 * the row-by-row reading, and no path is that long.
 */
function resolveHardWraps(
  read: RowReader,
  cols: number,
  upperRow: number,
  indent: number
): Map<number, boolean> {
  type Join = "soft" | "hard";
  // How the token crosses from `upper` into `lower`, if it does.
  const crossing = (upper: RowSnapshot, lower: RowSnapshot): Join | null => {
    if (lower.isWrapped) {
      const upperEnd = upper.text.length - 1;
      return upper.text.charCodeAt(upperEnd) !== 32 && lower.text.charCodeAt(0) !== 32
        ? "soft"
        : null;
    }
    if (hardWrapIndent(upper, lower, cols) !== indent) return null;
    return endsAsFile(trailingRun(upper.text)) ? null : "hard";
  };
  // Where the token resumes on a row it crossed onto.
  const resumeAt = (join: Join): number => (join === "soft" ? 0 : indent);
  // Whether the token fills `row` from `from` to the edge, running on past it.
  const fills = (row: RowSnapshot, from: number): boolean =>
    row.text.length === cols && !hasSpaceIn(row.text, from, cols);

  const verdicts = new Map<number, boolean>();
  if (endsAsFile(trailingRun(read(upperRow)!.text))) {
    verdicts.set(upperRow, false);
    return verdicts;
  }

  // The run's length as the rejoin will hold it: the head row whole, every
  // row after it from where the token resumes.
  let span = cols + cols - indent;
  let unjudgeable = false;

  const above: Join[] = [];
  let head = upperRow;
  for (;;) {
    const row = read(head)!;
    const previous = read(head - 1);
    if (!previous) {
      // A row still claiming xterm's wrap at the top of the buffer lost its
      // head to scrollback trimming, and the token's start with it.
      if (row.isWrapped && fills(row, 0)) unjudgeable = true;
      break;
    }
    const join = crossing(previous, row);
    if (join === null || !fills(row, resumeAt(join))) break;
    if ((span += cols - resumeAt(join)) > MAX_LOGICAL_LINE_LENGTH) {
      unjudgeable = true;
      break;
    }
    above.push(join);
    head--;
  }

  const below: Join[] = ["hard"];
  let tail = upperRow + 1;
  while (!unjudgeable) {
    const row = read(tail)!;
    if (!fills(row, resumeAt(below[below.length - 1]!))) break;
    const next = read(tail + 1);
    const join = next ? crossing(row, next) : null;
    if (join === null) break;
    if ((span += cols - resumeAt(join)) > MAX_LOGICAL_LINE_LENGTH) {
      unjudgeable = true;
      break;
    }
    below.push(join);
    tail++;
  }

  // joins[k] is the boundary between rows `head + k` and `head + k + 1`.
  const joins = [...above.reverse(), ...below];
  let joined = false;
  if (!unjudgeable) {
    let token = trailingRun(read(head)!.text);
    let prefix: string | null = null;
    for (const [k, join] of joins.entries()) {
      if (join === "hard") prefix ??= token;
      token += leadingRun(read(head + k + 1)!.text, resumeAt(join));
    }
    joined =
      prefix !== null &&
      (prefix.includes("/") || prefix.includes("\\")) &&
      token.length > cols - indent &&
      isWholePathToken(token);
  }
  joins.forEach((join, k) => {
    if (join === "hard") verdicts.set(head + k, joined);
  });
  return verdicts;
}

/**
 * Cheap validation memo for directory candidates, keyed
 * `worktreeId\nrelativePath`. Hover re-fires for the same line constantly, so
 * without this every pointer crossing would re-stat the same tokens. Entries
 * expire on a short TTL — an agent deleting or creating a directory should
 * change what's clickable within seconds, in both directions (a stale
 * "directory" stays clickable; a stale `null` keeps a new directory dead).
 * Cleared wholesale at the cap — hover-driven lookups repopulate what still
 * matters, and real LRU bookkeeping isn't worth it for a cache this cheap.
 */
const dirKindCache = new Map<string, { kind: "file" | "directory" | null; at: number }>();
const DIR_KIND_CACHE_CAP = 500;
const DIR_KIND_CACHE_TTL_MS = 15_000;

// A stalled stat must not wedge the line's links forever: xterm serializes
// provider replies per line, so an unresolved callback blocks file links and
// every lower-priority provider. Past this deadline the file links ship alone.
const DIR_VALIDATION_TIMEOUT_MS = 1_500;

export class FileLinksAddon implements ILinkProvider {
  private _terminal: Terminal;
  private _getCwd: () => string;
  private _onHover?: HoverCallback;
  private _disposed = false;

  constructor(terminal: Terminal, getCwd: () => string, onHover?: HoverCallback) {
    this._terminal = terminal;
    this._getCwd = getCwd;
    this._onHover = onHover;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const links: ILink[] = [];
    if (bufferLineNumber < 1) {
      callback(undefined);
      return;
    }
    const line = this._terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const lineText = line.translateToString(true);
    const read = this._rowReader();

    // A row that continues, or is continued by, another holds only part of a
    // logical line, so nothing about it can be decided from its own text.
    const partOfWrappedLine =
      line.isWrapped === true ||
      this._terminal.buffer.active.getLine(bufferLineNumber)?.isWrapped === true;

    // Fast path: every FILE_PATH_REGEX alternative requires a path separator
    // ('/' or '\'), so a line with neither can never contain a file path. Most
    // agent output (code without imports, prose, prompts) hits this and skips
    // the regex entirely. provideLinks is pointer-driven (xterm Linkifier2
    // _activeLine cache, fires when the pointer crosses a new row), so this is
    // scroll-feel regex/GC cost, not write throughput. A wrapped row is exempt:
    // the tail of `file:///tmp/long/` + `shot.png` carries no separator of its
    // own, and skipping it would leave half the URL unclickable. So is a row
    // that may continue an app's own hard wrap. A row that continues nothing
    // can still open one, but the token has to carry a separator before its
    // first hard wrap, so that row would have one of its own.
    if (
      !partOfWrappedLine &&
      !lineText.includes("/") &&
      !lineText.includes("\\") &&
      !this._mayContinueHardWrap(bufferLineNumber - 1, read)
    ) {
      callback(undefined);
      return;
    }

    // Byte ranges the file links occupy, so a directory candidate that merely
    // re-matches a file token (`src/file.ts` satisfies both regexes) is
    // dropped instead of stacking a second link on the same characters.
    const claimed: Array<[number, number]> = [];

    // One rejoin, shared by both scanning passes and by the deferred reply's
    // staleness check. xterm soft-wraps mid-token, so neither `file://` URLs
    // nor bare paths can be decided from a single row: whichever fragment the
    // margin leaves behind still parses, and linking it opens a real-but-wrong
    // file. The no-separator fast path above already turned away the rows that
    // would make this cost anything, and the window itself is budgeted.
    const logical = this._readLogicalLine(bufferLineNumber - 1, read);
    if (!logical) {
      callback(undefined);
      return;
    }
    // The hovered row's offset into the joined text and the buffer column its
    // text starts at, for translating a match back into `lineText`
    // coordinates — the space `claimed` and the row-local directory pass both
    // speak. The window is anchored on this row, so the lookup always lands.
    const rowSlot = bufferLineNumber - 1 - logical.startRow;
    const rowOffset = logical.rowOffsets[rowSlot]!;
    const rowColumn = logical.rowColumns[rowSlot]!;

    // `file://` URLs are scanned first so their spans are claimed before the
    // bare-path and directory passes. The gate stays: a line with no scheme
    // can't start a URL, and a line that neither continues nor is continued
    // can't be hiding the rest of one. provideLinks is pointer-driven across
    // every visible terminal, so the common line still runs no URL regex.
    // `://` (not `file://`) keeps the guard case-insensitive without a copy.
    if (lineText.includes("://") || partOfWrappedLine || logical.rowOffsets.length > 1) {
      this._collectUrlLinks(logical, rowOffset, rowColumn, lineText, links, claimed);
    }

    this._collectBarePathLinks(logical, rowOffset, rowColumn, lineText, links, claimed);

    const candidates = this._collectDirCandidates(lineText, claimed);
    if (candidates.length === 0) {
      callback(links.length > 0 ? links : undefined);
      return;
    }

    // Directory links are validated against the filesystem before they exist:
    // the regex is loose enough to match `and/or`, and a link that opens a
    // browser onto nothing teaches the user to stop clicking. The callback is
    // deferred until validation lands — xterm's Linkifier tolerates async
    // providers, and a hover-scale stat batch resolves in milliseconds.
    //
    // Two-handler `.then(onOk, onErr)`, not `.then().catch()`: a chained catch
    // would also trap an exception thrown by `callback` itself and invoke it a
    // second time. An error (evicted view, IPC teardown, timeout) only costs
    // the directory links; the file links this line produced still stand.
    const timeout = new Promise<ScopedDirCandidate[]>((resolve) =>
      setTimeout(() => resolve([]), DIR_VALIDATION_TIMEOUT_MS)
    );

    // Both outcomes land in one finalization. The staleness checks are not a
    // success-path nicety: a file link can now span rows, so a reply arriving
    // after the buffer moved would paint coordinates that no longer describe
    // what the user is looking at — whether or not validation succeeded.
    const finalize = (confirmed: ScopedDirCandidate[]): void => {
      // Disposed while validating (terminal closed): the registration is
      // gone, so a late reply has no linkifier to serve.
      if (this._disposed) return;
      // The buffer may have been rewritten under the pointer while validation
      // was in flight (streaming agent output). xterm caches replies by the
      // pointer's current line, so links computed for the OLD content would
      // paint on the new one — drop the whole reply instead.
      //
      // The whole rejoin window is re-read rather than the hovered row alone:
      // a link can span rows the row itself never sees, and a re-wrap that
      // merely moves a boundary leaves a range underlining the wrong cells.
      // Comparing windows also keeps the check off `translateToString(true)`,
      // which is not stable across an intervening untrimmed read — xterm
      // caches one string per line, and a trailing space the app actually
      // printed survives `getTrimmedLength()` but not the cached value's
      // `trimEnd()`, so the same unchanged row can compare unequal to itself.
      const currentLogical = this._readLogicalLine(bufferLineNumber - 1);
      if (!currentLogical || !sameLogicalLine(currentLogical, logical)) {
        callback(undefined);
        return;
      }
      for (const candidate of confirmed) {
        const range: IBufferRange = {
          start: { x: candidate.startIndex + 1, y: bufferLineNumber },
          end: { x: candidate.startIndex + candidate.text.length, y: bufferLineNumber },
        };
        links.push(
          new DirectoryLink(
            range,
            candidate.text,
            candidate.absolutePath,
            candidate.worktreeId,
            candidate.relativePath,
            this._onHover
          )
        );
      }
      callback(links.length > 0 ? links : undefined);
    };

    void Promise.race([this._validateDirCandidates(candidates), timeout]).then(finalize, () =>
      finalize([])
    );
  }

  /**
   * Scan the logical line for `file://` URLs, appending links and claiming the
   * spans they occupy on the hovered row.
   *
   * Rows are rejoined by the caller because xterm soft-wraps mid-token and the
   * motivating URL — an agent's generated-image path — is long enough to wrap
   * in any tiled terminal. Scanning one row would capture the prefix that
   * happens to end at the margin, and a truncated `file://` URL still parses,
   * so it would link to a real-but-wrong path instead of failing.
   *
   * Spans are claimed for every syntactic match, resolved or not: a rejected
   * remote URL must still shield its own characters from the bare-path pass.
   */
  private _collectUrlLinks(
    logical: LogicalLine,
    rowOffset: number,
    rowColumn: number,
    lineText: string,
    links: ILink[],
    claimed: Array<[number, number]>
  ): void {
    for (const match of logical.text.matchAll(FILE_URL_REGEX)) {
      const url = match[1];
      if (url === undefined) continue;

      // Indexed off the capture, not `match[0]`: the match also spans the
      // leading boundary character and any trailing sentence punctuation,
      // neither of which the link should underline or own.
      const startIndex = match.index + match[0]!.indexOf(url);
      const endIndex = startIndex + url.length;

      const local = projectToRow(rowOffset, rowColumn, lineText.length, startIndex, endIndex);
      if (!local) continue;
      claimed.push(local);

      if (touchesClippedEdge(logical, startIndex, endIndex)) continue;

      const resolved = resolveFileUrlCandidate(url);
      if (!resolved) continue;

      // No line/col: `resolveFileUrlCandidate` deliberately doesn't peel a
      // `:line` suffix off a URL, so there is none to forward.
      links.push(
        new FileLink(
          rangeFor(logical, startIndex, endIndex),
          url,
          resolved.absolutePath,
          undefined,
          undefined,
          this._getCwd(),
          this._onHover
        )
      );
    }
  }

  /**
   * Scan the logical line for bare (non-URL) path tokens, appending links and
   * claiming the spans they occupy on the hovered row.
   *
   * Rejoined for the same reason URLs are, and for one more: `FILE_PATH_REGEX`
   * opens with `(?:^|[\s(])`, and on a continuation row that `^` asserts a
   * token boundary at a column where the token is still mid-flight. Scanning a
   * single row captured whichever fragment the margin left behind — and a
   * fragment resolves against the cwd just as happily as the whole path, so
   * the link, the hover callback, and right-click "Reveal" all agreed on a
   * real-but-wrong file with nothing to signal it (#11865).
   *
   * Spans are claimed for every syntactic match touching the row, resolved or
   * not. The directory pass is looser than this one by design (`and/or`
   * matches it), so a token this pass owns but can't resolve must not come
   * back as a lower-confidence directory link on the same characters.
   */
  private _collectBarePathLinks(
    logical: LogicalLine,
    rowOffset: number,
    rowColumn: number,
    lineText: string,
    links: ILink[],
    claimed: Array<[number, number]>
  ): void {
    // matchAll on the module-scope global regex clones it internally (per spec)
    // and never mutates lastIndex, so the regex is reused across hover calls
    // without the per-call `new RegExp(FILE_PATH_REGEX)` allocation.
    for (const match of logical.text.matchAll(FILE_PATH_REGEX)) {
      const fullMatch = match[1];
      if (fullMatch === undefined) continue;

      const startIndex = match.index + match[0]!.indexOf(fullMatch);
      const endIndex = startIndex + fullMatch.length;

      const local = projectToRow(rowOffset, rowColumn, lineText.length, startIndex, endIndex);
      if (!local) continue;

      // A `(` is legal inside a file URL and is also this regex's boundary
      // character, so `file:///tmp/(src/foo.ts` offers `src/foo.ts` as a bare
      // path — which would resolve against the cwd and link a different file
      // than the URL names. Every URL span is claimed whether or not it
      // resolved, so a rejected remote URL can't leak a local link either.
      if (overlapsClaimed(claimed, local[0], local[1])) continue;
      claimed.push(local);

      if (touchesClippedEdge(logical, startIndex, endIndex)) continue;
      if (isPathExcluded(fullMatch)) continue;

      const resolved = resolveFilePathCandidate(fullMatch, this._getCwd());
      if (!resolved) continue;

      links.push(
        new FileLink(
          rangeFor(logical, startIndex, endIndex),
          fullMatch,
          resolved.absolutePath,
          resolved.line,
          resolved.col,
          this._getCwd(),
          this._onHover
        )
      );
    }
  }

  /**
   * Rejoin the wrapped rows around `rowIndex` into the logical line the user
   * actually sees, remembering where each row's text starts so matches can be
   * mapped back to buffer coordinates. Rows are joined where xterm wrapped
   * them itself, and where an app hard-wrapped a path at the margin (see
   * `resolveHardWraps`), minus that continuation's indent.
   *
   * The window is anchored on `rowIndex` and grows outward on a shared budget,
   * rather than starting at the logical line's first row: a run longer than
   * the budget would otherwise stop before reaching the hovered row, leaving
   * it unclaimed and its characters free for the bare-path pass to mis-link.
   * An end the budget cuts is reported as clipped, and so is a start that ran
   * out of buffer while the topmost row still claimed to continue something:
   * either way the edge is artificial, and a match against one can't be
   * trusted to be whole.
   */
  private _readLogicalLine(rowIndex: number, read = this._rowReader()): LogicalLine | null {
    const current = read(rowIndex);
    if (!current) return null;
    const cols = this._terminal.cols;
    // Every hard boundary of a run is settled the first time any of them is
    // asked about, so the rejoin walks each run once.
    const verdicts = new Map<number, boolean>();
    // The indent a hard-wrapped continuation of `upperRow` carries, or null.
    const hardIndent = (upperRow: number): number | null => {
      if (typeof cols !== "number" || cols <= 0) return null;
      const upper = read(upperRow);
      const lower = read(upperRow + 1);
      if (!upper || !lower) return null;
      const indent = hardWrapIndent(upper, lower, cols);
      if (indent === null) return null;
      if (!verdicts.has(upperRow)) {
        for (const [row, joined] of resolveHardWraps(read, cols, upperRow, indent)) {
          verdicts.set(row, joined);
        }
      }
      return verdicts.get(upperRow) === true ? indent : null;
    };

    // trimRight is deliberately OFF for the rejoin. A wrapped row is full by
    // definition, so trimming can only delete real trailing spaces — and those
    // spaces are what separate a URL from the next token, so dropping them
    // fuses `file:///tmp/a.png` and a following path into one bogus target.
    // The cost is the inverse of xterm's tradeoff: a wide char that wrapped
    // early leaves a placeholder space mid-token, so that (rare, ASCII-free)
    // URL goes unlinked. Missing a link beats linking the wrong file.
    const texts = [current.text];
    const columns = [0];
    let startRow = rowIndex;
    let budget = MAX_LOGICAL_LINE_LENGTH - current.text.length;
    let clippedStart = false;
    let clippedEnd = false;

    // `isWrapped` marks a row as the CONTINUATION of the one above it. A row
    // without it can still continue its predecessor through an app's hard wrap.
    for (;;) {
      const top = read(startRow)!;
      if (top.isWrapped) {
        // Row 0 still claiming to continue something means the rows carrying
        // the token's head were trimmed out of scrollback — xterm keeps the
        // flag when its circular buffer evicts the row above. The window then
        // opens mid-token exactly the way the budget cutoff does, and a
        // headless fragment resolves against the cwd just as happily as a
        // whole path.
        if (startRow === 0) {
          clippedStart = true;
          break;
        }
      } else {
        const indent = hardIndent(startRow - 1);
        if (indent === null) break;
        // The indent goes before the budget check: a join the budget refuses
        // must still leave the fragment flush against the clipped edge, or the
        // indent's spaces would read as the start of a whole token.
        texts[0] = texts[0]!.slice(indent);
        columns[0] = indent;
        budget += indent;
      }
      const above = read(startRow - 1);
      if (!above) break;
      if (above.text.length > budget) {
        clippedStart = true;
        break;
      }
      budget -= above.text.length;
      texts.unshift(above.text);
      columns.unshift(0);
      startRow--;
    }

    for (let row = rowIndex + 1; ; row++) {
      const below = read(row);
      if (!below) break;
      let indent = 0;
      if (!below.isWrapped) {
        const hard = hardIndent(row - 1);
        if (hard === null) break;
        indent = hard;
      }
      const text = below.text.slice(indent);
      if (text.length > budget) {
        clippedEnd = true;
        break;
      }
      budget -= text.length;
      texts.push(text);
      columns.push(indent);
    }

    const rowOffsets: number[] = [];
    let text = "";
    for (const rowText of texts) {
      rowOffsets.push(text.length);
      text += rowText;
    }
    return { text, startRow, rowOffsets, rowColumns: columns, clippedStart, clippedEnd };
  }

  /**
   * A reader over the active buffer that reads each row at most once. The
   * fast-path probe, the rejoin, and the hard-wrap walk all revisit the same
   * rows. Scoped to one read of the buffer: a later staleness check needs a
   * fresh one.
   */
  private _rowReader(): RowReader {
    const buffer = this._terminal.buffer.active;
    const cache = new Map<number, RowSnapshot | undefined>();
    return (row) => {
      if (row < 0) return undefined;
      if (cache.has(row)) return cache.get(row);
      const line = buffer.getLine(row);
      const snapshot = line
        ? { text: line.translateToString(false), isWrapped: line.isWrapped === true }
        : undefined;
      cache.set(row, snapshot);
      return snapshot;
    };
  }

  /**
   * Cheap test for whether `rowIndex` could continue the row above through an
   * app's own hard wrap. It lets a row with no separator past the fast path,
   * the way a middle or tail fragment of a long path must be. The full
   * verdict is `resolveHardWraps`'s.
   */
  private _mayContinueHardWrap(rowIndex: number, read: RowReader): boolean {
    const cols = this._terminal.cols;
    if (typeof cols !== "number" || cols <= 0 || rowIndex === 0) return false;
    const above = read(rowIndex - 1);
    const current = read(rowIndex);
    return !!above && !!current && hardWrapIndent(above, current, cols) !== null;
  }

  private _collectDirCandidates(
    lineText: string,
    claimed: Array<[number, number]>
  ): DirCandidate[] {
    const candidates: DirCandidate[] = [];
    for (const match of lineText.matchAll(DIR_PATH_REGEX)) {
      const fullMatch = match[1];
      if (fullMatch === undefined || isPathExcluded(fullMatch)) continue;

      const startIndex = match.index + match[0]!.indexOf(fullMatch);
      const endIndex = startIndex + fullMatch.length;
      if (overlapsClaimed(claimed, startIndex, endIndex)) continue;

      const absolutePath = resolveDirPathCandidate(fullMatch, this._getCwd());
      if (!absolutePath) continue;

      candidates.push({ text: fullMatch, startIndex, absolutePath });
    }
    return candidates;
  }

  private async _validateDirCandidates(candidates: DirCandidate[]): Promise<ScopedDirCandidate[]> {
    // Imported here, not at module scope: the worktree store's module graph
    // reaches `@/clients`, and the addon is consumed by tests (and potentially
    // early-boot code) that mock or lack that surface. By the time a link is
    // being validated the app is fully booted, so the import is settled.
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // Null before the WorktreeStoreProvider mounts — no worktrees means no
    // directory links yet, which is the right answer for a still-booting view.
    const worktrees: ReadonlyMap<string, { id: string; path: string }> =
      getCurrentViewStoreOrNull()?.getState().worktrees ?? new Map();

    const confirmed: ScopedDirCandidate[] = [];
    const toStat: ScopedDirCandidate[] = [];

    for (const candidate of candidates) {
      // Resolved against the live worktree list, deepest root winning, so a
      // nested worktree beats the repo hosting it. The relative path comes back
      // forward-slashed: `ancestorDirectories` and the stat-paths op both speak
      // "/", and a Windows cwd would otherwise expand nothing.
      const scope = resolveWorktreePathScope(candidate.absolutePath, worktrees.values());
      if (!scope) continue;
      const scoped: ScopedDirCandidate = {
        ...candidate,
        worktreeId: scope.worktreeId,
        relativePath: scope.relativePath,
      };

      // The worktree root itself is a known directory — no stat needed, and
      // the batch op requires non-empty relative paths anyway.
      if (scoped.relativePath === "") {
        confirmed.push(scoped);
        continue;
      }
      const cached = dirKindCache.get(cacheKey(scoped));
      if (cached !== undefined && Date.now() - cached.at < DIR_KIND_CACHE_TTL_MS) {
        if (cached.kind === "directory") confirmed.push(scoped);
      } else {
        toStat.push(scoped);
      }
    }

    // One batched call per worktree present on the line (nearly always one).
    const byWorktree = new Map<string, ScopedDirCandidate[]>();
    for (const candidate of toStat) {
      const bucket = byWorktree.get(candidate.worktreeId);
      if (bucket) bucket.push(candidate);
      else byWorktree.set(candidate.worktreeId, [candidate]);
    }

    for (const [worktreeId, bucket] of byWorktree) {
      const batch = bucket.slice(0, 32);
      const kinds = await fileBrowserClient.statPaths({
        worktreeId,
        paths: batch.map((candidate) => candidate.relativePath),
      });
      batch.forEach((candidate, index) => {
        const kind = kinds[index] ?? null;
        if (dirKindCache.size >= DIR_KIND_CACHE_CAP) dirKindCache.clear();
        dirKindCache.set(cacheKey(candidate), { kind, at: Date.now() });
        if (kind === "directory") confirmed.push(candidate);
      });
    }

    confirmed.sort((a, b) => a.startIndex - b.startIndex);
    return confirmed;
  }

  dispose(): void {
    // Read by the deferred validation reply: a reply landing after disposal
    // has no live linkifier registration to serve and must not call back.
    this._disposed = true;
  }
}

function cacheKey(candidate: ScopedDirCandidate): string {
  return `${candidate.worktreeId}\n${candidate.relativePath}`;
}

class FileLink implements ILink {
  // Structural discriminant read by the context menu (via `TerminalLink`) to
  // distinguish a resolved file link from a plain URL link without an
  // `instanceof` check across the addon/service boundary.
  readonly kind = "file" as const;

  constructor(
    public range: IBufferRange,
    public text: string,
    private _absolutePath: string,
    private _line?: number,
    private _col?: number,
    private _rootPath?: string,
    private _onHover?: HoverCallback
  ) {}

  /** Resolved absolute path for this file link (relative paths already joined to cwd). */
  get absolutePath(): string {
    return this._absolutePath;
  }

  activate(event: MouseEvent, _text: string): void {
    const isModified = event.metaKey || event.ctrlKey;

    if (isModified) {
      actionService
        .dispatch(
          "file.openInEditor",
          { path: this._absolutePath, line: this._line, col: this._col },
          { source: "user" }
        )
        .then(async (result) => {
          if (result.ok) return;
          // Lazy import: projectStore pulls in TerminalInstanceService, which
          // imports this module — a static import would close that cycle.
          const { useProjectStore } = await import("@/store/projectStore");
          return systemClient.openInEditor({
            path: this._absolutePath,
            line: this._line,
            col: this._col,
            projectId: useProjectStore.getState().currentProject?.id,
          });
        })
        .catch((error) => {
          reportFileLinkFailure("Failed to open in editor", error, this._absolutePath);
        });
    } else {
      actionService
        .dispatch(
          "file.view",
          { path: this._absolutePath, rootPath: this._rootPath, line: this._line, col: this._col },
          { source: "user" }
        )
        .then((result) => {
          if (result.ok) return;
          return systemClient.openPath(this._absolutePath);
        })
        .catch((error) => {
          reportFileLinkFailure("Failed to view file", error, this._absolutePath);
        });
    }
  }

  hover?(_event: MouseEvent, _text: string): void {
    this._onHover?.(this);
  }

  leave?(_event: MouseEvent, _text: string): void {
    this._onHover?.(null);
  }

  dispose?(): void {}
}

/**
 * A validated directory token. Activation opens the worktree's file browser
 * revealed at this directory — the browsing surface is the right destination
 * for a folder the way the file viewer is for a file.
 */
class DirectoryLink implements ILink {
  readonly kind = "directory" as const;

  constructor(
    public range: IBufferRange,
    public text: string,
    private _absolutePath: string,
    private _worktreeId: string,
    private _relativePath: string,
    private _onHover?: HoverCallback
  ) {}

  get absolutePath(): string {
    return this._absolutePath;
  }

  activate(_event: MouseEvent, _text: string): void {
    actionService
      .dispatch(
        "worktree.openFileBrowser",
        {
          worktreeId: this._worktreeId,
          revealPath: this._relativePath === "" ? undefined : this._relativePath,
          revealKind: "directory",
        },
        { source: "user" }
      )
      .then((result) => {
        if (result.ok) return;
        throw result.error;
      })
      .catch((error) => {
        reportFileLinkFailure(
          "Failed to open folder in file browser",
          error,
          this._absolutePath,
          "folder"
        );
      });
  }

  hover?(_event: MouseEvent, _text: string): void {
    this._onHover?.(this);
  }

  leave?(_event: MouseEvent, _text: string): void {
    this._onHover?.(null);
  }

  dispose?(): void {}
}
