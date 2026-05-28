// Pure helpers for the weekly stale-quarantine cron
// (.github/workflows/stale-quarantine.yml). Scans Playwright spec sources for
// `type: "quarantine"` annotations, parses the leading YYYY-MM-DD date from each
// description, and flags any older than the staleness threshold.
//
// No import-time side effects — safe for Vitest and for dynamic import from
// actions/github-script.

export const STALE_THRESHOLD_DAYS = 30;

const MS_PER_DAY = 86_400_000;

// Remove block comments and line comments so commented-out annotations are
// ignored. The line-comment pass keeps a non-`:` lookahead so `://` inside a URL
// in a description is never mistaken for a comment.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

// Matches `type: "quarantine"` immediately followed by `description: "<value>"`.
// `[\s\S]*?` between the two keys tolerates the newline that wraps a long
// description onto its own line; the backreferences allow single or double
// quotes. The leading date is parsed separately from the captured description.
const ANNOTATION_RE =
  /type:\s*(['"])quarantine\1\s*,\s*description:\s*(['"])([\s\S]*?)\2/g;

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;

export function extractQuarantineAnnotations(source) {
  const cleaned = stripComments(source);
  const annotations = [];
  for (const match of cleaned.matchAll(ANNOTATION_RE)) {
    const description = match[3].trim();
    const dateMatch = description.match(DATE_RE);
    annotations.push({ description, date: dateMatch ? dateMatch[1] : null });
  }
  return annotations;
}

// Whole-day age of a YYYY-MM-DD date relative to `now`. Returns Infinity for an
// unparseable date so callers treat it as stale rather than silently skipping it.
export function daysSince(dateStr, now = new Date()) {
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return Infinity;
  return Math.floor((now.getTime() - then) / MS_PER_DAY);
}

export function isStale(dateStr, now = new Date(), threshold = STALE_THRESHOLD_DAYS) {
  // A missing or malformed date is surfaced, not hidden: an undated quarantine
  // is exactly the kind of rot this cron exists to catch.
  if (!dateStr) return true;
  return daysSince(dateStr, now) > threshold;
}

// Groups stale annotations by spec. `files` is `{ path, source }[]` so the pure
// grouping logic is testable without touching the filesystem.
export function collectStaleQuarantines(files, now = new Date(), threshold = STALE_THRESHOLD_DAYS) {
  const results = [];
  for (const { path, source } of files) {
    const stale = extractQuarantineAnnotations(source)
      .filter((annotation) => isStale(annotation.date, now, threshold))
      .map((annotation) => ({
        date: annotation.date,
        description: annotation.description,
        ageDays: annotation.date ? daysSince(annotation.date, now) : null,
      }));
    if (stale.length > 0) {
      results.push({ path, stale });
    }
  }
  return results;
}

export function buildIssueTitle(specPath) {
  return `Stale quarantined test in ${specPath}`;
}

export function buildIssueBody(specPath, staleEntries, runUrl) {
  const lines = [
    `\`${specPath}\` has quarantined annotations older than ${STALE_THRESHOLD_DAYS} days.`,
    "",
    "Fix the spec and remove its `type: \"quarantine\"` annotation, or formally retire the test.",
    "",
  ];

  for (const entry of staleEntries) {
    const age =
      entry.ageDays === null ? "no parseable date" : `${entry.ageDays} days old`;
    const date = entry.date ?? "undated";
    lines.push(`- **${date}** (${age}) — ${entry.description}`);
  }

  if (runUrl) {
    lines.push("", `**Run:** ${runUrl}`);
  }

  // Inert dedup marker — the workflow currently matches by title, but this keeps
  // a future marker-based migration mechanical.
  lines.push("", `<!-- stale-quarantine-spec:${specPath} -->`);

  return lines.join("\n");
}
