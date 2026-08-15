/**
 * Environment variable filtering for terminal spawning.
 *
 * Prevents sensitive credentials (API keys, passwords, tokens) from leaking
 * into spawned PTY processes while preserving essential infrastructure vars.
 *
 * Strategy: denylist-first using name-based heuristics. Explicit exact names
 * cover the most common credentials; a regex pattern catches user-invented
 * secret vars (e.g. MY_SERVICE_TOKEN, APP_CLIENT_SECRET).
 *
 * DAINTREE_* vars are always stripped from inherited env and injected fresh
 * to prevent spoofing by environment state or external tools.
 */

const DAINTREE_PREFIX = "DAINTREE_";

/**
 * Exact env var names that are always blocked regardless of context.
 */
const SENSITIVE_EXACT = new Set([
  // Databases
  "DATABASE_URL",
  "DB_URL",
  "DB_PASSWORD",
  "DB_PASS",
  "POSTGRES_PASSWORD",
  "POSTGRES_URL",
  "MYSQL_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "REDIS_PASSWORD",
  "MONGO_PASSWORD",
  "MONGODB_URI",
  // Cloud providers
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_ID",
  "GCP_SERVICE_ACCOUNT_KEY",
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  // AI/LLM providers
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  // Source control / CI
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  // Payment / misc services
  "STRIPE_SECRET_KEY",
  "STRIPE_API_KEY",
]);

// `APIKEY` is a non-underscored variant some SDKs use (e.g. `OPENAI_APIKEY`,
// `MY_APIKEY`); without an explicit alternation it slips past `API_KEY`.
const SENSITIVE_PATTERN =
  /(?:^|_)(?:SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY)(?:_|$)/i;

/**
 * Metadata to inject as DAINTREE_* vars in each spawned terminal.
 * Provides agent-readable context about the terminal's identity and location.
 */
export interface DaintreeTerminalMetadata {
  paneId: string;
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}

export function isSensitiveVar(name: string): boolean {
  return SENSITIVE_EXACT.has(name.toUpperCase()) || SENSITIVE_PATTERN.test(name);
}

/**
 * Windows environment variables are case-insensitive; POSIX ones are not.
 *
 * These filters and merges build plain JS objects, which are always
 * case-sensitive, and node-pty emits every key verbatim into the child's
 * environment block (`Terminal._parseEnv`). So on Windows a base env carrying
 * `Path` merged with an override carrying `PATH` produces two entries for what
 * the OS considers one variable, and the base one — being first — is the one
 * `CreateProcess` resolves. That silently defeats any override we inject
 * (#11773). The helpers below give the whole spawn-env pipeline one key per
 * Windows equivalence class; on POSIX they degrade to plain object semantics,
 * where `Path` and `PATH` really are different variables.
 */
function isCaseInsensitiveEnv(): boolean {
  return process.platform === "win32";
}

/** Normalize an env key for comparison — identity on POSIX, upper-cased on Windows. */
function foldEnvKey(key: string): string {
  return isCaseInsensitiveEnv() ? key.toUpperCase() : key;
}

/** Find the key in `env` that names `name`, honouring Windows case-insensitivity. */
function findEnvKey(env: Readonly<Record<string, unknown>>, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name)) return name;
  if (!isCaseInsensitiveEnv()) return undefined;
  const folded = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === folded);
}

/**
 * Whether `env` defines `name`. Presence, not truthiness — an explicit
 * `PATH=""` is a deliberate override and must not be treated as absent.
 */
export function hasEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): boolean {
  const key = findEnvKey(env, name);
  return key !== undefined && env[key] !== undefined;
}

/** Read `name` from `env`, honouring Windows case-insensitivity. */
export function getEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const key = findEnvKey(env, name);
  return key === undefined ? undefined : env[key];
}

/**
 * Assign `name` in `env`, writing through an existing differently-cased key
 * rather than adding a second one. Mutates `env`.
 *
 * The existing key's casing wins so the environment block a Windows child sees
 * keeps the OS's own spelling (`Path`, `ComSpec`, `ProgramFiles`) instead of
 * being rewritten to whatever casing our injection site happened to use.
 */
export function setEnvVar(env: Record<string, string>, name: string, value: string): void {
  env[findEnvKey(env, name) ?? name] = value;
}

/**
 * Merge `overrides` onto `base`, collapsing Windows case-variant keys.
 *
 * Later values win, first-seen casing is kept, and neither input is mutated.
 */
