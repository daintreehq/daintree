import { watch as fsWatch, FSWatcher, readFileSync } from "fs";
import { join as pathJoin, dirname, isAbsolute, basename, normalize as pathNormalize } from "path";
import parcelWatcher from "@parcel/watcher";
import { getGitDir } from "./gitUtils.js";
import { OPERATION_SENTINEL_NAMES } from "./gitRepoOperationState.js";
import { logWarn } from "./logger.js";

const LINUX_INOTIFY_LIMIT_HELP =
  "inotify watch limit reached — file watching may be incomplete. " +
  "Temporary fix: sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512. " +
  "Permanent fix: echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-inotify.conf && sudo sysctl --system";

const MACOS_EMFILE_LIMIT_HELP =
  "FSEvents file descriptor ceiling reached — recursive file watching may be incomplete. " +
  "Temporary fix: sudo launchctl limit maxfiles 65536 524288. " +
  "Permanent fix: create /Library/LaunchDaemons/limit.maxfiles.plist (see launchd.plist(5)). " +
  "/etc/sysctl.conf may not be respected on macOS 14+.";

/**
 * Native ignore globs for the parcel file watcher.
 * Each bare directory name maps to a glob matching at any depth.
 * .git is included for both the bare worktree pointer file and
 * all child paths, replacing the old JS-side prefix check.
 */
const WORKTREE_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/target/**",
  "**/coverage/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/out/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/.git",
  "**/.git/**",
];

export interface GitFileWatcherOptions {
  worktreePath: string;
  branch?: string;
  debounceMs: number;
  onChange: () => void;
  /** Watch the working tree recursively for file edits (macOS FSEvents). */
  watchWorktree?: boolean;
  /** Minimum debounce delay for worktree events — first event in a burst fires at this delay. */
  worktreeMinDebounceMs?: number;
  /** Maximum debounce delay for worktree events — sustained bursts ramp up to this. */
  worktreeMaxDebounceMs?: number;
  /** Max wait ceiling for worktree debounce — forces a flush during sustained bursts. */
  worktreeMaxWaitMs?: number;
  /** Called when the recursive worktree watcher fails because of the Linux
   *  inotify watch limit (ENOSPC) or macOS FSEvents fd ceiling (EMFILE). */
  onWatcherFailed?: () => void;
  /** Called when the recursive worktree watcher fails specifically because of
   *  the Linux inotify watch limit (ENOSPC). Fires in addition to `onWatcherFailed`. */
  onInotifyLimitReached?: () => void;
  /** Called when the recursive worktree watcher fails specifically because of
   *  the macOS FSEvents file descriptor ceiling (EMFILE). Fires in addition to
   *  `onWatcherFailed`. */
  onEmfileLimitReached?: () => void;
}

export class GitFileWatcher {
  private watchers: FSWatcher[] = [];
  private readonly watchedFilesByDirectory = new Map<string, Set<string>>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private worktreeDebounceTimer: NodeJS.Timeout | null = null;
  private worktreeMaxWaitTimer: NodeJS.Timeout | null = null;
  private worktreeBurstCount = 0;
  private disposed = false;
  private worktreeSubscription: { unsubscribe(): Promise<void> } | null = null;
  private readonly worktreePath: string;
  private readonly debounceMs: number;
  private readonly worktreeMinDebounceMs: number;
  private readonly worktreeMaxDebounceMs: number;
  private readonly worktreeMaxWaitMs: number | undefined;
  /** Per-event ramp applied inside the min..max range. Private tuning constant. */
  private readonly worktreeDebounceRampMs = 10;
  private readonly onChange: () => void;
  private readonly onWatcherFailed: (() => void) | undefined;
  private readonly onInotifyLimitReached: (() => void) | undefined;
  private readonly onEmfileLimitReached: (() => void) | undefined;
  private readonly watchWorktree: boolean;
  private currentBranch?: string;

