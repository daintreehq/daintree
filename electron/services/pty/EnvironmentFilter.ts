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
    if (key.startsWith(DAINTREE_PREFIX)) continue;
    if (isSensitiveVar(key)) continue;
    result[key] = value;
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
    result[key] = value;
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
  if (env.LANG && UTF8_PATTERN.test(env.LANG)) {
    return { ...env };
  }
  return { ...env, LANG: "en_US.UTF-8" };
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
  result.DAINTREE_PANE_ID = metadata.paneId;
  result.DAINTREE_CWD = metadata.cwd;
  if (metadata.projectId) result.DAINTREE_PROJECT_ID = metadata.projectId;
  if (metadata.worktreeId) result.DAINTREE_WORKTREE_ID = metadata.worktreeId;
  return result;
}
