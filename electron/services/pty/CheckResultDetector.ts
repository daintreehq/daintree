import type { TerminalCheckResult } from "../../../shared/types/checkResult.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";

/**
 * Parses recent terminal output for a recognized test/lint/build summary and
 * derives a structured pass/fail signal. PRODUCER side of issue #10682.
 *
 * This is deliberately PRECISION-over-recall: it only fires on specific tool
 * summary formats (tsc/ESLint/Vitest/Jest) that rarely appear in agent prose,
 * so a `null` return means "no recognized check summary in this window", not
 * "the check passed" and not "no check ran". The real subcommand exit code is
 * unobservable (the check is a child of the agent CLI inside the PTY), so
 * `passed` is parsed from the summary text — see `TerminalCheckResult`.
 */

const FAILURE_SUMMARY_MAX_CHARS = 600;
// How far above the summary line to look for the command echo / error lines.
const LOOKBACK_LINES = 30;
const COMMAND_MAX_CHARS = 120;

/** Lines that indicate a failure, used to assemble `failureSummary`. */
const ERROR_LINE_RE = /\b(error|errors|fail|failed|failure|failing)\b|error TS\d+|[✖✗×]|\bFAIL\b/i;

type SummaryKind = "tsc" | "eslint" | "test-counts" | "script";

/**
 * Package-runner lifecycle epilogues, printed by the runner itself when a
 * script exits non-zero. Failure-only signals (runners print nothing extra on
 * success), runner-emitted rather than prose, so they stay inside the
 * precision-over-recall contract. They catch failures whose tool summary we
 * don't recognize (or that crashed before printing one).
 */
