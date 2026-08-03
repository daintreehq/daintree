/**
 * Sample the paths a file surface is showing so the renderer can tell whether
 * any of them moved since the last sample.
 *
 * The answer for a path inside a worktree already arrives over the workspace
 * host's MessagePort; this covers everything else — a scratch folder, a
 * worktree-less project, a file opened from an unregistered repo (#11590).
 * Deliberately a poll rather than a subscription: main holds no per-renderer
 * watcher state, so there is nothing to tear down when a view is evicted, and
 * the sample doubles as the reconcile a real watcher would still need.
 */
export interface FileWatchFingerprintPayload {
  /**
   * Containment root every entry in `paths` must resolve inside. Named by the
   * renderer, exactly as `files:read` does, because the caller's root is not
   * always a workspace main knows about: a file picked from outside every
   * project is rooted at its own parent directory.
   */
  rootPath: string;
  /**
   * Absolute paths to sample, at most 32 per call. The file viewer sends one
   * file; the file browser sends its root plus the directories it currently has
   * expanded.
   */
  paths: string[];
}

/**
 * One opaque fingerprint per requested path, in order. `null` means nothing
 * readable is there — absent, unreadable, or outside the root — which is itself
 * a value worth diffing, since that is how a deleted file or root shows up.
 *
 * The strings carry no guaranteed structure; callers must only ever compare
 * them for equality against an earlier sample of the same path.
 */
export type FileWatchFingerprintResult = (string | null)[];