  constructor(options: GitFileWatcherOptions) {
    this.worktreePath = options.worktreePath;
    this.debounceMs = options.debounceMs;
    this.worktreeMinDebounceMs = options.worktreeMinDebounceMs ?? options.debounceMs;
    this.worktreeMaxDebounceMs = options.worktreeMaxDebounceMs ?? this.worktreeMinDebounceMs;
    this.worktreeMaxWaitMs = options.worktreeMaxWaitMs;
    this.onChange = options.onChange;
    this.onWatcherFailed = options.onWatcherFailed;
    this.onInotifyLimitReached = options.onInotifyLimitReached;
    this.onEmfileLimitReached = options.onEmfileLimitReached;
    this.currentBranch = options.branch;
    this.watchWorktree = options.watchWorktree ?? false;
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

      this.watchFile(headPath);
      this.watchFile(pathJoin(commonDir, "packed-refs"));
      this.watchFile(pathJoin(commonDir, "logs", "HEAD"));
      // Watch .git/config so `git push -u` / `git branch --set-upstream-to`
      // triggers a poll deterministically — without this the new tracking
      // info from `git status` only surfaces on the next timed poll.
      this.watchFile(pathJoin(commonDir, "config"));

      // For linked worktrees, the per-worktree reflog lives under gitDir, not commonDir.
      // Watch it so branch changes in linked worktrees trigger the onChange callback.
      // Normalize both paths before comparing to avoid false mismatches from trailing
      // slashes or non-canonical separators.
      if (pathNormalize(gitDir) !== pathNormalize(commonDir)) {
        this.watchFile(pathJoin(gitDir, "logs", "HEAD"));
      }

      if (this.currentBranch) {
        const branchRefPath = pathJoin(commonDir, "refs", "heads", this.currentBranch);
        this.watchFile(branchRefPath);
      }

      // Track rebase/merge/cherry-pick/revert sentinel files so the watcher
      // wakes immediately when an operation starts or finishes. The sentinels
      // live in gitDir alongside HEAD, so this reuses the existing dir watcher.
      for (const sentinelName of OPERATION_SENTINEL_NAMES) {
        this.watchFile(pathJoin(gitDir, sentinelName));
      }

      // Watch .git/index so external `git add` from a terminal triggers an
      // event-based refresh instead of waiting for the next timed poll.
      // matchesTrackedFile() already covers the index.lock → index rename
      // pattern git uses for atomic index writes.
      this.watchFile(pathJoin(gitDir, "index"));

      if (this.watchWorktree) {
        // Fire-and-forget: subscribe() schedules the native watcher
        // asynchronously. Startup failures (ENOSPC, EMFILE) route through
        // onWatcherFailed / onInotifyLimitReached / onEmfileLimitReached
        // callbacks when the Promise rejects. WatcherController.handleWatcherFailed()
        // is already designed for async callback delivery.
        this.startWorktreeWatcher();
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
    if (this.worktreeDebounceTimer) {
      clearTimeout(this.worktreeDebounceTimer);
      this.worktreeDebounceTimer = null;
    }
    if (this.worktreeMaxWaitTimer) {
      clearTimeout(this.worktreeMaxWaitTimer);
      this.worktreeMaxWaitTimer = null;
    }
    this.worktreeBurstCount = 0;

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors — watcher handle may be stale on Windows
        // (directory-deletion or double-close race causes EPERM)
      }
    }

    this.watchers = [];
    this.watchedFilesByDirectory.clear();

    if (this.worktreeSubscription) {
      this.worktreeSubscription.unsubscribe().catch(() => {
        // Subscription already torn down (double-close or native teardown race)
      });
      this.worktreeSubscription = null;
    }
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

