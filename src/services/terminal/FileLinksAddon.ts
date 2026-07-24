import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { systemClient } from "@/clients";
import { basename } from "@shared/utils/path";
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
  /** 0-based buffer index of the first row in the run. */
  startRow: number;
  /** Where each row's text begins in `text`, indexed from `startRow`. */
  rowOffsets: number[];
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

    // Fast path: every FILE_PATH_REGEX alternative requires a path separator
    // ('/' or '\'), so a line with neither can never contain a file path. Most
    // agent output (code without imports, prose, prompts) hits this and skips
    // the regex entirely. provideLinks is pointer-driven (xterm Linkifier2
    // _activeLine cache, fires when the pointer crosses a new row), so this is
    // scroll-feel regex/GC cost, not write throughput.
    if (!lineText.includes("/") && !lineText.includes("\\")) {
      callback(undefined);
      return;
    }

    // Byte ranges the file links occupy, so a directory candidate that merely
    // re-matches a file token (`src/file.ts` satisfies both regexes) is
    // dropped instead of stacking a second link on the same characters.
    const claimed: Array<[number, number]> = [];

    // `file://` URLs are scanned first so their spans are claimed before the
    // bare-path and directory passes. Two gates, both O(1)-ish: a line with no
    // scheme can't start a URL, and a line that neither continues nor is
    // continued can't be hiding the rest of one. provideLinks is pointer-driven
    // across every visible terminal, so the common line still does no work.
    // `://` (not `file://`) keeps the guard case-insensitive without a copy.
    const partOfWrappedLine =
      line.isWrapped === true ||
      this._terminal.buffer.active.getLine(bufferLineNumber)?.isWrapped === true;
    if (lineText.includes("://") || partOfWrappedLine) {
      this._collectUrlLinks(bufferLineNumber, lineText, links, claimed);
    }

    // matchAll on the module-scope global regex clones it internally (per spec)
    // and never mutates lastIndex, so the regex is reused across hover calls
    // without the per-call `new RegExp(FILE_PATH_REGEX)` allocation.
    for (const match of lineText.matchAll(FILE_PATH_REGEX)) {
      const fullMatch = match[1];
      if (fullMatch === undefined) continue;
      if (isPathExcluded(fullMatch)) {
        continue;
      }

      const resolved = resolveFilePathCandidate(fullMatch, this._getCwd());
      if (!resolved) {
        continue;
      }

      const startIndex = match.index + match[0]!.indexOf(fullMatch);
      // A `(` is legal inside a file URL and is also this regex's boundary
      // character, so `file:///tmp/(src/foo.ts` offers `src/foo.ts` as a bare
      // path — which would resolve against the cwd and link a different file
      // than the URL names. Every URL span is claimed whether or not it
      // resolved, so a rejected remote URL can't leak a local link either.
      if (overlapsClaimed(claimed, startIndex, startIndex + fullMatch.length)) {
        continue;
      }
      claimed.push([startIndex, startIndex + fullMatch.length]);

      const range: IBufferRange = {
        start: { x: startIndex + 1, y: bufferLineNumber },
        end: { x: startIndex + fullMatch.length, y: bufferLineNumber },
      };

      links.push(
        new FileLink(
          range,
          fullMatch,
          resolved.absolutePath,
          resolved.line,
          resolved.col,
          this._getCwd(),
          this._onHover
        )
      );
    }

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
    void Promise.race([this._validateDirCandidates(candidates), timeout]).then(
      (confirmed) => {
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
      },
      () => {
        if (this._disposed) return;
        callback(links.length > 0 ? links : undefined);
      }
    );
  }

  /**
   * Scan the logical line for `file://` URLs, appending links and claiming the
   * spans they occupy on `bufferLineNumber`'s own row.
   *
   * Rows are rejoined first because xterm soft-wraps mid-token and the
   * motivating URL — an agent's generated-image path — is long enough to wrap
   * in any tiled terminal. Scanning one row would capture the prefix that
   * happens to end at the margin, and a truncated `file://` URL still parses,
   * so it would link to a real-but-wrong path instead of failing.
   *
   * Spans are claimed for every syntactic match, resolved or not: a rejected
   * remote URL must still shield its own characters from the bare-path pass.
   */
  private _collectUrlLinks(
    bufferLineNumber: number,
    lineText: string,
    links: ILink[],
    claimed: Array<[number, number]>
  ): void {
    const logical = this._readLogicalLine(bufferLineNumber - 1);
    if (!logical) return;
    // The current row's offset into the joined text, for translating a match
    // back into `lineText` coordinates — that's the space `claimed` and the
    // single-row bare-path and directory passes all speak.
    const rowOffset = logical.rowOffsets[bufferLineNumber - 1 - logical.startRow];
    if (rowOffset === undefined) return;

    for (const match of logical.text.matchAll(FILE_URL_REGEX)) {
      const url = match[1];
      if (url === undefined) continue;

      // Indexed off the capture, not `match[0]`: the match also spans the
      // leading boundary character and any trailing sentence punctuation,
      // neither of which the link should underline or own.
      const startIndex = match.index + match[0]!.indexOf(url);
      const endIndex = startIndex + url.length;

      const localStart = startIndex - rowOffset;
      const localEnd = endIndex - rowOffset;
      // A URL wholly on a sibling row still surfaces here (xterm's own web-link
      // provider behaves the same way, and its range keeps it inert until the
      // pointer reaches it) — but it owns no characters on this row to claim.
      if (localEnd > 0 && localStart < lineText.length) {
        claimed.push([Math.max(0, localStart), Math.min(lineText.length, localEnd)]);
      }

      const resolved = resolveFileUrlCandidate(url);
      if (!resolved) continue;

      const start = mapToRow(logical, startIndex);
      const end = mapToRow(logical, endIndex - 1);
      const range: IBufferRange = {
        // xterm rows are 1-based and the end column is inclusive, so `end`
        // addresses the URL's last character rather than the one past it.
        start: { x: start.column + 1, y: start.row + 1 },
        end: { x: end.column + 1, y: end.row + 1 },
      };

      // No line/col: `resolveFileUrlCandidate` deliberately doesn't peel a
      // `:line` suffix off a URL, so there is none to forward.
      links.push(
        new FileLink(
          range,
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
   * Rejoin the soft-wrapped rows around `rowIndex` into the logical line the
   * user actually sees, remembering where each row's text starts so matches
   * can be mapped back to buffer coordinates.
   */
  private _readLogicalLine(rowIndex: number): LogicalLine | null {
    const buffer = this._terminal.buffer.active;
    let startRow = rowIndex;
    // `isWrapped` marks a row as the CONTINUATION of the one above it, so walk
    // up while that holds to find where the logical line begins.
    while (startRow > 0 && buffer.getLine(startRow)?.isWrapped === true) startRow--;

    const rowOffsets: number[] = [];
    let text = "";
    for (let row = startRow; text.length < MAX_LOGICAL_LINE_LENGTH; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      if (row > startRow && line.isWrapped !== true) break;
      rowOffsets.push(text.length);
      text += line.translateToString(true);
    }
    if (rowOffsets.length === 0) return null;
    return { text, startRow, rowOffsets };
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
      const scope = resolveWorktreeScope(candidate.absolutePath, worktrees);
      if (!scope) continue;
      const scoped: ScopedDirCandidate = { ...candidate, ...scope };

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

/**
 * Map an absolute path to the worktree that contains it, longest path first so
 * a nested worktree wins over the repo that hosts it. Returns null for paths
 * outside every known worktree — the file browser is worktree-scoped, so
 * there is nothing to open them in.
 */
function resolveWorktreeScope(
  absolutePath: string,
  worktrees: ReadonlyMap<string, { id: string; path: string }>
): { worktreeId: string; relativePath: string } | null {
  // Separators are normalized to "/" on BOTH sides before comparing, and the
  // relative path is emitted with "/" only: `ancestorDirectories` and the
  // stat-paths op both speak forward slashes, and a Windows cwd would
  // otherwise produce a backslashed rel path that expands nothing.
  const target = absolutePath.replace(/\\/g, "/");
  let best: { worktreeId: string; relativePath: string } | null = null;
  let bestLength = -1;
  for (const worktree of worktrees.values()) {
    const root = worktree.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (root.length <= bestLength) continue;

    // Canonicalized segment-by-segment: `/repo/src/./docs` and `/repo//src`
    // stat fine but as raw strings they never match the tree's `src/docs`
    // keys, and a lingering `..` (which `resolve` should have collapsed, but
    // Windows-joined paths bypass resolve) would make the stat op reject the
    // whole batch. `..` here means the token escapes the root — skip it.
    const segments = target.slice(root.length).split("/").filter(Boolean);
    const canonical: string[] = [];
    let escapes = false;
    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        escapes = true;
        break;
      }
      canonical.push(segment);
    }
    if (escapes) continue;

    bestLength = root.length;
    best = { worktreeId: worktree.id, relativePath: canonical.join("/") };
  }
  return best;
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
