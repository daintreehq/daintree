import type { ManagedTerminal } from "./types";

export const RECOVERY_NOTICE_MESSAGE = "Terminal backend reconnected";

/** The xterm state the overlay is placed from. */
export interface RecoveryNoticeSurface {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number } };
  readonly modes: { readonly wraparoundMode: boolean };
}

/**
 * How long a respawned PTY's output must stay quiet before the notice goes in.
 * ConPTY paints a new console's first frame as a few writes milliseconds apart;
 * this outlasts that burst without making the notice feel late.
 */
export const RECOVERY_NOTICE_QUIET_MS = 200;

/**
 * The longest a pane waits on its respawned PTY. A shell that never paints
 * still gets told the backend came back, just later.
 */
export const RECOVERY_NOTICE_CAP_MS = 8_000;

const VT_ESCAPE =
  // eslint-disable-next-line no-control-regex -- matches VT escape sequences to find the printable text between them
  /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[\x20-\x2f]*[\x30-\x7e])/g;
// eslint-disable-next-line no-control-regex -- anything that is not a C0/C1 control or a space
const VISIBLE_CHAR = /[^\x00-\x20\x7f-\x9f]/;

const utf8 = new TextDecoder();

/**
 * Whether a chunk draws text, as opposed to only setting modes, titles or the
 * cursor. A new ConPTY announces its input modes before the console has
 * painted anything, so the first chunk alone is no sign the screen is drawn.
 */
export function hasVisibleText(data: string | Uint8Array): boolean {
  const text = typeof data === "string" ? data : utf8.decode(data);
  return VISIBLE_CHAR.test(text.replace(VT_ESCAPE, ""));
}

// An upper bound on cells: nothing below U+1100 is wide, and counting
// everything above it as two only ever truncates more than needed.
function cellWidthUpperBound(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  return width;
}

function fitNotice(timestamp: string, width: number): string | null {
  if (width <= 0) return null;
  for (const candidate of [`[${timestamp}] ${RECOVERY_NOTICE_MESSAGE}`, RECOVERY_NOTICE_MESSAGE]) {
    if (cellWidthUpperBound(candidate) <= width) return candidate;
  }
  return RECOVERY_NOTICE_MESSAGE.slice(0, width);
}

/**
 * The notice as an overlay that leaves the cursor exactly where ConPTY put it.
 * ConPTY owns the screen model and positions everything relative to the cursor
 * it believes in, so nothing here may move it or scroll: the cursor is saved
 * and restored around the write, it goes on the row below the cursor (or to
 * the right of it on the last row) with a relative move that cannot scroll, and
 * autowrap is off while it prints so no width miscount can spill to a new line.
 * The row stays ConPTY's: its next repaint there clears the notice.
 */
export function composeRecoveryNoticeOverlay(
  terminal: RecoveryNoticeSurface,
  timestamp: string
): string | null {
  const { cols, rows } = terminal;
  const { cursorX, cursorY } = terminal.buffer.active;
  const onLastRow = cursorY >= rows - 1;
  const text = fitNotice(timestamp, onLastRow ? cols - cursorX - 1 : cols);
  if (text === null) return null;
  const move = onLastRow ? "\x1b[1C" : "\x1b[1B\r";
  const wrapOff = terminal.modes.wraparoundMode ? "\x1b[?7l" : "";
  const wrapOn = wrapOff ? "\x1b[?7h" : "";
  return `\x1b7${wrapOff}${move}\x1b[0;33m${text}\x1b[0m${wrapOn}\x1b8`;
}

interface PendingRecoveryNotice {
  managed: ManagedTerminal;
  timestamp: string;
  sawText: boolean;
  capTimer: ReturnType<typeof setTimeout>;
  quietTimer?: ReturnType<typeof setTimeout>;
}

export interface TerminalRecoveryNoticeControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  /** Output for this pane that has reached the renderer but not yet been parsed. */
  hasUnparsedOutput: (id: string, managed: ManagedTerminal) => boolean;
  writeLocal: (managed: ManagedTerminal, data: string) => void;
}

/**
 * Holds each pane's "backend reconnected" notice until its respawned ConPTY
 * has drawn its first frame (W-032). That frame repaints every row of the
 * viewport, so a notice written when the backend comes back is erased before
 * anyone sees it. Windows only: elsewhere the notice is written at once.
 */
export class TerminalRecoveryNoticeController {
  private readonly pending = new Map<string, PendingRecoveryNotice>();

  constructor(private readonly deps: TerminalRecoveryNoticeControllerDeps) {}

  schedule(id: string, managed: ManagedTerminal, timestamp: string): void {
    this.cancel(id);
    const notice: PendingRecoveryNotice = {
      managed,
      timestamp,
      sawText: false,
      capTimer: setTimeout(() => this.flush(id, notice), RECOVERY_NOTICE_CAP_MS),
    };
    this.pending.set(id, notice);
  }

  /** PTY output for `id` is on its way into xterm. */
  noteOutput(id: string, data: string | Uint8Array): void {
    if (this.pending.size === 0) return;
    const notice = this.pending.get(id);
    if (!notice) return;
    if (!notice.sawText) {
      if (!hasVisibleText(data)) return;
      notice.sawText = true;
    }
    this.armQuietTimer(id, notice);
  }

  cancel(id: string): void {
    const notice = this.pending.get(id);
    if (!notice) return;
    clearTimeout(notice.capTimer);
    if (notice.quietTimer !== undefined) clearTimeout(notice.quietTimer);
    this.pending.delete(id);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private armQuietTimer(id: string, notice: PendingRecoveryNotice): void {
    if (notice.quietTimer !== undefined) clearTimeout(notice.quietTimer);
    notice.quietTimer = setTimeout(() => {
      notice.quietTimer = undefined;
      if (this.deps.hasUnparsedOutput(id, notice.managed)) {
        this.armQuietTimer(id, notice);
        return;
      }
      this.flush(id, notice);
    }, RECOVERY_NOTICE_QUIET_MS);
  }

  private flush(id: string, notice: PendingRecoveryNotice): void {
    if (this.pending.get(id) !== notice) return;
    this.cancel(id);
    if (this.deps.getInstance(id) !== notice.managed) return;
    const overlay = composeRecoveryNoticeOverlay(notice.managed.terminal, notice.timestamp);
    if (overlay !== null) this.deps.writeLocal(notice.managed, overlay);
  }
}