  private startWorktreeWatcher(): void {
    // The parcel file watcher silently drops overflow events on all platforms
    // (macOS kFSEventStreamEventFlagMustScanSubDirs, Linux IN_Q_OVERFLOW,
    // Windows ERROR_NOTIFY_ENUM_DIR). There is no equivalent to fs.watch's
    // null-filename "global dirty" signal. Mitigation: WorktreeMonitor's
    // 10s polling fallback catches missed events. On macOS, the primary
    // overflow trigger — libuv FSEvents per-directory fd exhaustion — is
    // eliminated by the single-stream-per-subtree design.
    parcelWatcher
      .subscribe(
        this.worktreePath,
        (err, events) => {
          if (err) {
            this.handleWorktreeWatcherError(err, "runtime");
            return;
          }
          if (this.disposed || !events || events.length === 0) return;
          // Per-event iteration preserves the burstCount-driven adaptive
          // debounce ramp: 100 files in a batch -> burstCount=100 -> maxDebounce.
          for (let i = 0; i < events.length; i++) {
            this.handleWorktreeChange();
          }
        },
        { ignore: WORKTREE_IGNORE_GLOBS }
      )
      .then((sub) => {
        if (this.disposed) {
          sub.unsubscribe();
        } else {
          this.worktreeSubscription = sub;
        }
      })
      .catch((error: unknown) => {
        this.handleWorktreeWatcherError(error, "startup");
      });
  }

  private handleWorktreeWatcherError(error: unknown, phase: "startup" | "runtime"): void {
    if (this.disposed) return;
    const err = error as NodeJS.ErrnoException;
    const code = err?.code;
    const message = err?.message ?? "";

    if (process.platform === "linux" && code === "ENOSPC") {
      logWarn(LINUX_INOTIFY_LIMIT_HELP, { path: this.worktreePath });
      this.onInotifyLimitReached?.();
      this.onWatcherFailed?.();
      return;
    }

    if (process.platform === "darwin") {
      // The parcel file watcher uses native FSEvents directly (no per-directory
      // fd) so EMFILE from per-directory exhaustion is eliminated. The check
      // stays for the rare case where the system-wide fd ceiling is hit
      // (FSEventStreamStart returns a CoreServices error string, not an
      // errno code). Primary gate on .code === 'EMFILE'; fallback to
      // message matching for platform-error-string variants.
      const isEmfile = code === "EMFILE" || /file.*descriptor|descriptor.*limit/i.test(message);
      if (isEmfile) {
        logWarn(MACOS_EMFILE_LIMIT_HELP, { path: this.worktreePath });
        this.onEmfileLimitReached?.();
        this.onWatcherFailed?.();
        return;
      }
    }

    logWarn(`Worktree recursive watcher error (${phase})`, {
      path: this.worktreePath,
      error: message,
    });
    if (phase === "startup") {
      this.onWatcherFailed?.();
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
          this.handleGitFileChange();
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

  /** Handle git-internal file changes (HEAD, refs, reflog). Fast debounce. */
  private handleGitFileChange(): void {
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

  /**
   * Handle working tree file changes with an adaptive debounce. The first event
   * in a burst fires at `worktreeMinDebounceMs`; each subsequent event adds
   * `worktreeDebounceRampMs` to the pending delay up to `worktreeMaxDebounceMs`.
   * A `worktreeMaxWaitMs` ceiling forces a flush during sustained bursts.
   */
  private handleWorktreeChange(): void {
    if (this.disposed) {
      return;
    }

    this.worktreeBurstCount++;
    const delay = Math.min(
      this.worktreeMaxDebounceMs,
      this.worktreeMinDebounceMs + (this.worktreeBurstCount - 1) * this.worktreeDebounceRampMs
    );

    if (this.worktreeDebounceTimer) {
      clearTimeout(this.worktreeDebounceTimer);
    }
    this.worktreeDebounceTimer = setTimeout(() => this.flushWorktreeChange(), delay);

    if (this.worktreeMaxWaitMs != null && !this.worktreeMaxWaitTimer) {
      this.worktreeMaxWaitTimer = setTimeout(
        () => this.flushWorktreeChange(),
        this.worktreeMaxWaitMs
      );
    }
  }

  private flushWorktreeChange(): void {
    if (this.worktreeDebounceTimer) {
      clearTimeout(this.worktreeDebounceTimer);
      this.worktreeDebounceTimer = null;
    }
    if (this.worktreeMaxWaitTimer) {
      clearTimeout(this.worktreeMaxWaitTimer);
      this.worktreeMaxWaitTimer = null;
    }
    this.worktreeBurstCount = 0;
    if (!this.disposed) {
      this.onChange();
    }
  }
}
