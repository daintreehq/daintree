/**
 * Shared utilities for environment variable handling
 */

const SENSITIVE_ENV_KEY_RE =
  /(?<![A-Za-z])(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?|PASSPHRASE)(?![A-Za-z])/i;

/**
 * Determines if an environment variable key should be stored securely
 */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name a POSIX shell can export. */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}
