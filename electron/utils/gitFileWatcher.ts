import { watch as fsWatch, FSWatcher } from "fs";
import { readFile } from "fs/promises";
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
/** Name of the git config file inside the common dir. */
const GIT_CONFIG_FILE_NAME = "config";

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
  // Python/Java agent-tooling cache dirs not covered by __pycache__/.venv.
  // Writes here during sustained tool runs would otherwise trigger a forced
  // full status chain (~3-5 git spawns) on every debounce flush.
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.gradle/**",
  "**/.git",
  "**/.git/**",
];

export interface GitFileWatcherOptions {
  worktreePath: string;
  branch?: string;
  debounceMs: number;
  onChange: () => void;
  /**
   * Fired alongside `onChange` when the flushed burst included a write to
   * `.git/config` — the file `git remote add` / `set-url` / `remove` edits.
   * Separate from `onChange` because re-reading the repo's remotes costs a git
   * subprocess: gating it on the specific file keeps the cost at one spawn per
   * config write instead of one per status pass (#9997).
   */
  onGitConfigChanged?: () => void;
  /**
   * Fired once per recursive-worktree flush — a raw filesystem write happened,
   * regardless of whether git status content changed. Rides the existing
   * adaptive-burst debounce (never the git-internal path), so it inherits the
   * same coalescing as `onChange`. Drives the file browser's live refresh when
   * a write lands in a gitignored path that leaves `git status` unchanged
   * (#11330).
   */
  onWorktreeFilesChanged?: () => void;
  /** Watch the working tree recursively for file edits (macOS FSEvents). */
  watchWorktree?: boolean;
  /** Minimum debounce delay for worktree events — first event in a burst fires at this delay. */
  worktreeMinDebounceMs?: number;
  /** Maximum debounce delay for worktree events — sustained bursts ramp up to this. */
  worktreeMaxDebounceMs?: number;
  /** Max wait ceiling for worktree debounce — forces a flush during sustained bursts. */
  worktreeMaxWaitMs?: number;
  /** Leading-edge fast path: when worktree events arrive after at least
   *  `worktreeQuietWindowMs` of flush-free quiet, the first flush fires after
   *  this short delay instead of `worktreeMinDebounceMs`, so an isolated edit
   *  surfaces almost immediately. A burst that keeps producing events resets
   *  the timer onto the adaptive trailing ramp, preserving coalescing. */
  worktreeLeadingDebounceMs?: number;
  /** Quiet period (since the last worktree flush) that re-arms the
   *  leading-edge fast path. Defaults to 2000ms. */
  worktreeQuietWindowMs?: number;
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

/**
 * Distinguish @parcel/watcher's non-fatal "you missed some events, re-scan"
 * signal from a genuine subscription failure. Only the macOS FSEvents backend
 * emits it (for `kFSEventStreamEventFlagMustScanSubDirs` and its kernel/client
 * drop variants), and only through the channel that leaves the subscription
 * alive. Windows' superficially similar "Buffer overflow. Some events may have
 * been lost." travels the fatal channel instead, so it must NOT match here.
 */
function isRescanRequest(message: string): boolean {
  return /must be re-scanned/i.test(message);
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
  private readonly worktreeLeadingDebounceMs: number | undefined;
  private readonly worktreeQuietWindowMs: number;
  private lastWorktreeFlushAt = 0;
  /** Per-event ramp applied inside the min..max range. Private tuning constant. */
  private readonly worktreeDebounceRampMs = 10;
  private readonly onChange: () => void;
  private readonly onGitConfigChanged: (() => void) | undefined;
  private readonly onWorktreeFilesChanged: (() => void) | undefined;
  /** Set when the current (unflushed) burst touched `.git/config`. */
  private gitConfigChangePending = false;
  /** Directory holding `.git/config` — always the common dir. */
  private gitConfigDir: string | null = null;
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
    this.worktreeLeadingDebounceMs = options.worktreeLeadingDebounceMs;
    this.worktreeQuietWindowMs = options.worktreeQuietWindowMs ?? 2_000;
    this.onChange = options.onChange;
    this.onGitConfigChanged = options.onGitConfigChanged;
    this.onWorktreeFilesChanged = options.onWorktreeFilesChanged;
    this.onWatcherFailed = options.onWatcherFailed;
    this.onInotifyLimitReached = options.onInotifyLimitReached;
    this.onEmfileLimitReached = options.onEmfileLimitReached;
    this.currentBranch = options.branch;
    this.watchWorktree = options.watchWorktree ?? false;
  }

