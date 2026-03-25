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
 * CANOPY_* vars are always stripped from inherited env and injected fresh to
 * prevent spoofing by environment state or external tools.
 */

const CANOPY_PREFIX = "CANOPY_";

/**
 * Exact env var names that are always blocked regardless of context.
 * These are the most common credentials found in developer environments.
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

/**
 * Pattern matching sensitive words as complete segments in a var name.
 * Anchored to segment boundaries (start-of-string or underscore prefix)
 * to reduce false positives.
 *
 * Examples that match:
 *   MY_SECRET_VALUE, DB_PASSWORD, GITHUB_TOKEN, ANTHROPIC_API_KEY,
 *   AWS_ACCESS_KEY, STRIPE_PRIVATE_KEY, AZURE_CLIENT_CREDENTIAL
 *
 * Examples that do NOT match:
 *   SECRETARIAT (no _ before SECRET and no _ after),
 *   PASSTHROUGH (no _ boundary), TERM (not TOKEN), PATH (not PASS)
 */
const SENSITIVE_PATTERN =
  /(?:^|_)(?:SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH_TOKEN|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY)(?:_|$)/i;

/**
 * Metadata to inject as CANOPY_* vars in each spawned terminal.
 * Provides agent-readable context about the terminal's identity and location.
 */
export interface CanopyTerminalMetadata {
  paneId: string;
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}

/**
 * Returns true if the given env var name is considered sensitive.
 * Used for filtering and can be called independently for testing.
 */
export function isSensitiveVar(name: string): boolean {
  return SENSITIVE_EXACT.has(name.toUpperCase()) || SENSITIVE_PATTERN.test(name);
}

/**
 * Filter an environment object, removing sensitive variables and CANOPY_* vars.
 * Undefined values are also stripped (node-pty requires Record<string, string>).
 */
export function filterEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith(CANOPY_PREFIX)) continue;
    if (isSensitiveVar(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Inject CANOPY_* metadata into a filtered environment.
 * Returns a new object — does not mutate the input.
 */
const UTF8_PATTERN = /utf-?8/i;

/**
 * Ensure the environment has a UTF-8 locale set in LANG.
 * If LANG is already UTF-8, the env is returned unchanged.
 * Otherwise, LANG is set to en_US.UTF-8 as a safe fallback.
 * Never touches LC_ALL — it's too aggressive an override.
 */
export function ensureUtf8Locale(env: Record<string, string>): Record<string, string> {
  if (env.LANG && UTF8_PATTERN.test(env.LANG)) {
    return { ...env };
  }
  return { ...env, LANG: "en_US.UTF-8" };
}

export function injectCanopyMetadata(
  env: Record<string, string>,
  metadata: CanopyTerminalMetadata
): Record<string, string> {
  const result: Record<string, string> = { ...env };
  result.CANOPY_PANE_ID = metadata.paneId;
  result.CANOPY_CWD = metadata.cwd;
  if (metadata.projectId) result.CANOPY_PROJECT_ID = metadata.projectId;
  if (metadata.worktreeId) result.CANOPY_WORKTREE_ID = metadata.worktreeId;
  return result;
}
