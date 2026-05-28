// Pure helpers for the weekly stale-quarantine cron
// (.github/workflows/stale-quarantine.yml). Scans Playwright spec sources for
// `type: "quarantine"` annotations, parses the leading YYYY-MM-DD date from each
// description, and flags any older than the staleness threshold.
//
// No import-time side effects — safe for Vitest and for dynamic import from
// actions/github-script.

export const STALE_THRESHOLD_DAYS = 30;

const MS_PER_DAY = 86_400_000;

// Remove block comments and fully-commented lines so commented-out annotations
// are ignored. Line comments are only stripped when `//` is the first
// non-whitespace on the line — a trailing or in-string `//` (including `://` in
// a URL) is left untouched, so description literals are never corrupted.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
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

// Parses a strict YYYY-MM-DD date to epoch ms, or null if it is malformed or a
// calendar overflow (e.g. 2026-02-31, which Date would silently roll to March).
function parseQuarantineDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  // The round-tripped date must equal the input — rejects overflowed days.
  if (new Date(ms).toISOString().slice(0, 10) !== dateStr) return null;
  return ms;
}

// Whole-day age of a YYYY-MM-DD date relative to `now`. Returns Infinity for an
// unparseable date so callers treat it as stale rather than silently skipping
// it; a future date yields a negative age.
export function daysSince(dateStr, now = new Date()) {
  const ms = parseQuarantineDate(dateStr);
  if (ms === null) return Infinity;
  return Math.floor((now.getTime() - ms) / MS_PER_DAY);
}

export function isStale(dateStr, now = new Date(), threshold = STALE_THRESHOLD_DAYS) {
  // A missing or malformed date is surfaced, not hidden: an undated quarantine
  // is exactly the kind of rot this cron exists to catch.
  if (!dateStr) return true;
  const age = daysSince(dateStr, now);
  // Past the threshold is stale; a future date (negative age) is almost
  // certainly a typo, so surface it too.
  return age < 0 || age > threshold;
}

// Whole-day age, or null when the date is missing or unparseable.
function ageInDays(dateStr, now) {
  const days = daysSince(dateStr, now);
  return Number.isFinite(days) ? days : null;
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
        ageDays: ageInDays(annotation.date, now),
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

function formatAge(ageDays) {
  if (ageDays === null) return "no parseable date";
  if (ageDays < 0) return "dated in the future";
  return `${ageDays} days old`;
}

export function buildIssueBody(specPath, staleEntries, runUrl) {
  const lines = [
    `\`${specPath}\` has quarantined annotations older than ${STALE_THRESHOLD_DAYS} days.`,
    "",
    "Fix the spec and remove its `type: \"quarantine\"` annotation, or formally retire the test.",
    "",
  ];

  for (const entry of staleEntries) {
    lines.push(
      `- **${entry.date ?? "undated"}** (${formatAge(entry.ageDays)}) — ${entry.description}`
    );
  }

  if (runUrl) {
    lines.push("", `**Run:** ${runUrl}`);
  }

  // Inert dedup marker — the workflow currently matches by title, but this keeps
  // a future marker-based migration mechanical.
  lines.push("", `<!-- stale-quarantine-spec:${specPath} -->`);

  return lines.join("\n");
}
