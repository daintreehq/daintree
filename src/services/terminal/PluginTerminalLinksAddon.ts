import type { IBufferRange, ILink, ILinkProvider } from "@xterm/xterm";
import { TERMINAL_LINK_SCAN_MAX_CHARS } from "@shared/utils/pluginTerminalLinks";
import type { PluginPatternLinkMatch } from "./pluginTerminalLinks";

export interface PluginTerminalLinkHandlers {
  /** The row's matches; empty when no plugin links are on offer. */
  find: (text: string) => Promise<PluginPatternLinkMatch[]>;
  activate: (match: PluginPatternLinkMatch, event: MouseEvent) => void;
  hover?: (match: PluginPatternLinkMatch, event: MouseEvent) => void;
  leave?: () => void;
}

/** The slice of a terminal the provider reads: one buffer row's cells. */
export interface PluginLinkTerminal {
  readonly buffer: {
    readonly active: {
      getLine(y: number):
        | {
            readonly length: number;
            getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
          }
        | undefined;
    };
  };
}

interface RowText {
  text: string;
  /** First and last buffer column of the cell each code unit was drawn in. */
  startColumns: number[];
  endColumns: number[];
}

/**
 * A row's text as cells, so a match maps back to the columns it was drawn in
 * even past a wide character. Reads just past {@link TERMINAL_LINK_SCAN_MAX_CHARS}
 * code units, so the matcher can tell the row was cut and refuse a match the
 * cut ended; empty cells read as spaces.
 */
function readRow(terminal: PluginLinkTerminal, bufferLineNumber: number): RowText | null {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) return null;
  let text = "";
  const startColumns: number[] = [];
  const endColumns: number[] = [];
  for (let x = 0; x < line.length && text.length <= TERMINAL_LINK_SCAN_MAX_CHARS; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    // The right half of a wide character: its left half carried the text.
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) {
      startColumns.push(x);
      endColumns.push(x + width - 1);
    }
    text += chars;
  }
  return { text, startColumns, endColumns };
}

/**
 * Plugin pattern matchers (#13798) as an xterm link provider. Registered after
 * every built-in provider, so xterm hands any overlap to the built-in one. Runs
 * only when xterm asks for a hovered row's links, never on output, and reads
 * the matchers live through `find` on every ask.
 */
export class PluginTerminalLinksAddon implements ILinkProvider {
  private disposed = false;

  constructor(
    private readonly terminal: PluginLinkTerminal,
    private readonly handlers: PluginTerminalLinkHandlers
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    if (this.disposed) return;
    const row = bufferLineNumber < 1 ? null : readRow(this.terminal, bufferLineNumber);
    if (!row || row.text.trim() === "") {
      callback(undefined);
      return;
    }
    this.handlers.find(row.text).then(
      (matches) => {
        // Disposed while matching: the registration is gone, so the reply has
        // no linkifier to serve.
        if (this.disposed) return;
        // Output may have rewritten the row while the worker ran; links worked
        // out for the old text would underline the new.
        if (matches.length === 0 || readRow(this.terminal, bufferLineNumber)?.text !== row.text) {
          callback(undefined);
          return;
        }
        callback(
          matches.map((match) => {
            const last = match.index + match.text.length - 1;
            const range: IBufferRange = {
              start: { x: row.startColumns[match.index]! + 1, y: bufferLineNumber },
              end: { x: row.endColumns[last]! + 1, y: bufferLineNumber },
            };
            return new PluginPatternLink(range, match, this.handlers, () => this.disposed);
          })
        );
      },
      () => {
        if (!this.disposed) callback(undefined);
      }
    );
  }

  dispose(): void {
    this.disposed = true;
  }
}

// No `hoveredLink` either: that feeds the context menu's "Open link" and "Copy
// link address", and a plugin's identifier is neither a URL nor a path.
// Inert once its provider is disposed: xterm keeps a row's links until the
// pointer leaves the row, and the provider is replaced (re-registered after a
// late built-in) without xterm forgetting them.
class PluginPatternLink implements ILink {
  readonly decorations = { pointerCursor: true, underline: true };
  readonly text: string;

  constructor(
    readonly range: IBufferRange,
    private readonly match: PluginPatternLinkMatch,
    private readonly handlers: PluginTerminalLinkHandlers,
    private readonly isDisposed: () => boolean
  ) {
    this.text = match.text;
  }

  activate(event: MouseEvent): void {
    if (!this.isDisposed()) this.handlers.activate(this.match, event);
  }

  hover(event: MouseEvent): void {
    if (!this.isDisposed()) this.handlers.hover?.(this.match, event);
  }

  leave(): void {
    this.handlers.leave?.();
  }
}
