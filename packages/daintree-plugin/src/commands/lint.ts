import { lintPlugin, type LintFinding, type LintResult } from "../lib/lint/index.js";

export interface LintCommandOptions {
  /** Plugin directory (default: cwd). */
  dir?: string;
  /** Fail on warnings as well as errors. */
  strict?: boolean;
  /** Compile the view's classes against the design contract (default: true). */
  styleReport?: boolean;
}

export interface LintCommandResult extends LintResult {
  /** False when there are errors, or warnings under `strict`. */
  ok: boolean;
}

/**
 * Source-level performance and consistency checks, plus the offline style
 * report. Kept apart from `validate`, which stays manifest-only: this reads the
 * plugin's code, which a manifest check never has to.
 */
export async function runLint(opts: LintCommandOptions = {}): Promise<LintCommandResult> {
  const result = await lintPlugin({ dir: opts.dir, styleReport: opts.styleReport });
  const ok = result.errorCount === 0 && (!opts.strict || result.warningCount === 0);
  return { ...result, ok };
}

/** `file:line [rule] message`, the shape `doctor` folds into its own lists. */
export function formatFindingInline(finding: LintFinding): string {
  return `${finding.file}:${finding.line} [${finding.ruleId}] ${finding.message} — ${finding.hint}`;
}

/** Human output: findings grouped by file, each with its rule id and a one-line fix. */
export function formatLintReport(result: LintCommandResult): string[] {
  const lines: string[] = [];
  let currentFile: string | null = null;
  for (const finding of result.findings) {
    if (finding.file !== currentFile) {
      if (currentFile !== null) lines.push("");
      lines.push(finding.file);
      currentFile = finding.file;
    }
    const mark = finding.severity === "error" ? "✗" : "⚠";
    lines.push(
      `  ${String(finding.line).padStart(4)}  ${mark}  ${finding.ruleId}  ${finding.message}`
    );
    lines.push(`        fix: ${finding.hint}`);
  }
  if (result.notes.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const note of result.notes) lines.push(`ℹ  ${note}`);
  }
  if (lines.length > 0) lines.push("");
  const fileCount = `${result.files.length} file${result.files.length === 1 ? "" : "s"}`;
  if (result.findings.length === 0) {
    lines.push(`✓ No lint findings in ${fileCount}`);
  } else {
    const errors = `${result.errorCount} error${result.errorCount === 1 ? "" : "s"}`;
    const warnings = `${result.warningCount} warning${result.warningCount === 1 ? "" : "s"}`;
    lines.push(`${result.ok ? "⚠" : "✗"} ${errors}, ${warnings} in ${fileCount}`);
  }
  return lines;
}
