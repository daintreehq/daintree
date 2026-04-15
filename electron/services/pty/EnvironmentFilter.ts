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

const SENSITIVE_PATTERN =
  /(?:^|_)(?:SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH_TOKEN|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY)(?:_|$)/i;

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
