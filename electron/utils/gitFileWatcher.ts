import { watch as fsWatch, FSWatcher, readFileSync } from "fs";
import { join as pathJoin, dirname, isAbsolute } from "path";
import { getGitDir } from "./gitUtils.js";
import { logWarn } from "./logger.js";

export interface GitFileWatcherOptions {
  worktreePath: string;
  branch?: string;
  debounceMs: number;
  onChange: () => void;
}

export class GitFileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly worktreePath: string;
  private readonly debounceMs: number;
  private readonly onChange: () => void;
  private currentBranch?: string;

  constructor(options: GitFileWatcherOptions) {
    this.worktreePath = options.worktreePath;
    this.debounceMs = options.debounceMs;
    this.onChange = options.onChange;
    this.currentBranch = options.branch;
  }

  start(): boolean {
    if (this.disposed) {
      return false;
    }

    const gitDir = getGitDir(this.worktreePath, { cache: true, logErrors: false });
    if (!gitDir) {
      return false;
    }

    try {
      const commonDir = this.resolveCommonDir(gitDir);
      const headPath = pathJoin(gitDir, "HEAD");
      const indexPath = pathJoin(gitDir, "index");

      this.watchFile(headPath);
      this.watchFile(indexPath);

      if (this.currentBranch) {
        const branchRefPath = pathJoin(commonDir, "refs", "heads", this.currentBranch);
        this.watchFile(branchRefPath);
      }

      return true;
    } catch (error) {
      logWarn("Failed to start git file watcher", {
        path: this.worktreePath,
        error: (error as Error).message,
      });
      this.closeWatchers();
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeWatchers();
  }

  private closeWatchers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }

    this.watchers = [];
  }

  private resolveCommonDir(gitDir: string): string {
    try {
      const commondirPath = pathJoin(gitDir, "commondir");
      const commondir = readFileSync(commondirPath, "utf-8").trim();
      return isAbsolute(commondir) ? commondir : pathJoin(gitDir, commondir);
    } catch {
      return gitDir;
    }
  }

  private watchFile(filePath: string): void {
    try {
      const watcher = fsWatch(filePath, { persistent: false }, (_eventType) => {
        this.handleFileChange();
      });

      watcher.on("error", (error) => {
        logWarn("Git file watcher error", {
          path: filePath,
          error: error.message,
        });
      });

      this.watchers.push(watcher);
    } catch {
      const watchDir = dirname(filePath);
      try {
        const dirWatcher = fsWatch(watchDir, { persistent: false }, (_eventType) => {
          this.handleFileChange();
        });

        dirWatcher.on("error", (error) => {
          logWarn("Git directory watcher error", {
            path: watchDir,
            error: error.message,
          });
        });

        this.watchers.push(dirWatcher);
      } catch {
        // Silent fallback to polling
      }
    }
  }

  private handleFileChange(): void {
    if (this.disposed) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.disposed) {
        this.onChange();
      }
    }, this.debounceMs);
  }
}
