import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { systemClient } from "@/clients";
import * as path from "path-browserify";

interface ResolvedFilePath {
  absolutePath: string;
  line?: number;
  col?: number;
}

const FILE_PATH_REGEX =
  /(?:^|[\s(])((?:\/[\w./-]+|[a-zA-Z]:[\\/][\w./\\-]+|(?:\.\.?[\\/])+[\w./\\-]+|[\w-]+[\\/][\w./\\-]+)\.[\w]+(?::\d+(?::\d+)?)?)/g;

const WINDOWS_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

export class FileLinksAddon implements ILinkProvider {
  private _terminal: Terminal;
  private _getCwd: () => string;

  constructor(terminal: Terminal, getCwd: () => string) {
    this._terminal = terminal;
    this._getCwd = getCwd;
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
    const regex = new RegExp(FILE_PATH_REGEX);
    let match;

    while ((match = regex.exec(lineText)) !== null) {
      const fullMatch = match[1];
      if (this._isExcluded(fullMatch)) {
        continue;
      }

      const resolved = this._resolveFilePath(fullMatch);
      if (!resolved) {
        continue;
      }

      const startIndex = match.index + match[0].indexOf(fullMatch);

      const range: IBufferRange = {
        start: { x: startIndex + 1, y: bufferLineNumber },
        end: { x: startIndex + fullMatch.length, y: bufferLineNumber },
      };

      links.push(new FileLink(range, fullMatch, resolved.absolutePath));
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
    const match = /^(.*)(?::(\d+)(?::(\d+))?)?$/.exec(text);
    if (!match) return null;
    const pathPart = match[1];
    const linePart = match[2] ? Number(match[2]) : undefined;
    const colPart = match[3] ? Number(match[3]) : undefined;

    let absolutePath: string;

    if (path.isAbsolute(pathPart) || WINDOWS_ABS.test(pathPart)) {
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
        absolutePath = path.resolve(cwd, pathPart);
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
  constructor(
    public range: IBufferRange,
    public text: string,
    private _absolutePath: string
  ) {}

  activate(_event: MouseEvent, _text: string): void {
    systemClient.openPath(this._absolutePath).catch((error) => {
      console.error("[FileLinksAddon] Failed to open file:", this._absolutePath, error);
    });
  }

  hover?(_event: MouseEvent, _text: string): void {}

  leave?(_event: MouseEvent, _text: string): void {}

  dispose?(): void {}
}
