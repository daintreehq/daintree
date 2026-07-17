import fs from "node:fs";
import os from "node:os";
import path from "path";
import type { SimpleGit, SimpleGitProgressEvent } from "simple-git";
import { tightenDirPermissionsSync } from "./fs.js";
import { detectWslPath } from "./wsl.js";

// Deferred import keeps simple-git out of the eager pre-paint main bundle —
// esbuild's `splitting: true` emits it as a lazy chunk (issue #10395). Kicked
// off at module evaluation so the chunk is typically loaded before the first
// git call; each factory awaits the same promise and surfaces load errors at
// call time. The no-op catch marks the prefetch handled so a broken install
// can't fire an unhandled rejection before any factory runs.
const simpleGitModule = import("simple-git");
void simpleGitModule.catch(() => {});

const SAFE_GIT_CONFIG_BASE = [
  "core.fsmonitor=false",
  // keep reads an existing untracked-cache without creating one and without
  // stripping the extension on the next index write. fsmonitor (the daemon/
  // exec-surface risk) stays false; the untracked cache is a per-worktree
  // index extension with no shared state, so keep is safe under concurrent
  // multi-worktree polling.
  "core.untrackedCache=keep",
  "core.pager=cat",
  "protocol.ext.allow=never",
  "core.gitProxy=",
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
 * Path-independent half of the hardened profile. `core.hooksPath` is appended
 * per call by `getHardenedGitConfig()` — it resolves an app-owned absolute
 * directory that cannot be captured at module evaluation (see
 * `resolveUserDataDir`).
 */
const HARDENED_GIT_CONFIG_BASE = [
  ...SAFE_GIT_CONFIG_BASE,
  "core.askpass=",
  "credential.helper=",
  "core.sshCommand=",
] as const;

const AUTHENTICATED_GIT_CONFIG_BASE = [...SAFE_GIT_CONFIG_BASE] as const;

/**
 * Hook directory for git running *inside* a WSL distro. `createWslHardenedGit`
 * spawns `wsl.exe git`, so the Windows-side userData path is meaningless there:
 * without a leading `/` Linux git would treat it as relative, which is the very
 * bug this override exists to prevent (issue #11226). Git expands a leading `~`
 * in `core.hooksPath` against the distro user's home at hook-dispatch time, so
 * this resolves to an absolute, user-owned directory inside the distro without
 * the Windows host having to probe for it.
 *
 * Not created eagerly: the WSL route only serves read-only status/divergence
 * polling, and git blocks repo hooks against a missing directory just as well
 * as an existing one.
 */
const WSL_GIT_HOOKS_PATH = "~/.daintree/git-hooks";

let cachedGitHooksDir: string | null = null;
let hooksDirWarned = false;

/** Electron's `userData`, or undefined outside the main process. */
function getElectronUserDataPath(): string | undefined {
  try {
    // Dynamic require to avoid breaking tests that mock electron. `require`
    // exists in the bundled main via esbuild's createRequire banner; under
    // vitest it does not, and the throw is swallowed on purpose.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    const userData: unknown = electron.app?.getPath("userData");
    return typeof userData === "string" ? userData : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Precedence for the userData root, split out from how the candidates are
 * obtained so it can be tested directly — the `require("electron")` read above
 * is unreachable under vitest.
 *
 * The later candidates are suppliers, not values, so a valid env var still
 * short-circuits before Electron is touched — every workspace host would
 * otherwise attempt (and fail) a `require("electron")` it never needs.
 *
 * Every candidate must be absolute; a relative one is reported and skipped
 * rather than honoured, because a relative hooks path is the defect itself.
 */
export function selectUserDataDir(
  fromEnv: string | undefined,
  fromElectron: () => string | undefined,
  homeDir: () => string
): string {
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  if (fromEnv) {
    // console.error, not warn: esbuild strips console.warn from production
    // builds, and a misconfigured hooks root must not fail silently.
    console.error(`[hardenedGit] DAINTREE_USER_DATA is not absolute: ${fromEnv}, falling back`);
  }

  const electronUserData = fromElectron();
  if (electronUserData && path.isAbsolute(electronUserData)) return electronUserData;

  const home = homeDir();
  if (home && path.isAbsolute(home)) {
    // Only expected in tests: the main process resolves via electron, and every
    // utility process is forked with DAINTREE_USER_DATA. Reaching this in a real
    // process means main and the workspace-host have split onto different hook
    // roots, silently costing git-lfs its pre-push hook — so say so loudly.
    if (process.env.DAINTREE_UTILITY_PROCESS_KIND) {
      console.error(
        "[hardenedGit] No usable DAINTREE_USER_DATA in utility process " +
          `"${process.env.DAINTREE_UTILITY_PROCESS_KIND}" — falling back to the home directory, ` +
          "which will not match the main process's hooks directory"
      );
    }
    return path.join(home, ".daintree");
  }

  throw new Error("[hardenedGit] Cannot resolve an absolute userData directory for core.hooksPath");
}

/**
 * Resolve the userData root holding the git hooks Daintree is willing to run.
 *
 * Deliberately lazy — `hardenedGit.ts` is imported very early and very broadly,
 * and `electron/setup/environment.ts` rewrites `userData` in dev *after* those
 * imports, so a module-scope capture would pin the wrong path.
 *
 * Candidates, in the order `selectUserDataDir` considers them:
 *   1. `DAINTREE_USER_DATA` — the workspace-host UtilityProcess has no usable
 *      `app` API and receives this from its fork env (`WorkspaceHostProcess`).
 *   2. Electron's `userData` — the main process.
 *   3. The user's home directory — expected only in tests; in a real process it
 *      means something is broken, and `selectUserDataDir` says so.
 */
function resolveUserDataDir(): string {
  return selectUserDataDir(process.env.DAINTREE_USER_DATA, getElectronUserDataPath, () =>
    os.homedir()
  );
}

/**
 * Absolute hooks directory, resolved and created once per process.
 *
 * `WorktreeMonitor` polls git status continuously, so the `mkdirSync` must not
 * ride the hot path — the resolved value is memoized on first use.
 *
 * A creation failure is logged once and otherwise ignored: git blocks
 * repo-supplied hooks against a non-existent absolute path (the security
 * invariant holds regardless), and the directory only needs to exist so
 * git-lfs can install its hooks somewhere other than a worktree root. Failing
 * hard here would take every git operation down over a permissions hiccup.
 */
function getGitHooksDir(): string {
  if (cachedGitHooksDir !== null) return cachedGitHooksDir;

  const dir = path.join(resolveUserDataDir(), "git-hooks");
  try {
    // git dispatches whatever lives here for every repo Daintree touches, so it
    // must not be writable by other local users. mkdir's `mode` only applies to
    // segments it newly creates, so tighten unconditionally afterwards — a
    // directory left at 0o755 by an earlier version would otherwise stay there.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tightenDirPermissionsSync(dir);
  } catch (e) {
    if (!hooksDirWarned) {
      hooksDirWarned = true;
      // console.error, not warn: esbuild strips console.warn from production
      // builds, which would make this failure invisible exactly where it costs
      // git-lfs its install target.
      console.error(`[hardenedGit] Could not create git hooks directory: ${dir}`, e);
    }
  }
  cachedGitHooksDir = dir;
  return dir;
}

/**
 * Git parses `-c key=value` values with backslash escape sequences, so a raw
 * Windows path risks mangling (`C:\Users` → `C:Users`). Git accepts forward
 * slashes on every platform. POSIX paths pass through untouched — a backslash
 * there is a legal filename character, not a separator.
 */
export function toGitConfigPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? dir.replace(/\\/g, "/") : dir;
}

function hooksPathEntry(hooksPath: string, platform?: NodeJS.Platform): string {
  return `core.hooksPath=${toGitConfigPath(hooksPath, platform)}`;
}

/**
 * Git config overrides that neutralize dangerous .git/config directives.
 * Passed as -c flags to every git command, taking precedence over repo config.
 *
 * `core.hooksPath` points at an app-owned absolute directory rather than being
 * blanked. An empty value is relative, and git-lfs resolves it against its own
 * CWD when self-installing its hooks — during `git worktree add` that CWD is
 * the new worktree root, so four hook files landed there as untracked litter
 * (issue #11226). An absolute path still overrides (and therefore blocks) any
 * repo-supplied `.git/hooks` — the invariant from #3742 — while giving git-lfs
 * a stable home so its `pre-push` object upload keeps working.
 *
 * The directory is shared across every repo Daintree touches: git-lfs installs
 * its hooks there once, and they run (as no-ops) for non-LFS repos too. That is
 * the deliberate tradeoff recorded in #11226.
 */
export function getHardenedGitConfig(platform?: NodeJS.Platform): readonly string[] {
  return [...HARDENED_GIT_CONFIG_BASE, hooksPathEntry(getGitHooksDir(), platform)];
}

/**
 * Authenticated profile. `extraConfig` is placed *before* the hooks entry: git
 * takes the last `-c` for a single-valued key, so a caller cannot override the
 * hook enforcement path, accidentally or otherwise.
 */
function getAuthenticatedGitConfig(extraConfig?: string[], platform?: NodeJS.Platform): string[] {
  return [
    ...AUTHENTICATED_GIT_CONFIG_BASE,
    ...(extraConfig ?? []),
    hooksPathEntry(getGitHooksDir(), platform),
  ];
}

const UNSAFE_FLAGS = {
  allowUnsafeAskPass: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeProtocolOverride: true,
  allowUnsafeFsMonitor: true,
  allowUnsafePager: true,
  allowUnsafeSshCommand: true,
  allowUnsafeGitProxy: true,
  allowUnsafeHooksPath: true,
  // simple-git 3.36.0 scans the spawn env and rejects any EDITOR / GIT_EDITOR /
  // GIT_SEQUENCE_EDITOR key unless this flag is set, even when the value is the
  // non-interactive `true` we set ourselves to suppress the editor on
  // `git rebase --continue` (see buildContinueEnv). The scanner fires on the
  // presence of the key, not its origin, so the flag is required.
  allowUnsafeEditor: true,
} as const;

const BLOCKED_INHERITED_GIT_ENV_KEYS = new Set([
  "EDITOR",
  "GIT_ASKPASS",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  // Inherited GIT_MERGE_AUTOEDIT=yes would re-open the editor on
  // `git merge --continue`; strip it so buildContinueEnv's explicit "no" wins.
  "GIT_MERGE_AUTOEDIT",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "PAGER",
  "PREFIX",
  "SSH_ASKPASS",
]);

function getSanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      BLOCKED_INHERITED_GIT_ENV_KEYS.has(normalizedKey) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(normalizedKey)
    ) {
      delete env[key];
    }
  }
  return env;
}

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
    return { LC_CTYPE: "C.UTF-8", LANG: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0" };
  }
  if (platform === "darwin") {
    return { LC_CTYPE: "en_US.UTF-8", GIT_OPTIONAL_LOCKS: "0" };
  }
  return { LC_CTYPE: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0" };
}

