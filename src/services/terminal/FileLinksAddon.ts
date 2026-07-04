import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { systemClient } from "@/clients";
import { basename, isAbsolute, resolve } from "@shared/utils/path";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { isClientAppError } from "@/utils/clientAppError";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { TerminalLink } from "./types";

interface ResolvedFilePath {
  absolutePath: string;
  line?: number;
  col?: number;
}

const FILE_PATH_REGEX =
  /(?:^|[\s(])((?:\\\\wsl(?:\$|\.localhost)\\[^\\]+(?:\\[\w.-]+)+|\/[\w./-]+|[a-zA-Z]:[\\/][\w./\\-]+|(?:\.\.?[\\/])+[\w./\\-]+|[\w-]+[\\/][\w./\\-]+)\.[\w]+(?::\d+(?::\d+)?)?)/g;

const WINDOWS_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

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
export function reportFileLinkFailure(reason: string, error: unknown, absolutePath: string): void {
  const code = isClientAppError(error) ? error.code : undefined;
  const userMessage = isClientAppError(error) ? error.userMessage : undefined;

  let body: string;
  switch (code) {
    case "OUTSIDE_ROOT":
      body = "Path is outside your project roots";
      break;
    case "INVALID_PATH":
      body = "Path is not a valid file";
      break;
    default:
      body = userMessage ?? formatErrorMessage(error, "Couldn't open this file");
  }

  const name = basename(absolutePath) || absolutePath || "file";
  const singleMessage = `${body} (${name})`;
  const isOutsideRoot = code === "OUTSIDE_ROOT";
  const coalesceKey = isOutsideRoot
    ? `${FILE_LINK_ACTIVATION_COALESCE_KEY}:outside-root`
    : FILE_LINK_ACTIVATION_COALESCE_KEY;
  const action = isOutsideRoot
    ? {
        label: "Reveal in File Manager",
        onClick: () => {
          void systemClient.showItemInFolderUnconfined(absolutePath).catch((revealError) => {
            logError("[FileLinksAddon] Failed to reveal out-of-root file link", revealError, {
              absolutePath,
            });
          });
        },
      }
    : {
        label: "Copy path",
        onClick: () => {
          if (!navigator.clipboard) return;
          void navigator.clipboard.writeText(absolutePath).catch(() => {
            /* clipboard unavailable — sticky toast is the durable surface */
          });
        },
      };

  notify({
    type: "error",
    title: "Couldn't open file link",
    message: singleMessage,
    priority: "high",
    context: { eventKind: "uiFeedback" },
    coalesce: {
      key: coalesceKey,
      windowMs: 1500,
      buildTitle: (count) =>
        count <= 1 ? "Couldn't open file link" : `Couldn't open ${count} file links`,
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

export class FileLinksAddon implements ILinkProvider {
  private _terminal: Terminal;
  private _getCwd: () => string;
  private _onHover?: HoverCallback;

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

    // matchAll on the module-scope global regex clones it internally (per spec)
    // and never mutates lastIndex, so the regex is reused across hover calls
    // without the per-call `new RegExp(FILE_PATH_REGEX)` allocation.
    for (const match of lineText.matchAll(FILE_PATH_REGEX)) {
      const fullMatch = match[1];
      if (fullMatch === undefined) continue;
      if (this._isExcluded(fullMatch)) {
        continue;
      }

      const resolved = this._resolveFilePath(fullMatch);
      if (!resolved) {
        continue;
      }

      const startIndex = match.index + match[0]!.indexOf(fullMatch);

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

    callback(links.length > 0 ? links : undefined);
  }

  private _isExcluded(text: string): boolean {
    if (text.includes("://")) {
      return true;
    }
    if (text.includes("\x1b")) {
      return true;
    }
    return false;
  }

  private _resolveFilePath(text: string): ResolvedFilePath | null {
    const match = /^(.*\.[^\s:]+?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
    if (!match) return null;
    const pathPart = match[1];
    if (pathPart === undefined) return null;
    const linePart = match[2] ? Number(match[2]) : undefined;
    const colPart = match[3] ? Number(match[3]) : undefined;

    let absolutePath: string;

    if (isAbsolute(pathPart)) {
      absolutePath = pathPart;
    } else {
      const cwd = this._getCwd();
      if (!cwd) {
        return null;
      }
      if (WINDOWS_ABS.test(cwd)) {
        const sep = cwd.includes("\\") ? "\\" : "/";
        absolutePath = `${cwd.replace(/[\\/]+$/, "")}${sep}${pathPart.replace(/[\\/]+/g, sep)}`;
      } else {
        absolutePath = resolve(cwd, pathPart);
      }
    }

    return {
      absolutePath,
      line: linePart,
      col: colPart,
    };
  }

  dispose(): void {}
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
