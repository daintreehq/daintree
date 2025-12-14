import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";

export interface TerminalForensicsDecisionInput {
  exitCode: number;
  signal?: number | null;
  wasKilled?: boolean;
  recentOutput: string;
}

export interface TerminalForensicsDecision {
  shouldLog: boolean;
  normalizedSignal?: number;
  strippedOutput: string;
}

const EXPECTED_TERMINATION_SIGNALS = new Set<number>([
  1, // SIGHUP (terminal closed)
  2, // SIGINT (user interrupt)
  15, // SIGTERM (polite shutdown)
]);

function normalizeExitSignal(signal?: number | null): number | undefined {
  if (!signal) return undefined;
  return signal;
}

function containsLikelyCrashText(strippedOutput: string): boolean {
  // Avoid noisy false positives like "✖ 2 errors" in UI chrome.
  return (
    /\b(exception|panic|fatal|segfault)\b/i.test(strippedOutput) ||
    /\bError:\b/.test(strippedOutput) ||
    /\bunhandled rejection\b/i.test(strippedOutput)
  );
}

export function decideTerminalExitForensics(
  input: TerminalForensicsDecisionInput
): TerminalForensicsDecision {
  const normalizedSignal = normalizeExitSignal(input.signal);
  const strippedOutput = stripAnsiCodes(input.recentOutput || "");

  if (input.wasKilled) {
    return { shouldLog: false, normalizedSignal, strippedOutput };
  }

  const signalUnexpected =
    normalizedSignal !== undefined && !EXPECTED_TERMINATION_SIGNALS.has(normalizedSignal);

  const shouldLog =
    input.exitCode !== 0 || signalUnexpected || containsLikelyCrashText(strippedOutput);

  return { shouldLog, normalizedSignal, strippedOutput };
}
