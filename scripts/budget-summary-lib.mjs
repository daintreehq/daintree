// Shared markdown-summary formatter for the performance-budget CI gates.
//
// Every budget-check script (compiler bailouts, eager import counts, renderer
// bundle size, first-render chunk gzip) emits a markdown file under dist/ so a
// downstream workflow can aggregate all of them into a single PR comment. To
// keep that aggregation cheap and the comment under GitHub's 65,536-character
// limit, each script produces a uniform collapsible block:
//
//   <details>
//   <summary>{plain-text PASS/FAIL one-liner}</summary>
//
//   ## {title}
//
//   ### {section heading}
//   {section body lines}
//
//   </details>
//
// The blank lines around <summary> and </details> are load-bearing: GitHub
// Flavored Markdown only renders tables/lists inside <details> when a blank
// line separates the HTML tags from the markdown body. The <summary> text must
// be plain (no markdown syntax) so it renders in the collapsed state.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// GitHub rejects PR/issue comments over 65,536 characters with a 422. Aggregating
// five summaries into one comment means each must stay well under that ceiling;
// 65,000 leaves headroom for the aggregator's own framing (headings, separators).
export const DEFAULT_MAX_CHARS = 65000;

// Build the collapsible body lines (everything between <summary> and the
// trailing </details>) from the title + sections. Kept separate from the
// wrapper so the size guard can truncate body lines without disturbing the
// <details>/<summary>/</details> scaffolding.
function buildBodyLines(title, sections) {
  const lines = [`## ${title}`];
  for (const section of sections) {
    const body = Array.isArray(section.body) ? section.body : [];
    // Skip empty sections entirely — an empty "### Regressions" heading is noise.
    if (body.length === 0) continue;
    lines.push("");
    if (section.heading) lines.push(`### ${section.heading}`, "");
    lines.push(...body);
  }
  return lines;
}

/**
 * Format a budget result as a uniform collapsible markdown summary.
 *
 * @param {Object} opts
 * @param {string} opts.title - Document heading inside the collapsible (e.g. "Compiler bailout budget").
 * @param {"PASS"|"FAIL"} opts.status - Gate result, surfaced in the <summary> one-liner.
 * @param {string} opts.headerLine - Plain-text one-liner for the <summary> tag (PASS/FAIL + key metric).
 * @param {Array<{heading?: string, body: string[]}>} opts.sections - Body sections; empty-body sections are dropped.
 * @param {number} [opts.maxChars=DEFAULT_MAX_CHARS] - Soft cap; body rows are trimmed past this length.
 * @returns {string} Markdown collapsible block (no trailing newline).
 */
export function formatBudgetSummary({
  title,
  status,
  headerLine,
  sections = [],
  maxChars = DEFAULT_MAX_CHARS,
}) {
  // The <summary> is plain text; prefix the status so the collapsed row reads
  // "PASS — ..." / "FAIL — ..." even before expansion.
  const summaryText = `${status} — ${headerLine}`;
  const open = `<details>\n<summary>${summaryText}</summary>\n`;
  const close = "\n</details>";

  const assemble = (bodyLines) => `${open}\n${bodyLines.join("\n")}\n${close}`;

  const bodyLines = buildBodyLines(title, sections);
  let out = assemble(bodyLines);
  if (out.length <= maxChars) return out;

  // Over the cap: drop body lines from the end until the assembled block fits,
  // leaving room for an omission notice. The title line (bodyLines[0]) is
  // always retained so the collapsed block still identifies itself. The closing
  // </details> is re-appended by assemble(), so truncation never leaves the
  // block unclosed.
  const total = bodyLines.length;
  const noticeFor = (omitted) =>
    `_[${omitted} line(s) omitted — summary exceeded ${maxChars}-character cap]_`;
  for (let keep = total - 1; keep >= 1; keep--) {
    const kept = bodyLines.slice(0, keep);
    const candidate = assemble([...kept, "", noticeFor(total - keep)]);
    if (candidate.length <= maxChars) return candidate;
  }
  // Degenerate case: even the title + notice overflows. Return the smallest
  // valid block — title plus notice — accepting it may still nudge over the cap
  // (it never will in practice; the wrapper + one line is a few hundred bytes).
  return assemble([bodyLines[0] ?? `## ${title}`, "", noticeFor(Math.max(total - 1, 0))]);
}

/**
 * Write a markdown summary to disk, creating the parent directory as needed.
 * Separate from formatBudgetSummary so the formatter stays pure/testable.
 *
 * @param {string} filePath - Absolute path of the summary file (e.g. dist/compiler-budget-summary.md).
 * @param {string} markdown - Markdown content (a trailing newline is appended).
 */
export function writeSummary(filePath, markdown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, markdown.endsWith("\n") ? markdown : markdown + "\n");
}
