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
  // macOS HFS+/APFS returns filenames as NFD (decomposed Unicode); without
  // this flag git emits NFD paths in porcelain/status output, causing silent
  // bitwise inequality against NFC paths from any other source. Pinning it
  // ensures working-tree paths are reported as NFC; pre-existing NFD index
  // entries from legacy repos are unaffected. No-op on Linux/Windows.
  "core.precomposeunicode=true",
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

/**
 * Locale env vars passed to every git invocation so non-ASCII paths survive
 * iconv on Windows (where the default ANSI codepage rejects multi-byte
 * sequences) and Linux containers built without a UTF-8 locale. macOS already
 * ships `en_US.UTF-8` and lacks `C.UTF-8` entirely; setting `LC_ALL=C.UTF-8`
 * there silently falls back to strict POSIX `C` and strips UTF-8 support.
 */
export function getGitLocaleEnv(
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (platform === "win32") {
    return { LC_CTYPE: "C.UTF-8", LANG: "C.UTF-8" };
  }
  if (platform === "darwin") {
    return { LC_CTYPE: "en_US.UTF-8" };
  }
  return { LC_CTYPE: "C.UTF-8" };
}

export function createHardenedGit(cwd: string, signal?: AbortSignal): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    config: [...HARDENED_GIT_CONFIG],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...process.env,
    ...getGitLocaleEnv(),
    // Clear inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES
    // values above actually take effect. POSIX locale resolution gives LC_ALL
    // priority over every other LC_* variable.
    LC_ALL: "",
    LC_MESSAGES: "C",
    LANGUAGE: "",
  });
}

export interface WslGitInvocation {
  /** WSL distro name extracted from the worktree's UNC path. */
  distro: string;
  /**
   * Original Windows UNC path (e.g. `\\wsl$\Ubuntu\home\user\repo`). Passed
   * as `baseDir` so simple-git's synchronous folder-exists check (which calls
   * `fs.statSync`) succeeds via the Windows-side 9P mount. `wsl.exe` then
   * receives this UNC path as its spawn cwd and translates it automatically.
   */
  uncPath: string;
  /**
   * POSIX path inside the distro (must start with `/`). Retained for
   * diagnostics and for future invocation strategies that need to issue
   * `--cd` to wsl.exe directly.
   */
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
 * `baseDir` MUST be the Windows-side UNC path: simple-git validates the
 * directory via `fs.statSync` synchronously at construction time, and a
 * POSIX path like `/home/user/repo` resolves to a non-existent path on the
 * current drive (`C:\home\user\repo`) on Windows, throwing
 * `GitConstructError`. The UNC form (e.g. `\\wsl$\Ubuntu\home\user\repo`)
 * resolves through the 9P mount and `wsl.exe` translates it back to POSIX
 * internally when spawning the git child process.
 *
 * Windows-only: throws on other platforms.
 */
export function createWslHardenedGit(
  invocation: WslGitInvocation,
  signal?: AbortSignal
): SimpleGit {
  if (process.platform !== "win32") {
    throw new Error("createWslHardenedGit is only available on Windows");
  }
  const { distro, uncPath, posixPath } = invocation;
  if (typeof distro !== "string" || !distro.trim()) {
    throw new Error("WSL distro name is required");
  }
  if (typeof posixPath !== "string" || !posixPath.startsWith("/")) {
    throw new Error("WSL posix path must start with /");
  }
  if (typeof uncPath !== "string" || !uncPath.startsWith("\\\\wsl")) {
    throw new Error("WSL UNC path must start with \\\\wsl");
  }

  return simpleGit({
    baseDir: uncPath,
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
    ...getGitLocaleEnv(),
    LC_ALL: "",
    LC_MESSAGES: "C",
    LANGUAGE: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
  });
}