export function buildHardenedGitEnv(
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return {
    ...getSanitizedProcessEnv(),
    ...getGitLocaleEnv(platform),
    // Clear inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES
    // values above actually take effect. POSIX locale resolution gives LC_ALL
    // priority over every other LC_* variable.
    LC_ALL: "",
    LC_MESSAGES: "C",
    LANGUAGE: "",
    // Suppress optional .git/index.lock writes during status-only reads. Only
    // affects opportunistic locks (stat-cache refresh); mandatory locks for
    // git add/commit are unaffected, so this is safe even when the hardened
    // factory is used for write paths.
    GIT_OPTIONAL_LOCKS: "0",
    // Block git's built-in TTY prompt for credentials/passphrases. Some
    // commands (clone, fetch, push) still touch credential helpers even
    // through the hardened factory's `-c credential.helper=` blank, and an
    // interactive prompt in the Electron main process hangs forever.
    GIT_TERMINAL_PROMPT: "0",
    // Defense in depth: some credential helpers ignore GIT_TERMINAL_PROMPT
    // and still invoke an ASKPASS binary. `true` exits 0 with empty stdout,
    // so git treats it as an empty credential and fails fast instead of
    // hanging. `true` is not on PATH on Windows; GIT_TERMINAL_PROMPT=0 plus
    // GCM_INTERACTIVE=Never below cover that platform.
    ...(platform !== "win32" ? { GIT_ASKPASS: "true" } : {}),
    // Windows-only: prevent Git Credential Manager from spawning GUI auth
    // dialogs in background processes where no user can interact. No effect
    // on POSIX or on local read operations.
    GCM_INTERACTIVE: "Never",
  };
}

