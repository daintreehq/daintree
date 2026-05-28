/**
 * Shared GitHub `issues/new` URL primitives. GitHub's Nginx fronts the issue
 * form at an ~8 KiB URL hard cap; the body budget below also stays under the
 * Windows `shell.openExternal` ~2,048-char ceiling. Extracted so the error
 * boundary, crash reporter, and diagnostics bundle share one budget and one
 * truncation ladder instead of duplicating the constants.
 */

export const REPO_ISSUE_URL = "https://github.com/daintreehq/daintree/issues/new";

/**
 * Encoded-body budget. Reserve ~1 KiB for base URL + title + percent-encoding
 * fudge, leaving ~7 KB for the encoded body. Measured against
 * `encodeURIComponent` because newlines and backticks inflate 1→3 bytes.
 */
export const URL_BODY_BUDGET = 7000;

/** Encoded-title budget, capped separately so a long title can't blow the cap. */
export const TITLE_ENCODED_BUDGET = 200;

// When a stack must be middle-truncated we keep the top frames (where the throw
// originates) and the tail (where it bubbled up). 15+5 fits a typical stack
// while leaving the truncation visible.
const STACK_HEAD_LINES = 15;
const STACK_TAIL_LINES = 5;

export const STACK_MIDDLE_PLACEHOLDER =
  "  ... [middle frames truncated — see clipboard for full stack] ...";

export function truncateStackMiddle(stack: string): string {
  const lines = stack.split("\n");
  if (lines.length <= STACK_HEAD_LINES + STACK_TAIL_LINES) return stack;
  const head = lines.slice(0, STACK_HEAD_LINES);
  const tail = lines.slice(-STACK_TAIL_LINES);
  return [...head, STACK_MIDDLE_PLACEHOLDER, ...tail].join("\n");
}

/**
 * Trim `value` until its `encodeURIComponent` length fits `budget`, leaving
 * room for a trailing ellipsis. Walks by character to avoid slicing into a
 * multi-byte surrogate pair.
 */
export function capForBudget(value: string, budget: number): string {
  if (encodeURIComponent(value).length <= budget) return value;
  const ellipsis = "…";
  const ellipsisLen = encodeURIComponent(ellipsis).length;
  const chars = Array.from(value);
  while (chars.length > 0) {
    const trimmed = chars.join("");
    if (encodeURIComponent(trimmed).length + ellipsisLen <= budget) {
      return trimmed + ellipsis;
    }
    chars.pop();
  }
  return ellipsis;
}

export function makeUrl(title: string, body: string): string {
  return `${REPO_ISSUE_URL}?title=${encodeURIComponent(capForBudget(title, TITLE_ENCODED_BUDGET))}&body=${encodeURIComponent(body)}`;
}

/** Environment fields rendered into the diagnostics issue body summary. */
export interface DiagnosticsIssueMetadata {
  appVersion?: string;
  electronVersion?: string;
  nodeVersion?: string;
  platform?: string;
  osVersion?: string;
}

/**
 * Build the GitHub issue URL paired with a saved diagnostics bundle. The body
 * is a short, static template (env summary + repro skeleton + ZIP note). The
 * env values come from controlled system APIs so they're short in practice,
 * but the body is still capped to the shared budget so a pathological version
 * string can't blow the URL cap, and the title routes through `makeUrl`.
 */
export function buildDiagnosticsIssueUrl(metadata: DiagnosticsIssueMetadata): string {
  const envParts: string[] = [];
  if (metadata.appVersion) envParts.push(`- **Daintree:** ${metadata.appVersion}`);
  const osLine = [metadata.platform, metadata.osVersion].filter(Boolean).join(" ");
  if (osLine) envParts.push(`- **OS:** ${osLine}`);
  if (metadata.electronVersion) envParts.push(`- **Electron:** ${metadata.electronVersion}`);
  if (metadata.nodeVersion) envParts.push(`- **Node:** ${metadata.nodeVersion}`);
  const envSummary = envParts.length > 0 ? envParts.join("\n") : "- _(unknown)_";

  const body =
    `## Environment\n\n${envSummary}\n\n` +
    `## Steps to reproduce\n\n1. \n2. \n3. \n\n` +
    `## Expected behavior\n\n\n` +
    `## Actual behavior\n\n\n` +
    `---\n\n` +
    `Diagnostics bundle attached separately — drag the saved ZIP into this issue.\n`;

  return makeUrl("Diagnostics report", capForBudget(body, URL_BODY_BUDGET));
}
