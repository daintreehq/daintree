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
  return buildEnv(SAFE_ENV_KEYS, extra);
}

/**
 * Network transport configuration — proxy endpoints and CA bundle locations.
 * Not credentials: these say *how* to reach the network, not who you are, and
 * omitting them is the documented cause of silent TLS failures behind a
 * corporate interception proxy (`buildInstallEnv` in `./spawnEnv.ts` carries the
 * same set for the same reason, and `errorClassification.ts` tells users to set
 * `NODE_EXTRA_CA_CERTS` when it sees one).
 */
const NETWORK_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/**
 * Environment for the plugin worker `utilityProcess.fork` — {@link SAFE_ENV_KEYS}
 * plus {@link NETWORK_ENV_KEYS}.
 *
 * Wider than the children a plugin spawns, deliberately and only by that set.
 * The worker hosts network-capable plugins in-process (the built-in GitHub forge
 * provider calls `https://api.github.com` from inside it), and `env` REPLACES
 * `process.env` in a utility process — so a user behind a TLS-inspecting proxy
 * would see every plugin's HTTPS call fail with no compile-time signal that
 * anything was dropped. A plugin's own children stay on the tighter list: they
 * are arbitrary user-named binaries, and a plugin that needs proxy settings for
 * one passes them explicitly via `options.env`.
 */
export function minimalWorkerEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return buildEnv([...SAFE_ENV_KEYS, ...NETWORK_ENV_KEYS], extra);
}

function buildEnv(
  keys: readonly string[],
  extra: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") base[key] = value;
  }
  return { ...base, ...extra };
}
