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
  async status(worktreePath: string): Promise<PluginGitStatus> {
    const changes = await this.changesProvider(worktreePath);
    const projected = toPluginWorktreeStatus(changes);
    return {
      worktreePath,
      files: projected ? [...projected.files] : [],
      changedFileCount: projected ? projected.changedFileCount : 0,
    };
  }

  /** Unified diff for the worktree, optionally narrowed to one path. `--no-textconv` blocks user diff drivers. */
  async diff(worktreePath: string, filePath?: string): Promise<string> {
    const git = await this.gitFactory(worktreePath);
    const args = ["--no-ext-diff", "--no-textconv", "--no-color"];
    if (typeof filePath === "string" && filePath.length > 0) {
      args.push("--end-of-options", "--", filePath);
    }
    return git.diff(args);
  }

  /** Stage paths relative to the worktree, or all changes when omitted. */
  async add(worktreePath: string, paths?: string[]): Promise<void> {
    const git = await this.gitFactory(worktreePath);
    const targets =
      Array.isArray(paths) && paths.length > 0
        ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : ["."];
    await git.add(targets);
  }

  /**
   * Commit staged changes. Refuses without an explicit non-empty message (the
   * #7880 guard) and computes the real staged diff as the change preview BEFORE
   * mutating, satisfying the D2 safeguard at the host layer.
   */
  async commit(
    worktreePath: string,
    options: PluginGitCommitOptions
  ): Promise<PluginGitCommitResult> {
    const message = typeof options?.message === "string" ? options.message : "";
    if (message.trim().length === 0) {
      throw new PluginGitCommitMessageRequiredError(this.pluginId);
    }

    const git = await this.gitFactory(worktreePath);
    // The real change preview the D2 safeguard requires: the staged diff that is
    // about to be committed, computed before the mutation. No silent fallback.
    const preview = await git.diff(["--cached", "--no-ext-diff", "--no-textconv", "--no-color"]);
    const result = await git.commit(message);
    return {
      commit: result.commit,
      message,
      preview,
    };
  }
}