/**
 * Hardened env for continue-style operations (`git rebase/merge/cherry-pick/
 * revert --continue`). Builds on `buildHardenedGitEnv` and adds the editor
 * suppression those commands need to run non-interactively — `git rebase
 * --continue` has no `--no-edit` flag, so `GIT_EDITOR=true` is the only way to
 * keep it from spawning an editor in the Electron main process.
 *
 * Returns a single env object meant to be passed in one `.env()` call:
 * simple-git's `.env()` replaces the spawn env wholesale, so layering a second
 * `.env()` over `createHardenedGit` would silently drop all the hardening above
 * (issue #7058). Set the editor keys AFTER the spread — `buildHardenedGitEnv`
 * strips inherited `GIT_EDITOR`/`EDITOR` via the block list, and we re-add the
 * intentional non-interactive value here.
 */
export function buildContinueEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return {
    ...buildHardenedGitEnv(platform),
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
  };
}

export async function createHardenedGit(
  cwd: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform
): Promise<SimpleGit> {
  const { simpleGit } = await simpleGitModule;
  return simpleGit({
    baseDir: cwd,
    config: [...getHardenedGitConfig(platform)],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env(buildHardenedGitEnv(platform));
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
export async function createWslHardenedGit(
  invocation: WslGitInvocation,
  signal?: AbortSignal
): Promise<SimpleGit> {
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
  const parsed = detectWslPath(uncPath);
  if (typeof uncPath !== "string" || parsed === null) {
    throw new Error("WSL UNC path is not a valid WSL UNC");
  }
  // Defense in depth: verify the supplied distro/posixPath match the parsed
  // UNC, so a caller can't bypass the route with mismatched metadata.
  if (parsed.distro.toLowerCase() !== distro.trim().toLowerCase()) {
    throw new Error("WSL distro does not match parsed UNC");
  }
  if (parsed.posixPath !== posixPath) {
    throw new Error("WSL posix path does not match parsed UNC");
  }

  const { simpleGit } = await simpleGitModule;
  return simpleGit({
    baseDir: uncPath,
    binary: ["wsl.exe", "git"],
    // The Windows-side hooks directory is not addressable from inside the
    // distro, so this route carries its own POSIX path (see
    // WSL_GIT_HOOKS_PATH). Non-path hardening is shared with the native
    // profile.
    config: [...HARDENED_GIT_CONFIG_BASE, `core.hooksPath=${WSL_GIT_HOOKS_PATH}`],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...getSanitizedProcessEnv(),
    LC_CTYPE: "C.UTF-8",
    LC_ALL: "",
    LC_MESSAGES: "C",
    LANGUAGE: "",
    GIT_OPTIONAL_LOCKS: "0",
    // Surface the targeted distro to wsl.exe via env. wsl.exe doesn't honour
    // WSL_DISTRO_NAME for selection (it uses the default distro), but having
    // this env var present makes diagnostic output unambiguous if the user
    // captures process state during a hang.
    WSL_DISTRO_NAME: distro,
    // The git binary inside WSL is Linux git, so the same non-interactive +
    // lock-suppression hardening that createHardenedGit applies on POSIX
    // must reach the WSL distro too. GCM_INTERACTIVE is harmless inside
    // WSL (no GCM there) but kept for defense in depth in case wsl.exe ever
    // surfaces it back to the host credential helper chain.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GCM_INTERACTIVE: "Never",
  });
}

export interface AuthenticatedGitOptions {
  signal?: AbortSignal;
  progress?: (data: SimpleGitProgressEvent) => void;
  extraConfig?: string[];
}

export async function createAuthenticatedGit(
  cwd: string,
  opts: AuthenticatedGitOptions = {}
): Promise<SimpleGit> {
  const { signal, progress, extraConfig } = opts;
  const { simpleGit } = await simpleGitModule;
  return simpleGit({
    baseDir: cwd,
    config: getAuthenticatedGitConfig(extraConfig),
    timeout: { block: 0 },
    ...(signal ? { abort: signal } : {}),
    ...(progress ? { progress } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...getSanitizedProcessEnv(),
    ...getGitLocaleEnv(),
    LC_ALL: "",
    LC_MESSAGES: "C",
    LANGUAGE: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
    // Same lock-suppression and Windows-GCM hardening as createHardenedGit.
    // GIT_ASKPASS is intentionally NOT set here — credentialed commands
    // (clone/push) need legitimate ASKPASS resolution.
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "Never",
  });
}

/**
 * Background-fetch config additions on top of the authenticated profile:
 *   - `core.packedRefsTimeout=5000`: when a foreground git operation holds
 *     `.git/packed-refs.lock`, wait up to 5s instead of failing immediately.
 *   - `http.lowSpeedLimit=1000` + `http.lowSpeedTime=30`: abort fetches that
 *     stall under 1 KB/s for 30s, so a half-open TCP connection doesn't sit
 *     against the 60s AbortSignal timeout.
 *   - `gc.auto=0`: belt-and-braces — `--no-auto-gc` is also passed at the
 *     fetch call site, but pinning the config too prevents any sub-invocation
 *     (e.g., a fetch hook) from racing a gc against foreground git CLI.
 */
const BACKGROUND_FETCH_CONFIG = [
  "core.packedRefsTimeout=5000",
  "http.lowSpeedLimit=1000",
  "http.lowSpeedTime=30",
  "gc.auto=0",
] as const;

export interface BackgroundFetchGitOptions {
  signal: AbortSignal;
  progress?: (data: SimpleGitProgressEvent) => void;
  extraConfig?: string[];
  /** Override platform detection — test-only. */
  platform?: NodeJS.Platform;
}

/**
 * SimpleGit instance for background `git fetch` invocations. Wraps
 * `createAuthenticatedGit` so the system credential helper still works for
 * HTTPS remotes, but layers on:
 *   - lock-friendly config (see `BACKGROUND_FETCH_CONFIG`)
 *   - `GIT_ASKPASS=true` on POSIX so credential helpers that ignore
 *     `GIT_TERMINAL_PROMPT=0` fail fast instead of hanging on a TTY prompt
 *     (Windows omits this — `true` is not on PATH there, and
 *     `GIT_TERMINAL_PROMPT=0` blocks Windows credential dialogs)
 *
 * The signal is required: every background fetch must carry an
 * AbortController so a stalled connection can be cancelled.
 */
export async function createBackgroundFetchGit(
  cwd: string,
  opts: BackgroundFetchGitOptions
): Promise<SimpleGit> {
  const { signal, progress, extraConfig, platform = process.platform } = opts;
  const git = await createAuthenticatedGit(cwd, {
    signal,
    progress,
    extraConfig: [...BACKGROUND_FETCH_CONFIG, ...(extraConfig ?? [])],
  });
  if (platform !== "win32") {
    return git.env({
      ...getSanitizedProcessEnv(),
      ...getGitLocaleEnv(platform),
      LC_ALL: "",
      LC_MESSAGES: "C",
      LANGUAGE: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
      GIT_ASKPASS: "true",
      // simple-git's .env() replaces the env wholesale, so the hardening
      // flags from createAuthenticatedGit's first .env() call must be
      // re-stated here or they will be lost on POSIX.
      GIT_OPTIONAL_LOCKS: "0",
      GCM_INTERACTIVE: "Never",
    });
  }
  return git;
}
