import { spawn } from "node:child_process";
import { getHardenedGitConfig, buildHardenedGitEnv, GIT_BLOCK_TIMEOUT_MS } from "./hardenedGit.js";

/**
 * Direct-spawn wrapper around `git check-ignore --stdin -z`.
 *
 * Bypasses simple-git because simple-git 3.36 has no stdin plumbing for
 * `check-ignore` — its `checkIgnoreTask` builds `["check-ignore", ...paths]`
 * as argv, which fails with E2BIG (or ENOMEM) once the OS argv limit is
 * exceeded. Pushing paths over stdin makes the argv constant-size (#10234).
 *
 * The hardened `-c` config flags from `getHardenedGitConfig()` are spread into
 * the argv so the call inherits every security-relevant git override the
 * simple-git factory applies (`core.fsmonitor=false`, `protocol.ext.allow=never`,
 * credential-blocking entries, an app-owned `core.hooksPath`, …). Env comes from
 * `buildHardenedGitEnv` so locale and lock-suppression match the simple-git path.
 *
 * Default mode is deliberate: without `--no-index`, git never reports a
 * TRACKED path as ignored even when it matches an exclude rule ("tracked files
 * are not shown at all since they are not subject to exclude rules"). So the
 * returned set answers "ignored AND untracked" in a single spawn, and callers
 * need no separate index lookup. Negated rules (`!keep.log`) are likewise
 * resolved by git, so plain mode needs none of the `-v` record parsing.
 */

export interface CheckIgnoreOptions {
  signal?: AbortSignal;
  /** Override platform detection — test-only. */
  platform?: NodeJS.Platform;
  /**
   * Deadline for this call. Callers on a latency-sensitive path pass something
   * far below `GIT_BLOCK_TIMEOUT_MS`, which stays the hard ceiling: a wedged
   * git must not hold a decision open for 30 seconds. Clamped to the ceiling.
   */
  timeoutMs?: number;
}

interface RunOptions extends CheckIgnoreOptions {
  /** Written to stdin and closed. Omit for commands that read no input. */
  input?: string;
  /** Exit codes to treat as a successful empty result rather than an error. */
  emptyResultCodes: readonly number[];
}

