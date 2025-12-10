import { readFile, stat } from "fs/promises";
import { join as pathJoin } from "path";
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

  constructor(
    worktreePath: string,
    enabled: boolean = DEFAULT_CONFIG.note?.enabled ?? true,
    filename: string = DEFAULT_CONFIG.note?.filename ?? "canopy/note"
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
  }

  public async read(): Promise<NoteData | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const gitDir = getGitDir(this.worktreePath, { logErrors: true });
    if (!gitDir) {
      return undefined;
    }

    const notePath = pathJoin(gitDir, this.filename);

    try {
      const fileStat = await stat(notePath);
      const timestamp = fileStat.mtimeMs;

      const content = await readFile(notePath, "utf-8");
      const trimmed = content.trim();

      if (!trimmed) {
        return undefined;
      }

      const lines = trimmed.split("\n");
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.length > 500) {
        return { content: lastLine.slice(0, 497) + "...", timestamp };
      }
      return { content: lastLine, timestamp };
    } catch (error) {
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
