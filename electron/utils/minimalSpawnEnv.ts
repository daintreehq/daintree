/**
 * The single environment allowlist every process the host spawns on a plugin's
 * behalf is built from (#11300). Three call sites share it — the pipe-mode
 * `child_process.spawn` in {@link import("../services/plugin/PluginProcessManager.js").PluginProcessManager},
 * the interactive `node-pty` spawn in the pty-host, and the plugin worker's
 * `utilityProcess.fork` — so "what env does a plugin's code see" has exactly
 * one answer and the three can never drift into parallel allowlists.
 */

/**
 * Env vars a child needs to function (PATH lookup, locale, temp, OS essentials)
 * WITHOUT inheriting the main process's secrets (API tokens, auth keys). A
 * plugin passes anything else it needs explicitly via `options.env`.
 *
 * The Windows entries are load-bearing beyond convenience: ConPTY fails to
 * allocate without `SystemRoot`/`COMSPEC`/`PATHEXT`, and `TEMP`/`TMP` are the
 * only writable scratch a Windows child can assume.
 */
export const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
] as const;

/**
 * Build a child environment from {@link SAFE_ENV_KEYS} plus `extra`. `extra`
 * wins on collision, so a caller can override an allowlisted key (e.g. a plugin
 * pinning its own `PATH`) but can never widen the base beyond the allowlist.
 *
 * Read live from `process.env` on every call rather than snapshotting at module
 * load — the host refreshes `PATH` after boot (#8625), and a snapshot taken
 * before that refresh would hand plugins a stale PATH missing version-manager
 * shims.
 */
export function minimalSpawnEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") base[key] = value;
  }
  return { ...base, ...extra };
}