/** Spawn one hardened git command and return its NUL-separated stdout tokens. */
function runGitTokens(cwd: string, gitArgs: string[], options: RunOptions): Promise<Set<string>> {
  const platform = options.platform ?? process.platform;
  const env = buildHardenedGitEnv(platform);
  // `git check-ignore` is the one command that cannot run under the hardened
  // env as-is: it refuses pathspec magic outright, so every call dies with
  // `fatal: pathspec magic not supported by this command: 'literal'` (exit
  // 128) while GIT_LITERAL_PATHSPECS is set. Dropping it is safe for the way
  // these commands are used here. Elsewhere a wildmatch metacharacter in a
  // legal filename makes git SELECT the wrong files (`pages/[...slug].tsx`
  // resolving to `pages/s.tsx`); check-ignore selects nothing — it matches the
  // literal pathname it was handed against the repo's ignore PATTERNS and
  // echoes that token back. Verified against git 2.55.0: `secre?.txt`,
  // `secre[t].txt`, `secret.*` and `{secret,plain}.txt` all report NOTHING
  // while `secret.txt` is ignored, so no metacharacter yields a false
  // positive. Pathspec magic needs a LEADING `:`, which callers here cannot
  // produce (see the absolute-path contract on `checkIgnoredPaths`), and an
  // unparseable pathname still fails closed as exit 128.
  delete env.GIT_LITERAL_PATHSPECS;
  const timeoutMs = Math.min(options.timeoutMs ?? GIT_BLOCK_TIMEOUT_MS, GIT_BLOCK_TIMEOUT_MS);

  const configArgs = getHardenedGitConfig(platform).flatMap((entry) => ["-c", entry]);
  const args = [...configArgs, ...gitArgs];

  return new Promise<Set<string>>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      // Kill the child so `close` fires, but reject here directly: a caller
      // blocked on this promise must be released even if the child is stuck in
      // an uninterruptible syscall.
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      settle(() => reject(new Error(`git ${gitArgs[0]} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Swallow stdin EPIPE: when git exits before we finish writing the body
    // (fast failure, e.g. an unknown flag triggers an early exit), the stdin
    // stream emits `error` after the process is already gone. The `close`
    // handler is the source of truth; any stdio error here is already terminal.
    child.stdin?.on("error", () => {});

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("close", (code, signal) => {
      if (signal !== null) {
        settle(() => reject(new Error(`git ${gitArgs[0]} killed by ${signal}`)));
        return;
      }
      if (code === 0) {
        // Chunks are concatenated before decoding, never decoded one at a
        // time: a multi-byte UTF-8 sequence can straddle a chunk boundary.
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const tokens = new Set<string>();
        for (const entry of stdout.split("\0")) {
          if (entry) tokens.add(entry);
        }
        settle(() => resolve(tokens));
        return;
      }
      if (code !== null && options.emptyResultCodes.includes(code)) {
        settle(() => resolve(new Set()));
        return;
      }
      // Everything else is a real failure: 128 for a fatal (a path outside the
      // repository), 129 for a usage error. A fatal can arrive mid-batch with
      // partial stdout already written, so the output is discarded rather than
      // trusted. Gated on the caller's empty-result list, never `code === 128`.
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() =>
        reject(new Error(`git ${gitArgs[0]} failed: exit ${code}: ${stderr.trim()}`))
      );
    });

    if (options.input === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Which of `paths` git considers ignored AND untracked.
 *
 * CONTRACT: every path must be ABSOLUTE and inside `cwd`'s worktree. git parses
 * these as pathspecs, so a token with a leading `:` would be read as pathspec
 * magic (`:!foo` excludes, `:/foo` is repo-root-relative) rather than as a
 * filename. An absolute path cannot start with `:`, which is what makes the
 * literal reading safe; relative input has no such guarantee and is not
 * supported. The returned tokens are the submitted strings verbatim, so
 * callers compare by exact equality.
 */
export async function checkIgnoredPaths(
  cwd: string,
  paths: readonly string[],
  options: CheckIgnoreOptions = {}
): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  // `git check-ignore -z` reads NUL-separated paths from stdin. A trailing NUL
  // terminates the last path even when no further data follows (matching the
  // output convention of `-z`). Over stdin rather than argv so the argv stays
  // constant-size: simple-git's argv-based checkIgnoreTask hits E2BIG on a
  // large burst (#10234).
  return runGitTokens(cwd, ["check-ignore", "--stdin", "-z"], {
    ...options,
    input: paths.join("\0") + "\0",
    // Exit 1 means none of the supplied paths are ignored — a valid empty
    // result, not a failure.
    emptyResultCodes: [1],
  });
}

/**
 * Whether the repo contains any TRACKED file that also matches an ignore rule.
 *
 * This is the hazard set for `checkIgnoredPaths`' tracked-file exemption. git
 * exempts tracked paths from check-ignore by looking them up in the index, and
 * that lookup is case-SENSITIVE even when the filesystem is not. So on APFS or
 * NTFS a file force-added as `.output/Keep.txt` and then renamed on disk to
 * `.output/keep.txt` is still tracked, still shows as modified in `git status`,
 * and yet check-ignore reports the on-disk spelling as ignored — verified
 * against git 2.55.0. A caller that skips work on "ignored" would miss a real
 * change.
 *
 * Empty for essentially every repository, which is why the caller can treat a
 * cached "no hazard" as licence to trust check-ignore outright, and only pay
 * this spawn again when the index changes.
 */
export async function hasTrackedIgnoredPaths(
  cwd: string,
  options: CheckIgnoreOptions = {}
): Promise<boolean> {
  const tokens = await runGitTokens(cwd, ["ls-files", "-z", "-i", "-c", "--exclude-standard"], {
    ...options,
    emptyResultCodes: [],
  });
  return tokens.size > 0;
}
