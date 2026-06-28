/**
 * Structured result of a test/lint/build check that an agent ran inside a PTY.
 *
 * Daintree is the PRODUCER of this signal (cross-repo Wave 1); the Assistant
 * consumes it over MCP via `terminal.getStatus` to route on real pass/fail
 * instead of scraping terminal tail output.
 *
 * IMPORTANT — this is a PARSED, best-effort signal, not an authoritative exit
 * code. The agent CLI (Claude/Gemini/Codex) runs the check as a child process
 * inside the PTY, so node-pty never observes the subcommand's real exit code —
 * only its stdout/stderr bytes. `passed` is derived from recognized tool
 * summary lines (tsc/ESLint/Vitest/Jest), so it is high-precision but not
 * exhaustive: an absent `lastCheckResult` means "no recognized check summary
 * was seen", NOT "no check ran". Consumers must read `ranAt` for freshness.
 */
export interface TerminalCheckResult {
  /**
   * Best-effort command that produced this result (e.g. `"npm run check"`),
   * extracted from a nearby command echo. `null` when no command line was
   * recoverable from the recent output window.
   */
  command: string | null;
  /** True when the parsed tool summary reported zero errors/failures. */
  passed: boolean;
  /** Wall-clock ms timestamp when this result was captured (at the agent state transition). */
  ranAt: number;
  /**
   * On failure, a capped slice of the recent error/summary lines. `null` when
   * `passed` is true.
   */
  failureSummary: string | null;
  /** True when `failureSummary` was truncated to the size cap. */
  truncated: boolean;
}