export function mergeEnvVars(
  base: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>
): Record<string, string> {
  // Both sides fold into an empty object. Seeding with `{ ...base }` would
  // normalize only the overrides, so a base that already carried two spellings
  // of one name would keep both — the guarantee has to be structural, not a
  // bet on the inputs being clean.
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    setEnvVar(result, key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    setEnvVar(result, key, value);
  }
  return result;
}

/**
 * Filter an environment object, removing sensitive variables and DAINTREE_* vars.
 * Undefined values are also stripped (node-pty requires Record<string, string>).
 *
 * Use this on **inherited `process.env`** to defend against spoofing — DAINTREE_*
 * metadata is always re-injected fresh by `injectDaintreeMetadata`, so anything
 * that snuck in via the OS environment is dropped here. For **caller-supplied env**
 * (`options.env`, preset overrides) use `filterSensitiveOnly` instead, which keeps
 * DAINTREE_* keys because the caller is intentionally setting them.
 */
export function filterEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // Case-folded on Windows: a `daintree_pane_id` exported from PowerShell
    // would otherwise survive this anti-spoofing strip and then sit beside the
    // `DAINTREE_PANE_ID` injected below as a second key the OS treats as the
    // same variable.
    if (foldEnvKey(key).startsWith(DAINTREE_PREFIX)) continue;
    if (isSensitiveVar(key)) continue;
    setEnvVar(result, key, value);
  }
  return result;
}

/**
 * Filter only sensitive variables (secrets, tokens, API keys) from an env map.
 * Unlike `filterEnvironment`, this does NOT strip `DAINTREE_*` keys — caller-
 * supplied env may legitimately set DAINTREE_* (e.g. e2e tests passing
 * DAINTREE_E2E_AGENT_COLOR through preset env so the agent CLI sees it).
 *
 * Used for caller-supplied env where the caller knows what they're doing and
 * the only safety concern is preventing their secrets from outliving an
 * acquire and leaking into a future pool consumer's shell.
 */
export function filterSensitiveOnly(
  env: Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSensitiveVar(key)) continue;
    setEnvVar(result, key, value);
  }
  return result;
}

/**
 * Whether a spawn env should receive Daintree's `FORCE_COLOR` default.
 *
 * False once the env already carries `FORCE_COLOR` (the user's own value wins)
 * or `NO_COLOR` (#11118). chalk/supports-color/ink read `FORCE_COLOR` first and
 * short-circuit, so injecting it alongside `NO_COLOR` would override the opt-out
 * and make Node print "NO_COLOR is ignored because FORCE_COLOR is set" in every
 * terminal. Presence — not truthiness — is the test, so `NO_COLOR=` counts.
 *
 * Windows env names are case-insensitive, but the filters above return plain
 * objects that preserve whatever casing the OS reported, so a `no_color` set via
 * PowerShell would slip past an uppercase lookup and land in a child process
 * that does resolve it case-insensitively. Fold case there only — on POSIX,
 * `no_color` is a genuinely different variable and must not suppress anything.
 */
export function shouldInjectForceColor(env: Record<string, string>): boolean {
  const foldCase = process.platform === "win32";
  for (const key of Object.keys(env)) {
    const name = foldCase ? key.toUpperCase() : key;
    if (name === "NO_COLOR" || name === "FORCE_COLOR") return false;
  }
  return true;
}

const UTF8_PATTERN = /utf-?8/i;

/**
 * Ensure the environment has a UTF-8 locale set in LANG.
 */
export function ensureUtf8Locale(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  const lang = getEnvVar(result, "LANG");
  if (lang && UTF8_PATTERN.test(lang)) {
    return result;
  }
  setEnvVar(result, "LANG", "en_US.UTF-8");
  return result;
}

/**
 * Inject DAINTREE_* metadata into a filtered environment.
 * Returns a new object — does not mutate the input.
 */
export function injectDaintreeMetadata(
  env: Record<string, string>,
  metadata: DaintreeTerminalMetadata
): Record<string, string> {
  const result: Record<string, string> = { ...env };
  setEnvVar(result, "DAINTREE_PANE_ID", metadata.paneId);
  setEnvVar(result, "DAINTREE_CWD", metadata.cwd);
  if (metadata.projectId) setEnvVar(result, "DAINTREE_PROJECT_ID", metadata.projectId);
  if (metadata.worktreeId) setEnvVar(result, "DAINTREE_WORKTREE_ID", metadata.worktreeId);
  return result;
}
