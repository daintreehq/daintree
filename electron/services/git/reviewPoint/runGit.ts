import { spawn } from "node:child_process";
import { buildHardenedGitEnv, getHardenedGitConfig } from "../../../utils/hardenedGit.js";
import { resolveExecutableForSpawn } from "../../../utils/windowsExecutable.js";

/**
 * One hardened git command whose stdout comes back as bytes.
 *
 * simple-git decodes stdout as UTF-8 before any caller sees it, which turns a
 * path that is not valid UTF-8 into replacement characters: two different
 * files can then share one name. A review point keys everything by path, so
 * the commands it runs keep the bytes and decode nothing.
 *
 * Same hardening as `createHardenedGit`: its `-c` profile and its env, which
 * carries `GIT_OPTIONAL_LOCKS=0` so a status read never refreshes the index.
 * On top of that, two reads that could otherwise write or mislead: a partial
 * clone fetching a missing object (`GIT_NO_LAZY_FETCH`), and a replace ref
 * making a commit id stand for another commit's tree (`GIT_NO_REPLACE_OBJECTS`).
 */

export class GitOutputLimitError extends Error {
  constructor(
    readonly command: string,
    readonly maxBytes: number
  ) {
    super(`git ${command} output exceeded ${maxBytes} bytes`);
    this.name = "GitOutputLimitError";
  }
}

export class GitTimeoutError extends Error {
  constructor(readonly command: string) {
    super(`git ${command} did not finish in time`);
    this.name = "GitTimeoutError";
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(`git ${command} failed: exit ${exitCode}: ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

export interface RunGitOptions {
  /** Aborting kills the child and rejects with the signal's reason. */
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  /** Written to stdin and closed. */
  input?: Buffer;
  /** Exit codes other than 0 that still mean "this is the answer". */
  okExitCodes?: readonly number[];
  /**
   * Config set for this command only, through `GIT_CONFIG_COUNT` rather than
   * `-c`: `-c` splits at the first `=`, which a subsection name may contain.
   */
  config?: ReadonlyArray<readonly [key: string, value: string]>;
  platform?: NodeJS.Platform;
}

export interface RunGitResult {
  stdout: Buffer;
  exitCode: number;
}

export async function runGitForBytes(
  cwd: string,
  gitArgs: readonly string[],
  options: RunGitOptions
): Promise<RunGitResult> {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = {
    ...buildHardenedGitEnv(platform),
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const config = options.config ?? [];
  if (config.length > 0) {
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
  // Windows starts git by the absolute path a PATH lookup finds, never by a
  // bare name a repository root could shadow.
  const binary =
    platform === "win32" ? await resolveExecutableForSpawn("git", env, platform) : "git";
  options.signal?.throwIfAborted();
  const args = [...getHardenedGitConfig(platform).flatMap((entry) => ["-c", entry]), ...gitArgs];
  const command = gitArgs[0] ?? "";

  return new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    // Rejects without waiting for `close`: a child stuck in an uninterruptible
    // syscall must not hold the capture past its deadline.
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdoutChunks.length = 0;
      kill();
      reject(error);
    };
    const onAbort = () => fail(options.signal?.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => fail(new GitTimeoutError(command)), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        fail(new GitOutputLimitError(command, options.maxStdoutBytes));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Only the start of stderr is ever reported; the rest is drained.
      if (stderrBytes < 4096) stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    // git can exit before reading all of stdin (a fatal on the first path);
    // `close` reports that, so the pipe error itself is not the failure.
    child.stdin.on("error", () => {});
    child.on("error", (error) => fail(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal !== null) {
        fail(new GitCommandError(command, null, `killed by ${signal}`));
        return;
      }
      if (code === 0 || (code !== null && options.okExitCodes?.includes(code))) {
        settled = true;
        cleanup();
        resolve({ stdout: Buffer.concat(stdoutChunks), exitCode: code });
        return;
      }
      fail(new GitCommandError(command, code, Buffer.concat(stderrChunks).toString("utf8")));
    });

    child.stdin.end(options.input);
  });
}
