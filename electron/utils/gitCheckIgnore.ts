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

export async function checkIgnoredPaths(
  cwd: string,
  paths: readonly string[],
  options: CheckIgnoreOptions = {}
): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }

  const platform = options.platform ?? process.platform;
  const env = buildHardenedGitEnv(platform);
  const timeoutMs = Math.min(options.timeoutMs ?? GIT_BLOCK_TIMEOUT_MS, GIT_BLOCK_TIMEOUT_MS);

  // `git check-ignore -z` reads NUL-separated paths from stdin. A trailing NUL
  // terminates the last path even when no further data follows (matching the
  // output convention of `-z`).
  const body = paths.join("\0") + "\0";

  const configArgs = getHardenedGitConfig(platform).flatMap((entry) => ["-c", entry]);
  const args = [...configArgs, "check-ignore", "--stdin", "-z"];

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
      settle(() => reject(new Error(`git check-ignore timed out after ${timeoutMs}ms`)));
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
        settle(() => reject(new Error(`git check-ignore killed by ${signal}`)));
        return;
      }
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const ignored = new Set<string>();
        for (const entry of stdout.split("\0")) {
          if (entry) ignored.add(entry);
        }
        settle(() => resolve(ignored));
        return;
      }
      if (code === 1) {
        // Exit 1 means none of the supplied paths are ignored — a valid empty
        // result, not a failure.
        settle(() => resolve(new Set()));
        return;
      }
      // Everything above 1 is a real failure: 128 for a fatal (a path outside
      // the repository), 129 for a usage error. A fatal can arrive mid-batch
      // with partial stdout already written, so the output is discarded rather
      // than trusted. Gated on `code > 1`, never `code === 128`.
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() => reject(new Error(`git check-ignore failed: exit ${code}: ${stderr.trim()}`)));
    });

    child.stdin?.end(body);
  });
}
