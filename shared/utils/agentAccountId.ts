const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An account id (#16040) as settings and presets store it. Its own module so
 * the preset sanitiser can read a preset's pinned account without importing
 * `agentAccounts.ts`, which already imports from it.
 */
export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}
