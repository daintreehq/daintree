/**
 * Allowlist-based environment construction for child processes that capture
 * stdout/stderr surfaced into the renderer (agent help/version/install probes
 * and recipe runners).
 *
 * Allowlist (not denylist) is the security boundary: the universe of secret
 * env-var names is unbounded (`MY_SERVICE_TOKEN`, `APP_DB_PASS`, ...), so
 * blocking known-bad keys is structurally insufficient. Only well-known
 * non-credential keys pass through. Dangerous loader/injection vars
 * (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`,
 * `ELECTRON_RUN_AS_NODE`, ...) are excluded by virtue of not being on the
 * allowlist; no explicit strip step is required.
 *
 * Two variants:
 *   - `buildProbeEnv()`  — minimum needed to resolve and run a CLI binary
 *                          for `--help` / `--version`. No network keys.
 *   - `buildInstallEnv()` — adds proxy, CA, version-manager, and OS config
 *                          dirs needed by `npm install -g`, `pipx install`,
 *                          `brew install`, etc.
 *
 * The install variant must include `HOME` on macOS/Linux and `APPDATA`/
 * `USERPROFILE` on Windows — `npm` and `pipx` resolve user-level config
 * (`.npmrc`, `~/.config/pipx`) from these. Omitting them silently breaks
 * private-registry auth for users behind corporate proxies.
 *
 * Callers must invoke after `app.ready` and after any startup `fixPath()`
 * has completed, since these functions read `process.env.PATH` directly.
 * IPC-handled service methods are safe by construction.
 */

import os from "os";

const PROBE_KEYS_POSIX = new Set(["PATH", "HOME", "LANG", "LANGUAGE"]);
const PROBE_KEYS_WIN32 = new Set([
  "PATH",
  "SYSTEMROOT",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "PATHEXT",
  "LANG",
  "LANGUAGE",
]);

const INSTALL_EXTRA_KEYS = new Set([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NVM_DIR",
  "FNM_DIR",
  "VOLTA_HOME",
  "PYENV_ROOT",
  "ASDF_DATA_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PIPX_HOME",
  "PIPX_BIN_DIR",
]);

// `DAINTREE_*` is the application namespace — vars like `DAINTREE_WORKTREE_PATH`
// and `DAINTREE_RECIPE_ID` are injected by recipe runners and read by spawned
// CLIs. Accepted risk: a user who mirrors a credential into a `DAINTREE_*` var
// (e.g., `DAINTREE_GITHUB_TOKEN` in CI) gets it forwarded to children.
const ALLOWED_PREFIXES = ["LC_", "DAINTREE_"];

function defaultPath(): string {
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    return `${sysRoot}\\System32;${sysRoot};${sysRoot}\\System32\\Wbem`;
  }
  return "/usr/local/bin:/usr/bin:/bin";
}

function buildAllowlistEnv(allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const source = process.env;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (allowed.has(upper) || ALLOWED_PREFIXES.some((p) => upper.startsWith(p))) {
      out[key] = value;
    }
  }

  if (!Object.keys(out).some((k) => k.toUpperCase() === "PATH")) {
    out.PATH = defaultPath();
  }

  if (process.platform === "win32") {
    if (!Object.keys(out).some((k) => k.toUpperCase() === "SYSTEMROOT")) {
      out.SystemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    }
    if (!Object.keys(out).some((k) => k.toUpperCase() === "USERPROFILE")) {
      out.USERPROFILE = os.homedir();
    }
    if (!Object.keys(out).some((k) => k.toUpperCase() === "TEMP")) {
      out.TEMP = os.tmpdir();
    }
    if (!Object.keys(out).some((k) => k.toUpperCase() === "TMP")) {
      out.TMP = os.tmpdir();
    }
    if (!Object.keys(out).some((k) => k.toUpperCase() === "PATHEXT")) {
      out.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    }
  } else if (!Object.keys(out).some((k) => k.toUpperCase() === "HOME")) {
    out.HOME = os.homedir();
  }

  out.TERM = "dumb";
  return out;
}

function probeKeys(): Set<string> {
  return process.platform === "win32" ? PROBE_KEYS_WIN32 : PROBE_KEYS_POSIX;
}

/**
 * Tight allowlist for `--help` / `--version` probes. Includes only what's
 * required to resolve and execute a CLI binary, plus locale (for non-ASCII
 * help output) and DAINTREE_* prefix vars. No proxy, no version-manager
 * dirs, no XDG dirs, no credential-shaped keys.
 */
export function buildProbeEnv(): Record<string, string> {
  return buildAllowlistEnv(probeKeys());
}

/**
 * Broader allowlist for install runners (`npm install -g`, `pipx install`,
 * `brew install`, ...). Adds proxy, CA, version-manager, XDG, and pipx
 * config keys to the probe set. `HOME` (or `APPDATA`/`USERPROFILE` on
 * Windows) is always present so package managers can locate user config.
 */
export function buildInstallEnv(): Record<string, string> {
  const allowed = new Set([...probeKeys(), ...INSTALL_EXTRA_KEYS]);
  return buildAllowlistEnv(allowed);
}
