const SMOKE_TEST_TERMINAL_PREFIXES = [
  "smoke-test-terminal",
  "smoke-renderer-terminal",
  "smoke-main-terminal",
  "smoke-burst-",
] as const;

export function isSmokeTestTerminalId(id: string | null | undefined): boolean {
  if (!id) return false;
  return SMOKE_TEST_TERMINAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}
