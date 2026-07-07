import { readFile, stat } from "fs/promises";
import {
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
} from "path";
import { DEFAULT_CONFIG } from "../../types/config.js";
import { logWarn } from "../../utils/logger.js";
import { getGitDir } from "../../utils/gitUtils.js";

export interface NoteData {
  content: string;
  timestamp: number;
}

export class NoteFileReader {
  private worktreePath: string;
  private enabled: boolean;
  private filename: string;
  // Poll-path cache: `read()` runs every full status poll but the note file
  // rarely changes, so reuse the parsed result while the stat identity
  // (path, mtime, size) matches and skip the readFile.
  private cachedKey: string | undefined;
  private cachedResult: NoteData | undefined;

  constructor(
    worktreePath: string,
    enabled: boolean = DEFAULT_CONFIG.note?.enabled ?? true,
    filename: string = DEFAULT_CONFIG.note?.filename ?? "daintree/note"
  ) {
    this.worktreePath = worktreePath;
    this.enabled = enabled;
    this.filename = filename;
  }

  public setConfig(enabled: boolean, filename?: string): void {
    this.enabled = enabled;
    if (filename !== undefined) {
      this.filename = filename;
    }
    // Config changes re-resolve the note path; drop the cache so a stale
    // (path, mtime, size) key can never serve the previous file's content.
    this.cachedKey = undefined;
    this.cachedResult = undefined;
  }

  private resolveNotePath(gitDir: string): string | undefined {
    if (typeof this.filename !== "string") {
      return undefined;
    }

    const sanitizedFilename = this.filename.trim().replace(/\\/g, "/");
    if (!sanitizedFilename) {
      return undefined;
    }

    if (/^[a-zA-Z]:\//.test(sanitizedFilename)) {
      return undefined;
    }

    const resolved = pathResolve(gitDir, sanitizedFilename);
    const relative = pathRelative(gitDir, resolved);
    if (!relative || relative.startsWith("..") || pathIsAbsolute(relative)) {
      return undefined;
    }

    return resolved;
  }

  public async read(): Promise<NoteData | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const gitDir = await getGitDir(this.worktreePath, { logErrors: true });
    if (!gitDir) {
      return undefined;
    }

    const notePath = this.resolveNotePath(gitDir);
    if (!notePath) {
      logWarn("Invalid AI note filename configuration", {
        path: this.worktreePath,
        filename: this.filename,
      });
      return undefined;
    }

    try {
      const fileStat = await stat(notePath);
      const timestamp = fileStat.mtimeMs;

      const cacheKey = `${notePath}\n${timestamp}\n${fileStat.size}`;
      if (cacheKey === this.cachedKey) {
        return this.cachedResult;
      }

      const content = await readFile(notePath, "utf-8");
      const trimmed = content.trim();

      let result: NoteData | undefined;
      if (trimmed) {
        const lines = trimmed.split("\n");
        const lastLine = lines[lines.length - 1].trim();
        result =
          lastLine.length > 500
            ? { content: lastLine.slice(0, 497) + "...", timestamp }
            : { content: lastLine, timestamp };
      }

      this.cachedKey = cacheKey;
      this.cachedResult = result;
      return result;
    } catch (error) {
      this.cachedKey = undefined;
      this.cachedResult = undefined;
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") {
        logWarn("Failed to read AI note file", {
          path: this.worktreePath,
          error: (error as Error).message,
        });
      }
      return undefined;
    }
  }
}
