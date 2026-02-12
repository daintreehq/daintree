import { watch as fsWatch, FSWatcher, readFileSync } from "fs";
import { join as pathJoin, dirname, isAbsolute, basename } from "path";
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
  private readonly watchedFilesByDirectory = new Map<string, Set<string>>();
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
      this.watchFile(pathJoin(commonDir, "packed-refs"));

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
    this.watchedFilesByDirectory.clear();
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
    const watchDir = dirname(filePath);
    const fileName = basename(filePath);
    const watchedFiles = this.watchedFilesByDirectory.get(watchDir);

    if (watchedFiles) {
      watchedFiles.add(fileName);
      return;
    }

    try {
      const trackedFiles = new Set<string>([fileName]);
      const watcher = fsWatch(watchDir, { persistent: false }, (_eventType, changedFileName) => {
        if (this.shouldHandleDirectoryEvent(changedFileName, trackedFiles)) {
          this.handleFileChange();
        }
      });

      watcher.on("error", (error) => {
        logWarn("Git directory watcher error", {
          path: watchDir,
          error: error.message,
        });
      });

      this.watchers.push(watcher);
      this.watchedFilesByDirectory.set(watchDir, trackedFiles);
    } catch {
      // Silent fallback to polling
    }
  }

  private shouldHandleDirectoryEvent(
    changedFileName: string | Buffer | null,
    trackedFiles: Set<string>
  ): boolean {
    if (!changedFileName) {
      return true;
    }

    const changedName = changedFileName.toString().replaceAll("\\", "/");
    for (const trackedFile of trackedFiles) {
      if (this.matchesTrackedFile(changedName, trackedFile)) {
        return true;
      }
    }

    return false;
  }

  private matchesTrackedFile(changedName: string, trackedFile: string): boolean {
    if (changedName === trackedFile || changedName === `${trackedFile}.lock`) {
      return true;
    }

    if (changedName.endsWith(`/${trackedFile}`) || changedName.endsWith(`/${trackedFile}.lock`)) {
      return true;
    }

    return false;
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
