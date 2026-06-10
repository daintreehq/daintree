const SMOKE_TEST_TERMINAL_PREFIXES = [
  "smoke-test-terminal",
  "smoke-renderer-terminal",
  "smoke-main-terminal",
  "smoke-burst-",
] as const;

export function isSmokeTestTerminalId(id: string | null | undefined): boolean {
  if (!id) return false;
  // Plain loop: called once per PTY data chunk, avoids the per-call closure of .some()
  for (const prefix of SMOKE_TEST_TERMINAL_PREFIXES) {
    if (id.startsWith(prefix)) return true;
  }
  return false;
}
