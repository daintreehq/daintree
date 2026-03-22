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

export const EXPECTED_TERMINATION_SIGNALS = new Set<number>([
  1, // SIGHUP (terminal closed)
  2, // SIGINT (user interrupt)
  13, // SIGPIPE (broken pipe)
  15, // SIGTERM (polite shutdown)
]);

const CRASH_SIGNALS = new Set<number>([
  4, // SIGILL (illegal instruction)
  6, // SIGABRT (abort)
  7, // SIGBUS (bus error)
  8, // SIGFPE (floating point exception)
  9, // SIGKILL (force kill / OOM killer)
  11, // SIGSEGV (segfault)
]);

export function isRoutineExit(code: number, signal?: number | null): boolean {
  if (signal && CRASH_SIGNALS.has(signal)) return false;
  if (code > 128 && CRASH_SIGNALS.has(code - 128)) return false;
  return true;
}

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