  async start(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const gitDir = await getGitDir(this.worktreePath, { cache: true, logErrors: false });
    if (this.disposed || !gitDir) {
      return false;
    }

    try {
      const commonDir = await this.resolveCommonDir(gitDir);
      // Re-check after the async resolution: a dispose() during the await
      // must not arm watchers that nothing will ever close.
      if (this.disposed) {
        return false;
      }
      const headPath = pathJoin(gitDir, "HEAD");

      this.watchFile(headPath);
      this.watchFile(pathJoin(commonDir, "packed-refs"));
      this.watchFile(pathJoin(commonDir, "logs", "HEAD"));
      // Watch .git/config so `git push -u` / `git branch --set-upstream-to`
      // triggers a poll deterministically — without this the new tracking
      // info from `git status` only surfaces on the next timed poll.
      // Also the file `git remote add` writes, which is what drives
      // onGitConfigChanged (#11155).
      this.gitConfigDir = commonDir;
      this.watchFile(pathJoin(commonDir, GIT_CONFIG_FILE_NAME));

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

      // Watch loose remote-tracking refs under refs/remotes/origin so an
      // external `git fetch` — from a terminal, or any tool outside Daintree's
      // own fetch scheduler — that advances origin/<branch> triggers a status
      // pass. The behind-count then updates, driving the forge-count recheck
      // (#11151). Non-recursive on purpose: the default branch's ref (e.g.
      // refs/remotes/origin/main) sits at the top level here, and recursive
      // fs.watch is unreliable and inotify-limit-prone on Linux. packed-refs
      // (watched above) covers the post-`git gc` packed case; nested
      // feature-branch remote refs don't affect the repo-level toolbar counts.
      this.watchRemoteRefsDir(pathJoin(commonDir, "refs", "remotes", "origin"));

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
    this.gitConfigChangePending = false;

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

  private async resolveCommonDir(gitDir: string): Promise<string> {
    try {
      const commondirPath = pathJoin(gitDir, "commondir");
      const commondir = (await readFile(commondirPath, "utf-8")).trim();
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
          // Passing the batch size preserves the burstCount-driven adaptive
          // debounce ramp (100 files in a batch -> burstCount=100 ->
          // maxDebounce) while clearing/setting the debounce timer once per
          // batch instead of once per event.
          this.handleWorktreeChange(events.length);
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

    if (isRescanRequest(message)) {
      // @parcel/watcher has two error channels and they mean opposite things.
      // This one is `EventList::error()` (macOS FSEvents `MustScanSubDirs`),
      // delivered through `Watcher::triggerCallbacks` — the callbacks stay
      // installed and the stream keeps running. It reports dropped events, not
      // a dead watcher. Tearing the subscription down here would rebuild a
      // healthy FSEvents stream under exactly the file churn that provokes the
      // overflow, and would burn the controller's bounded re-arm budget until
      // the worktree stranded on the git-only fallback. Events WERE lost
      // though, so force a refresh instead of ignoring it.
      this.handleGitFileChange();
      return;
    }

    // Everything else arrives via `Watcher::notifyError`, which calls back and
    // then `clearCallbacks()` — the subscription is dead and will never deliver
    // another event. Runtime failures therefore have to downgrade, not just
    // startup ones: leaving a dead watcher in place let the controller keep
    // claiming "recursive" (and its 5-minute heartbeat cadence) over a watcher
    // observing nothing (#12042). Deliberately not gated on errno — Windows
    // reports its failure modes (ReadDirectoryChangesW buffer overflow, an
    // AV/indexer lock, an ancestor rename) as message-only errors, so matching
    // codes would leave the reporting platform uncovered. The linux/darwin
    // branches above stay for their user-facing limit messaging, not for the
    // downgrade itself.
    this.onWatcherFailed?.();
  }

  /**
   * Watch a git-internal directory for *any* change and route it through the
   * fast debounce. Used for refs/remotes/origin, where the relevant events are
   * loose-ref writes (and their `.lock` churn) from a fetch rather than a fixed
   * set of tracked filenames — so unlike `watchFile`, every event in the
   * directory is a conservative "refs may have moved" signal.
   */
  private watchRemoteRefsDir(dirPath: string): void {
    try {
      const watcher = fsWatch(dirPath, { persistent: false }, () => {
        this.handleGitFileChange();
      });

      watcher.on("error", (error) => {
        logWarn("Git remote-refs watcher error", {
          path: dirPath,
          error: error.message,
        });
      });

      this.watchers.push(watcher);
    } catch {
      // The directory may not exist yet (no fetch has written loose remote
      // refs, or they are all packed). Silent fallback: packed-refs watching,
      // Daintree's own fetch-triggered status refresh, and the timed poll
      // still cover origin movement.
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
          if (this.isGitConfigEvent(watchDir, changedFileName)) {
            this.gitConfigChangePending = true;
          }
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

  /**
   * Whether a directory event names `.git/config` (or its `.lock` twin — git
   * writes the file lock-then-rename, so both land in the burst). Only the
   * common dir holds the config, so events from the per-worktree gitDir are
   * never config writes even when a same-named file appears there.
   */
  private isGitConfigEvent(watchDir: string, changedFileName: string | Buffer | null): boolean {
    if (this.gitConfigDir === null) return false;
    if (pathNormalize(watchDir) !== pathNormalize(this.gitConfigDir)) return false;
    // A null filename means the platform couldn't say what changed. Treat it as
    // possibly-config: the probe it triggers re-reads the remotes and emits
    // nothing when they're unchanged, so a false positive costs one git spawn,
    // while a false negative would silently strand the toolbar pills.
    if (!changedFileName) return true;
    const changedName = changedFileName.toString().replaceAll("\\", "/");
    return this.matchesTrackedFile(changedName, GIT_CONFIG_FILE_NAME);
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
      if (this.disposed) return;
      // Read and clear before the callbacks: a config write landing while they
      // run belongs to the next burst, not this one.
      const configChanged = this.gitConfigChangePending;
      this.gitConfigChangePending = false;
      this.onChange();
      if (configChanged) {
        this.onGitConfigChanged?.();
      }
    }, this.debounceMs);
  }

  /**
   * Handle working tree file changes with an adaptive debounce. The first event
   * in a burst fires at `worktreeMinDebounceMs`; each subsequent event adds
   * `worktreeDebounceRampMs` to the pending delay up to `worktreeMaxDebounceMs`.
   * A `worktreeMaxWaitMs` ceiling forces a flush during sustained bursts.
   * With `worktreeLeadingDebounceMs` set, a burst that starts after a quiet
   * period flushes on the short leading delay instead — an isolated save
   * surfaces near-instantly, while continued events replace the leading timer
   * with the trailing ramp so real bursts still coalesce.
   */
  private handleWorktreeChange(eventCount = 1): void {
    if (this.disposed) {
      return;
    }

    const burstStart = this.worktreeBurstCount === 0;
    this.worktreeBurstCount += eventCount;
    let delay = Math.min(
      this.worktreeMaxDebounceMs,
      this.worktreeMinDebounceMs + (this.worktreeBurstCount - 1) * this.worktreeDebounceRampMs
    );
    if (
      burstStart &&
      this.worktreeLeadingDebounceMs !== undefined &&
      Date.now() - this.lastWorktreeFlushAt >= this.worktreeQuietWindowMs
    ) {
      delay = Math.min(delay, this.worktreeLeadingDebounceMs);
    }

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
    this.lastWorktreeFlushAt = Date.now();
    if (!this.disposed) {
      // Raw-filesystem signal first, then the git-status recompute: a browser
      // subscriber that only cares about files-on-disk shouldn't have to wait
      // for the status pass, and firing it here (not the git-internal path)
      // keeps it scoped to actual working-tree writes.
      this.onWorktreeFilesChanged?.();
      this.onChange();
    }
  }
}
