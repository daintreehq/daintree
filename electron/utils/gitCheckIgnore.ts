import { spawn } from "node:child_process";
import { getHardenedGitConfig, buildHardenedGitEnv, GIT_BLOCK_TIMEOUT_MS } from "./hardenedGit.js";

/**
 * Direct-spawn wrapper around `git check-ignore --stdin -z`.
 *
 * Bypasses simple-git because simple-git 3.36 has no stdin plumbing for
 * `check-ignore` — its `checkIgnoreTask` builds `["check-ignore", ...paths]`
 * as argv, which fails with E2BIG (or ENOMEM) on directories with thousands
 * of entries once the OS argv limit is exceeded. Pushing paths over stdin
 * makes the argv constant-size and safe up to the OS pipe-buffer limit
 * (typically 64 KB) per spawn.
 *
 * The hardened `-c` config flags from `getHardenedGitConfig()` are spread into
 * the argv so the call inherits every security-relevant git override the
 * simple-git factory applies (`core.fsmonitor=false`,
 * `protocol.ext.allow=never`, credential-blocking entries, an app-owned
 * `core.hooksPath`, …). Env comes from `buildHardenedGitEnv` so locale and
 * lock-suppression are identical to the simple-git path.
 *
 * The wrapper applies the same `GIT_BLOCK_TIMEOUT_MS` ceiling that
 * `createHardenedGit` passes to simple-git's `block` knob: a hung git
 * (broken FUSE mount, deadlocked repo lock, hostile git shim on PATH) is
 * killed with SIGTERM and the wrapper rejects, so a single bad call cannot
 * pin the file-tree request forever.
 */

export interface CheckIgnoreOptions {
  signal?: AbortSignal;
  /** Override platform detection — test-only. */
  platform?: NodeJS.Platform;
}

export async function checkIgnoredPaths(
  cwd: string,
  gitRelativePaths: string[],
  options: CheckIgnoreOptions = {}
): Promise<Set<string>> {
  if (gitRelativePaths.length === 0) {
    return new Set();
  }

  const platform = options.platform ?? process.platform;
  const env = buildHardenedGitEnv(platform);

  // `git check-ignore -z` reads NUL-separated paths from stdin. A trailing
  // NUL is included so the last path is terminated even when no further
  // data follows (matches the output convention of `-z`).
  const body = gitRelativePaths.join("\0") + "\0";

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
      // Kill the child so `close` fires and we exit the wrapper. Reject
      // here directly so a caller blocked on this promise gets unblocked
      // even if the child is stuck in an uninterruptible syscall.
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      settle(() => reject(new Error(`git check-ignore timed out after ${GIT_BLOCK_TIMEOUT_MS}ms`)));
    }, GIT_BLOCK_TIMEOUT_MS);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Swallow stdin EPIPE: when git exits before we finish writing the
    // body (fast failure, e.g. an unknown flag triggers an early exit),
    // the stdin stream emits `error` after the process is already gone.
    // The `close` handler is the source of truth for the result; any
    // stdio error here is already terminal.
    child.stdin?.on("error", () => {});

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("close", (code) => {
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
        // `git check-ignore` exits 1 when none of the supplied paths are
        // ignored — not an error condition.
        settle(() => resolve(new Set()));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() => reject(new Error(`git check-ignore failed: exit ${code}: ${stderr.trim()}`)));
    });

    child.stdin?.end(body);
  });
}