const SCRIPT_FAILURE_PATTERNS: RegExp[] = [
  /\bELIFECYCLE\b.*Command failed with exit code \d+/, // pnpm
  /^npm error Lifecycle script `[^`]+` failed/, // npm >= 10
  /^npm ERR! code ELIFECYCLE/, // npm legacy
  /^error Command failed with exit code \d+\./, // yarn v1
  /^error: script "[^"]+" exited with code \d+/, // bun
];

interface SummaryVerdict {
  passed: boolean;
  kind: SummaryKind;
}

/**
 * Verdict for a single Vitest/Jest "Test Files"/"Tests" count row, or `null`
 * when the line is not such a row.
 *   Vitest: "Tests  2 failed | 8 passed (10)" / "Tests  10 passed (10)"
 *   Jest:   "Tests:       2 failed, 8 passed, 10 total"
 */
function classifyTestCountRow(line: string): boolean | null {
  if (!/\b(Test Files|Tests)\b[:\s]/.test(line) || !/\bpassed\b|\bfailed\b/.test(line)) {
    return null;
  }
  const failedMatch = line.match(/(\d+) failed/);
  if (failedMatch) {
    return Number(failedMatch[1]) === 0;
  }
  // A "passed" row with no "failed" count is a clean run.
  if (/\d+ passed/.test(line)) {
    return true;
  }
  return null;
}

/**
 * Classify a single (ANSI-stripped) line as a known tool summary. Returns the
 * pass/fail verdict, or `null` when the line is not a recognized summary.
 */
function classifySummaryLine(line: string): SummaryVerdict | null {
  // TypeScript (tsc): "Found 0 errors." / "Found 3 errors in 2 files."
  const tsc = line.match(/\bFound (\d+) errors?\b/);
  if (tsc) {
    return { passed: Number(tsc[1]) === 0, kind: "tsc" };
  }

  // ESLint: "✖ 5 problems (3 errors, 2 warnings)" — verdict keys off errors,
  // not warnings (a lint run with only warnings still "passes" the gate).
  const eslint = line.match(/\b(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (eslint) {
    return { passed: Number(eslint[2]) === 0, kind: "eslint" };
  }

  const testRow = classifyTestCountRow(line);
  if (testRow !== null) {
    return { passed: testRow, kind: "test-counts" };
  }

  if (SCRIPT_FAILURE_PATTERNS.some((p) => p.test(line))) {
    return { passed: false, kind: "script" };
  }

  return null;
}

/** Extract a best-effort command echo from the lines above the summary. */
function findCommand(lines: string[], summaryIndex: number): string | null {
  const start = Math.max(0, summaryIndex - LOOKBACK_LINES);
  // Match common script-runner / direct-invocation echoes.
  const commandRe =
    /((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:@./-]+(?:\s+[\w:@./-]+)?|npx\s+[\w@./-]+|\b(?:tsc|eslint|vitest|jest)\b[^\n]*)/;
  for (let i = summaryIndex; i >= start; i--) {
    const raw = lines[i];
    // npm prints the script body as "> tsc --noEmit"; strip the leading marker.
    const cleaned = raw.replace(/^\s*[>$%#]\s*/, "").trim();
    // Runner error epilogues ("npm error Lifecycle script …") start with the
    // runner token and would match commandRe as a bogus "npm error" command.
    if (/^npm (?:error|ERR!)/.test(cleaned)) continue;
    const m = cleaned.match(commandRe);
    if (m) {
      const command = m[1].trim();
      return command.length > COMMAND_MAX_CHARS
        ? command.slice(0, COMMAND_MAX_CHARS) + "…"
        : command;
    }
  }
  return null;
}

/** Assemble a capped failure summary from error lines near the summary. */
function collectFailureSummary(
  lines: string[],
  summaryIndex: number
): { summary: string; truncated: boolean } {
  const start = Math.max(0, summaryIndex - LOOKBACK_LINES);
  const collected: string[] = [];
  for (let i = start; i <= summaryIndex; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (i === summaryIndex || ERROR_LINE_RE.test(line)) {
      collected.push(line);
    }
  }
  // Always include the summary line itself even if nothing else matched.
  if (collected.length === 0) {
    collected.push(lines[summaryIndex].trim());
  }
  const joined = collected.join("\n");
  if (joined.length > FAILURE_SUMMARY_MAX_CHARS) {
    // Keep the TAIL — the summary line and the most recent errors are the
    // load-bearing part; older error spew is less useful.
    return { summary: joined.slice(-FAILURE_SUMMARY_MAX_CHARS), truncated: true };
  }
  return { summary: joined, truncated: false };
}

/**
 * Detect a structured check result from recent terminal output.
 *
 * @param rawText Recent terminal output (may contain ANSI codes).
 * @param ranAt   Capture timestamp (ms) to stamp on the result.
 * @returns The parsed result, or `null` when no recognized check summary is found.
 */
export function detectCheckResult(rawText: string, ranAt: number): TerminalCheckResult | null {
  if (!rawText) return null;
  const lines = stripAnsiCodes(rawText).split("\n");

  // Scan bottom-up for the most recent recognized summary line.
  let summaryIndex = -1;
  let verdict: SummaryVerdict | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = classifySummaryLine(lines[i]);
    if (v) {
      summaryIndex = i;
      verdict = v;
      break;
    }
  }

  if (summaryIndex === -1 || verdict === null) return null;

  // Vitest/Jest print TWO adjacent rows per run ("Test Files" + "Tests"). The
  // bottom-up scan hits "Tests" first, which can read "passed" while a sibling
  // file failed to compile (0 tests ran in it). Take the pessimistic verdict
  // across the adjacent rows of the SAME run so a file-level failure isn't
  // masked. Scoped to ±3 lines so an earlier, already-fixed run isn't pulled in.
  if (verdict.kind === "test-counts" && verdict.passed) {
    const lo = Math.max(0, summaryIndex - 3);
    const hi = Math.min(lines.length - 1, summaryIndex + 3);
    for (let i = lo; i <= hi; i++) {
      if (i === summaryIndex) continue;
      if (classifyTestCountRow(lines[i]) === false) {
        verdict = { passed: false, kind: "test-counts" };
        summaryIndex = i;
        break;
      }
    }
  }

  const command = findCommand(lines, summaryIndex);
  if (verdict.passed) {
    return { command, passed: true, ranAt, failureSummary: null, truncated: false };
  }

  const { summary, truncated } = collectFailureSummary(lines, summaryIndex);
  return { command, passed: false, ranAt, failureSummary: summary, truncated };
}

/** Structural equality ignoring `ranAt` — used to suppress duplicate updates. */
export function checkResultsEqual(
  a: TerminalCheckResult | undefined,
  b: TerminalCheckResult | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.command === b.command &&
    a.passed === b.passed &&
    a.failureSummary === b.failureSummary &&
    a.truncated === b.truncated
  );
}
