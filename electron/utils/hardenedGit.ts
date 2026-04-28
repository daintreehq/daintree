import path from "path";
import { simpleGit } from "simple-git";
import type { SimpleGit, SimpleGitProgressEvent } from "simple-git";

const SAFE_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "protocol.ext.allow=never",
  "core.gitProxy=",
  "core.hooksPath=",
  // Emit literal UTF-8 paths in porcelain/status output so non-ASCII filenames
  // flow through to IPC consumers unquoted (e.g. conflict detection on
  // `café.txt` would otherwise be returned as `"caf\303\251.txt"`).
  "core.quotepath=false",
] as const;

/**
 * Git config overrides that neutralize dangerous .git/config directives.
 * Passed as -c flags to every git command, taking precedence over repo config.
 */
export const HARDENED_GIT_CONFIG = [
  ...SAFE_GIT_CONFIG,
  "core.askpass=",
  "credential.helper=",
  "core.sshCommand=",
] as const;

export const AUTHENTICATED_GIT_CONFIG = [...SAFE_GIT_CONFIG] as const;

const UNSAFE_FLAGS = {
  allowUnsafeProtocolOverride: true,
  allowUnsafeSshCommand: true,
  allowUnsafeGitProxy: true,
  allowUnsafeHooksPath: true,
} as const;

export function validateCwd(cwd: unknown): asserts cwd is string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("Working directory must be an absolute path");
  }
}

export const GIT_BLOCK_TIMEOUT_MS = 30_000;

export function createHardenedGit(cwd: string, signal?: AbortSignal): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    config: [...HARDENED_GIT_CONFIG],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "",
  });
}

export interface WslGitInvocation {
  /** WSL distro name extracted from the worktree's UNC path. */
  distro: string;
  /** POSIX path inside the distro (must start with `/`). */
  posixPath: string;
}

/**
 * Create a hardened SimpleGit instance whose underlying git binary runs inside
 * a WSL distro. Used for worktrees mounted at `\\wsl$\<distro>\...` so that
 * git status polling stays inside the Linux filesystem and avoids the 9P
 * boundary penalty (5-10x slowdown for `git status` from Windows-side git).
 *
 * Implementation note: simple-git's `binary` option accepts a 1-2 element
 * tuple. The 2-element form prepends `binary[1]` as a single positional arg
 * to every spawn, so `["wsl.exe", "git"]` produces `wsl.exe git <args>` and
 * routes through the WSL default distro. Spaces are forbidden in the second
 * element, so a `-d <distro>` selector cannot be passed via this path —
 * non-default distros are filtered out before reaching this factory by the
 * caller (see `wslGitEligible` in WorkspaceService).
 *
 * `baseDir` is set to the POSIX path inside the distro. `wsl.exe` inherits
 * this `cwd` from Node's spawn and translates it correctly.
 *
 * Windows-only: throws on other platforms.
 */
export function createWslHardenedGit(invocation: WslGitInvocation, signal?: AbortSignal): SimpleGit {
  if (process.platform !== "win32") {
    throw new Error("createWslHardenedGit is only available on Windows");
  }
  const { distro, posixPath } = invocation;
  if (typeof distro !== "string" || !distro.trim()) {
    throw new Error("WSL distro name is required");
  }
  if (typeof posixPath !== "string" || !posixPath.startsWith("/")) {
    throw new Error("WSL posix path must start with /");
  }

  return simpleGit({
    baseDir: posixPath,
    binary: ["wsl.exe", "git"],
    config: [...HARDENED_GIT_CONFIG],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "",
    // Surface the targeted distro to wsl.exe via env. wsl.exe doesn't honour
    // WSL_DISTRO_NAME for selection (it uses the default distro), but having
    // this env var present makes diagnostic output unambiguous if the user
    // captures process state during a hang.
    WSL_DISTRO_NAME: distro,
  });
}

export interface AuthenticatedGitOptions {
  signal?: AbortSignal;
  progress?: (data: SimpleGitProgressEvent) => void;
  extraConfig?: string[];
}

export function createAuthenticatedGit(cwd: string, opts: AuthenticatedGitOptions = {}): SimpleGit {
  const { signal, progress, extraConfig } = opts;
  return simpleGit({
    baseDir: cwd,
    config: [...AUTHENTICATED_GIT_CONFIG, ...(extraConfig ?? [])],
    timeout: { block: 0 },
    ...(signal ? { abort: signal } : {}),
    ...(progress ? { progress } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
  });
}
