import os from "os";
import path from "path";
import { getEnvVar, hasEnvVar, mergeEnvVars } from "../pty/EnvironmentFilter.js";

const HOME_VAR = "CODEX_HOME";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The Codex home a process started with `env` uses: its `CODEX_HOME`, or
 * `~/.codex` when it names none or an empty one, which Codex takes as unset.
 * An account launch puts the account's folder there (#16040), so for an
 * account pane this is the account's home.
 *
 * Read the way the env is applied to the child, exact on POSIX and
 * case-insensitive on Windows, and untrimmed, as the pane gets it. Undefined
 * for a relative value: Codex would resolve it against the pane's own folder,
 * and a guess here reads some other home.
 */
export function resolveLaunchCodexHome(env: EnvLike): string | undefined {
  const fallback = path.join(launchHomeDir(env), ".codex");
  if (!hasEnvVar(env, HOME_VAR)) return fallback;
  const home = getEnvVar(env, HOME_VAR);
  if (!home) return fallback;
  return isFullyQualified(home) ? path.resolve(home) : undefined;
}

/**
 * Whether a process started with `overrides` on top of this one's environment
 * uses this process's own Codex home (#18169), merged and compared the way a
 * pane's env is applied: case-insensitively on Windows. A home that can't be
 * told (a relative one) is never taken for this one.
 */
export function usesOwnCodexHome(
  overrides: Readonly<Record<string, string>> | undefined,
  base: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const inherited = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const own = resolveLaunchCodexHome(inherited);
  const launched = resolveLaunchCodexHome(
    overrides ? mergeEnvVars(inherited, overrides) : inherited
  );
  if (own === undefined || launched === undefined) return false;
  return process.platform === "win32"
    ? own.toLowerCase() === launched.toLowerCase()
    : own === launched;
}

/**
 * Windows calls `\work` absolute, but it takes the drive of whichever cwd
 * resolves it: the CLI's, in the pane's folder, not this process's.
 */
function isFullyQualified(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

/**
 * The home folder Codex resolves `~` against in that process: the env's own
 * `HOME` (`USERPROFILE` on Windows) when a launch set an absolute one, else
 * this process's.
 */
function launchHomeDir(env: EnvLike): string {
  const named = getEnvVar(env, process.platform === "win32" ? "USERPROFILE" : "HOME");
  return named && isFullyQualified(named) ? path.resolve(named) : os.homedir();
}
