import path from "path";
import type { SimpleGit } from "simple-git";
import { createHardenedGit } from "../../utils/hardenedGit.js";
import { getWorktreeChangesWithStats } from "../../utils/git.js";
import { toPluginWorktreeStatus } from "../../../shared/utils/pluginWorktreeSnapshot.js";
import type { WorktreeChanges } from "../../../shared/types/index.js";
import type {
  PluginGitCommitOptions,
  PluginGitCommitResult,
  PluginGitStatus,
} from "../../../shared/types/plugin.js";

/**
 * Thrown when `host.git.commit` is called without an explicit, non-empty
 * message. The #7880 root-cause guard at the host layer: the host never
 * substitutes a derived ("ai-note OR last-commit") message — a destructive
 * commit gates on an explicitly authored message.
 */
export class PluginGitCommitMessageRequiredError extends Error {
  constructor(public readonly pluginId: string) {
    super(
      `COMMIT_MESSAGE_REQUIRED: plugin "${pluginId}" git.commit requires an explicit non-empty message — the host does not substitute a derived commit message`
    );
    this.name = "PluginGitCommitMessageRequiredError";
  }
}

/** Thrown when a git pathspec escapes the contained worktree or uses pathspec magic. */
export class PluginGitPathNotAllowedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly pathspec: string
  ) {
    super(
      `PATH_NOT_ALLOWED: plugin "${pluginId}" git pathspec "${pathspec}" must be a relative path inside the worktree (no "..", absolute, or ":" pathspec magic)`
    );
    this.name = "PluginGitPathNotAllowedError";
  }
}

/**
 * A git pathspec from a plugin must be worktree-relative: containing the
 * worktree `cwd` is not enough, because git resolves `../foo` and absolute paths
 * against the repository, escaping the declared scope. Reject absolute paths,
 * any `..` segment, and leading-`:` pathspec magic.
 */
function assertSafePathspec(pluginId: string, spec: string): void {
  // Leading "-" would be parsed as a git OPTION (e.g. "-A" / "--all" stages the
  // whole repo, escaping the worktree scope) rather than a path.
  if (path.isAbsolute(spec) || spec.startsWith(":") || spec.startsWith("-")) {
    throw new PluginGitPathNotAllowedError(pluginId, spec);
  }
  if (spec.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new PluginGitPathNotAllowedError(pluginId, spec);
  }
}

/** Factory the host uses to obtain a git client for a contained worktree path — injectable for tests. */
export type HostGitFactory = (cwd: string) => Promise<SimpleGit>;

/** Changed-file provider for `status` — injectable so tests skip the real git shell-out. */
export type HostGitChangesProvider = (worktreePath: string) => Promise<WorktreeChanges>;

/**
 * Build the contained `host.git` operations for one worktree. `worktreePath`
 * has already been realpath-contained to the plugin's `scopes.fs.allowedPaths`
 * by the caller — this module only performs the git work over the existing
 * hardened simple-git layer.
 */
export class PluginHostGit {
  constructor(
    private readonly pluginId: string,
    private readonly gitFactory: HostGitFactory = createHardenedGit,
    private readonly changesProvider: HostGitChangesProvider = (worktreePath) =>
      getWorktreeChangesWithStats(worktreePath, true)
  ) {}

  /**
   * Changed-file status, projected through the same {@link toPluginWorktreeStatus}
   * collapse the worktree snapshot uses so plugins see one status vocabulary.
   * Reads via the shared `getWorktreeChangesWithStats` (cached, hardened).
   */
  async status(worktreePath: string, signal?: AbortSignal): Promise<PluginGitStatus> {
    signal?.throwIfAborted();
    const changes = await this.changesProvider(worktreePath);
    signal?.throwIfAborted();
    const projected = toPluginWorktreeStatus(changes);
    return {
      worktreePath,
      files: projected ? [...projected.files] : [],
      changedFileCount: projected ? projected.changedFileCount : 0,
    };
  }

  /** Unified diff for the worktree, optionally narrowed to one path. `--no-textconv` blocks user diff drivers. */
  async diff(worktreePath: string, filePath?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const git = await this.gitFactory(worktreePath);
    signal?.throwIfAborted();
    const args = ["--no-ext-diff", "--no-textconv", "--no-color"];
    if (typeof filePath === "string" && filePath.length > 0) {
      assertSafePathspec(this.pluginId, filePath);
      args.push("--end-of-options", "--", filePath);
    }
    return git.diff(args);
  }

  /** Stage paths relative to the worktree, or all changes when omitted. */
  async add(worktreePath: string, paths?: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const git = await this.gitFactory(worktreePath);
    signal?.throwIfAborted();
    const targets =
      Array.isArray(paths) && paths.length > 0
        ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : ["."];
    for (const spec of targets) {
      assertSafePathspec(this.pluginId, spec);
    }
    // "--" forces git to treat every following token as a pathspec, not an
    // option — defense in depth alongside the leading-"-" rejection above.
    await git.raw(["add", "--", ...targets]);
  }

  /**
   * Commit staged changes. Refuses without an explicit non-empty message (the
   * #7880 guard) and computes the real staged diff as the change preview BEFORE
   * mutating, satisfying the D2 safeguard at the host layer.
   */
  async commit(
    worktreePath: string,
    options: PluginGitCommitOptions,
    signal?: AbortSignal
  ): Promise<PluginGitCommitResult> {
    signal?.throwIfAborted();
    const message = typeof options?.message === "string" ? options.message : "";
    if (message.trim().length === 0) {
      throw new PluginGitCommitMessageRequiredError(this.pluginId);
    }

    const git = await this.gitFactory(worktreePath);
    // Re-check after acquiring the client but BEFORE computing the preview.
    signal?.throwIfAborted();
    // The real change preview the D2 safeguard requires: the staged diff that is
    // about to be committed, computed before the mutation. No silent fallback.
    const preview = await git.diff(["--cached", "--no-ext-diff", "--no-textconv", "--no-color"]);
    // Re-check immediately before the mutation — the diff above can take time on
    // a large staged set, and an abort mid-diff must not still create the commit.
    signal?.throwIfAborted();
    const result = await git.commit(message);
    return {
      commit: result.commit,
      message,
      preview,
    };
  }
}
