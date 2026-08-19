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

/** A soft-wrapped run of buffer rows, rejoined into the line the user sees. */
interface LogicalLine {
  text: string;
  /** 0-based buffer index of the first row in the window. */
  startRow: number;
  /** Where each row's text begins in `text`, indexed from `startRow`. */
  rowOffsets: number[];
  /** The budget, not a real line start, ended the window — `^` is a lie here. */
  clippedStart: boolean;
  /** The budget, not a real line end, ended the window — `$` is a lie here. */
  clippedEnd: boolean;
}

// Matches xterm's own web-link provider: a rejoin budget that keeps a pathological
// unwrapped paste from turning every hover into a megabyte of string building.
const MAX_LOGICAL_LINE_LENGTH = 2048;

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
    column: index - logical.rowOffsets[offsetIndex]!,
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
 */
function projectToRow(
  rowOffset: number,
  rowLength: number,
  startIndex: number,
  endIndex: number
): [number, number] | null {
  const localStart = startIndex - rowOffset;
  const localEnd = endIndex - rowOffset;
  // Only tokens touching THIS row are ours to report. xterm projects a
  // returned range onto the requested row and evicts lower-priority links that
  // intersect it, so handing back a sibling row's link would blank a web link
  // the user can actually see.
  if (localEnd <= 0 || localStart >= rowLength) return null;
  return [Math.max(0, localStart), Math.min(rowLength, localEnd)];
}

/**
 * Whether a match sits against an edge the rejoin budget invented rather than
 * a real line boundary. The regexes' `^`/`$` read that cutoff as a token
 * boundary — the same lie a row edge tells — so a token touching one can't be
 * trusted to be whole. Callers claim it anyway (claiming only ever suppresses
 * links) and simply never link it. A token lying entirely outside the window
 * stays invisible; bounding the rejoin is what makes hover affordable, and
 * that needs a logical line past 2048 columns to reach.
 */
function touchesClippedEdge(logical: LogicalLine, startIndex: number, endIndex: number): boolean {
  return (
    (logical.clippedStart && startIndex === 0) ||
    (logical.clippedEnd && endIndex === logical.text.length)
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
    a.rowOffsets.every((offset, index) => offset === b.rowOffsets[index])
  );
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
    // own, and skipping it would leave half the URL unclickable.
    if (!partOfWrappedLine && !lineText.includes("/") && !lineText.includes("\\")) {
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
    const logical = this._readLogicalLine(bufferLineNumber - 1);
    if (!logical) {
      callback(undefined);
      return;
    }
    // The hovered row's offset into the joined text, for translating a match
    // back into `lineText` coordinates — the space `claimed` and the row-local
    // directory pass both speak. The window is anchored on this row, so the
    // lookup always lands.
    const rowOffset = logical.rowOffsets[bufferLineNumber - 1 - logical.startRow]!;

    // `file://` URLs are scanned first so their spans are claimed before the
    // bare-path and directory passes. The gate stays: a line with no scheme
    // can't start a URL, and a line that neither continues nor is continued
    // can't be hiding the rest of one. provideLinks is pointer-driven across
    // every visible terminal, so the common line still runs no URL regex.
    // `://` (not `file://`) keeps the guard case-insensitive without a copy.
    if (lineText.includes("://") || partOfWrappedLine) {
      this._collectUrlLinks(logical, rowOffset, lineText, links, claimed);
    }

    this._collectBarePathLinks(logical, rowOffset, lineText, links, claimed);

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
      // The line may have been rewritten under the pointer while validation
      // was in flight (streaming agent output). xterm caches replies by the
      // pointer's current line, so links computed for the OLD text would
      // paint on the new one — drop the whole reply instead.
      const current = this._terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!current || current.translateToString(true) !== lineText) {
        callback(undefined);
        return;
      }
      // A file or URL link can span rows that check never looks at, so re-read
      // the whole window it was computed from: rewriting only a continuation
      // row would otherwise leave a link to the path the line used to name,
      // and a re-wrap that merely moves a row boundary would leave a range
      // underlining the wrong cells.
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

      const local = projectToRow(rowOffset, lineText.length, startIndex, endIndex);
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

      const local = projectToRow(rowOffset, lineText.length, startIndex, endIndex);
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
   * Rejoin the soft-wrapped rows around `rowIndex` into the logical line the
   * user actually sees, remembering where each row's text starts so matches
   * can be mapped back to buffer coordinates.
   *
   * The window is anchored on `rowIndex` and grows outward on a shared budget,
   * rather than starting at the logical line's first row: a run longer than
   * the budget would otherwise stop before reaching the hovered row, leaving
   * it unclaimed and its characters free for the bare-path pass to mis-link.
   * Whichever end the budget cuts is reported as clipped, because a match
   * touching an artificial edge can't be trusted to be whole.
   */
  private _readLogicalLine(rowIndex: number): LogicalLine | null {
    const buffer = this._terminal.buffer.active;
    const current = buffer.getLine(rowIndex);
    if (!current) return null;

    // trimRight is deliberately OFF for the rejoin. A wrapped row is full by
    // definition, so trimming can only delete real trailing spaces — and those
    // spaces are what separate a URL from the next token, so dropping them
    // fuses `file:///tmp/a.png` and a following path into one bogus target.
    // The cost is the inverse of xterm's tradeoff: a wide char that wrapped
    // early leaves a placeholder space mid-token, so that (rare, ASCII-free)
    // URL goes unlinked. Missing a link beats linking the wrong file.
    const texts = [current.translateToString(false)];
    let startRow = rowIndex;
    let budget = MAX_LOGICAL_LINE_LENGTH - texts[0]!.length;
    let clippedStart = false;
    let clippedEnd = false;

    // `isWrapped` marks a row as the CONTINUATION of the one above it.
    while (startRow > 0 && buffer.getLine(startRow)?.isWrapped === true) {
      const above = buffer.getLine(startRow - 1);
      if (!above) break;
      const text = above.translateToString(false);
      if (text.length > budget) {
        clippedStart = true;
        break;
      }
      budget -= text.length;
      texts.unshift(text);
      startRow--;
    }

    for (let row = rowIndex + 1; ; row++) {
      const below = buffer.getLine(row);
      if (!below || below.isWrapped !== true) break;
      const text = below.translateToString(false);
      if (text.length > budget) {
        clippedEnd = true;
        break;
      }
      budget -= text.length;
      texts.push(text);
    }

    const rowOffsets: number[] = [];
    let text = "";
    for (const rowText of texts) {
      rowOffsets.push(text.length);
      text += rowText;
    }
    return { text, startRow, rowOffsets, clippedStart, clippedEnd };
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
        .then((result) => {
          if (result.ok) return;
          return systemClient.openInEditor({
            path: this._absolutePath,
            line: this._line,
            col: this._col,
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
