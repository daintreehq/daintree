/**
 * Shared utilities for environment variable handling
 */

const SENSITIVE_ENV_KEY_RE = /KEY|SECRET|TOKEN|PASSWORD/i;

/**
 * Determines if an environment variable key should be stored securely
 */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}
