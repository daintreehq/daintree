import { spawn } from "node:child_process";
import { HARDENED_GIT_CONFIG, buildHardenedGitEnv } from "./hardenedGit.js";

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
 * The hardened `-c` config flags from `HARDENED_GIT_CONFIG` are spread into
 * the argv so the call inherits every security-relevant git override the
 * simple-git factory applies (`core.fsmonitor=false`,
 * `protocol.ext.allow=never`, credential-blocking entries, …). Env comes
 * from `buildHardenedGitEnv` so locale and lock-suppression are identical
 * to the simple-git path.
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

  const configArgs = HARDENED_GIT_CONFIG.flatMap((entry) => ["-c", entry]);
  const args = [...configArgs, "check-ignore", "--stdin", "-z"];

  return new Promise<Set<string>>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const ignored = new Set<string>();
        for (const entry of stdout.split("\0")) {
          if (entry) ignored.add(entry);
        }
        resolve(ignored);
        return;
      }
      if (code === 1) {
        // `git check-ignore` exits 1 when none of the supplied paths are
        // ignored — not an error condition.
        resolve(new Set());
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(new Error(`git check-ignore failed: exit ${code}: ${stderr.trim()}`));
    });

    child.stdin?.end(body);
  });
}
