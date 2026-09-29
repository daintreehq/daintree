/**
 * Pure transform utilities for diagnostic bundles. Used by both renderer
 * (preview) and main process (final save) so the preview always matches the
 * saved output.
 */

export interface ReplacementRule {
  /**
   * Match mode. `"literal"` (the back-compat default when omitted) does a plain
   * substring replace; `"regex"` compiles `find` as a global `RegExp`.
   */
  kind?: "literal" | "regex";
  find: string;
  replace: string;
}

/** Remove unchecked sections from the payload. */
export function filterSections(
  payload: Record<string, unknown>,
  enabledSections: Record<string, boolean>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (enabledSections[key] !== false) {
      result[key] = value;
    }
  }
  return result;
}

/** Apply find-and-replace redactions to a JSON string. */
export function applyReplacements(json: string, rules: ReplacementRule[]): string {
  return applyReplacementsCounted(json, rules).output;
}

/**
 * `applyReplacements`, plus what it did: how many matches each rule replaced
 * (index-aligned with `rules`) and the ranges of the output each replacement
 * wrote (`[start, end]`, inclusive). Counted in the same ordered pass, so a
 * later rule that finds nothing because an earlier one already replaced it
 * reports zero — which is what the saved report will contain. A range a later
 * rule rewrites is dropped rather than left pointing at text it no longer holds.
 */
export function applyReplacementsCounted(
  json: string,
  rules: ReplacementRule[]
): { output: string; counts: number[]; ranges: [number, number][] } {
  let out = json;
  let ranges: [number, number][] = [];
  const counts = rules.map(() => 0);
  rules.forEach((rule, i) => {
    if (!rule.find) return;
    // Where each match sat in `out` before this rule, and how long its
    // replacement is — enough to move the earlier ranges and add new ones.
    const matches: { start: number; end: number; length: number }[] = [];
    try {
      if (rule.kind === "regex") {
        const pattern = new RegExp(rule.find, "g");
        // A `$` pattern expands per match, so its output length is not known
        // up front: count it and drop the ranges rather than guess at them.
        if (rule.replace.includes("$")) {
          counts[i] = out.match(pattern)?.length ?? 0;
          out = out.replace(pattern, rule.replace);
          ranges = [];
          return;
        }
        out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
          const offset = rest.find((arg): arg is number => typeof arg === "number") ?? 0;
          matches.push({ start: offset, end: offset + match.length, length: rule.replace.length });
          return rule.replace;
        });
      } else {
        for (
          let at = out.indexOf(rule.find);
          at !== -1;
          at = out.indexOf(rule.find, at + rule.find.length)
        ) {
          matches.push({ start: at, end: at + rule.find.length, length: rule.replace.length });
        }
        out = out.split(rule.find).join(rule.replace);
      }
    } catch {
      // Skip invalid replacements (e.g. an uncompilable regex pattern), the
      // same way an empty `find` is skipped above.
      return;
    }
    counts[i] = matches.length;
    if (matches.length === 0) return;
    // Matches are sorted and disjoint, so cumulative length change and both
    // lookups below are binary searches instead of scans over every match.
    const shiftBefore: number[] = [0];
    for (const m of matches) {
      shiftBefore.push(shiftBefore[shiftBefore.length - 1]! + m.length - (m.end - m.start));
    }
    // First match whose end is past `pos`; all matches before it end at or before `pos`.
    const firstEndingAfter = (pos: number) => {
      let lo = 0;
      let hi = matches.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (matches[mid]!.end > pos) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const shiftAt = (pos: number) => pos + shiftBefore[firstEndingAfter(pos)]!;
    const moved: [number, number][] = [];
    for (const [s, e] of ranges) {
      const next = matches[firstEndingAfter(s)];
      if (next && next.start <= e) continue;
      moved.push([shiftAt(s), shiftAt(e + 1) - 1]);
    }
    const added = matches
      .filter((m) => m.length > 0)
      .map((m): [number, number] => {
        const start = shiftAt(m.start);
        return [start, start + m.length - 1];
      });
    ranges = [...moved, ...added].sort((x, y) => x[0] - y[0]);
  });
  return { output: out, counts, ranges };
}

/**
 * Drop `logs.recentEntries` older than `startMs` (ms epoch). Returns a new
 * payload (input is not mutated) so the renderer preview and the main-process
 * save apply identical filtering. `null` is a no-op (full history). Entries
 * that lack a numeric `timestamp` are kept rather than silently dropped.
 */
export function filterLogEntriesByTime(
  payload: Record<string, unknown>,
  startMs: number | null
): Record<string, unknown> {
  if (startMs === null) return payload;
  const logs = payload.logs;
  if (!logs || typeof logs !== "object") return payload;
  const entries = (logs as { recentEntries?: unknown }).recentEntries;
  if (!Array.isArray(entries)) return payload;
  const kept = entries.filter((e) => {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as { timestamp?: unknown }).timestamp === "number"
    ) {
      return (e as { timestamp: number }).timestamp >= startMs;
    }
    return true;
  });
  return { ...payload, logs: { ...(logs as Record<string, unknown>), recentEntries: kept } };
}

/** Section metadata for the review dialog. */
export interface DiagnosticSectionMeta {
  key: string;
  label: string;
}

/** Identifies a prebuilt one-click redaction toggle in the review dialog. */
export type PrebuiltRedactionId = "email" | "ip" | "filepath";

/** A prebuilt redaction toggle: a label plus the regex rules it contributes. */
export interface PrebuiltRedaction {
  id: PrebuiltRedactionId;
  label: string;
  /** Regex rules prepended (in order) to the user's rules when the toggle is on. */
  rules: ReplacementRule[];
}

const REDACTED = "[REDACTED]";

const regexRule = (pattern: RegExp): ReplacementRule => ({
  kind: "regex",
  find: pattern.source,
  replace: REDACTED,
});

/**
 * Canonical one-click redaction patterns surfaced above the find/replace rows.
 * Patterns are bounded (no nested unbounded quantifiers over overlapping
 * classes) so they stay ReDoS-safe. These are best-effort heuristics over free
 * text and may over- or under-match; they only run when the user opts in. There
 * is deliberately no token/credential toggle — `secretScrubber` already scrubs
 * vendor secret sigils on every string before the review dialog renders.
 */
export const PREBUILT_REDACTIONS: PrebuiltRedaction[] = [
  {
    id: "email",
    label: "Strip email addresses",
    rules: [regexRule(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)],
  },
  {
    id: "ip",
    label: "Strip IP addresses (v4/v6)",
    rules: [
      // `(?<![\w.])`/`(?![\w.])` keep the quad from matching inside a longer
      // dotted run (e.g. `1.2.3.4.5`); a standalone 4-part version is still
      // IP-shaped and gets redacted — an accepted opt-in limitation.
      regexRule(
        /(?<![\w.])(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?![\w.])/
      ),
      // Full-form IPv6 requires 4+ groups so `HH:MM:SS` timestamps don't match.
      // The leading `(?<!\w)` stops a match from starting mid-identifier.
      regexRule(/(?<!\w)(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}/),
      // Compressed `::` form (e.g. `fe80::1`, `::1`). The `(?<!\w)` guard stops
      // the trailing hex char of an identifier from anchoring the match, so
      // source symbols like `std::vector` are left intact.
      regexRule(/(?<!\w)(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:?){0,7}/),
    ],
  },
  {
    id: "filepath",
    label: "Strip absolute file paths",
    rules: [
      // POSIX absolute path with 2+ segments (a lone `/` is left alone). Folder
      // segments — anything followed by another `/` — may contain spaces
      // ("/Users/Alice Smith/Private Client/"), so no fragment of a spaced name
      // survives; the final segment stops at whitespace so trailing prose does.
      regexRule(/\/(?:[^/"\\\n]+\/)+[^\s/"\\]*/),
      // Windows drive-letter path, raw (`C:\Users\x`) or JSON-escaped
      // (`C:\\Users\\x`). Each separator is one backslash optionally doubled,
      // consumed whole so the replacement never leaves a dangling escape; folder
      // segments may contain spaces like POSIX ones.
      regexRule(/[A-Za-z]:(?:\\\\?|\/)(?:[^\\/"\n]+(?:\\\\?|\/))*[^\\/\s"]*/),
    ],
  },
];

/** Human-readable labels for diagnostic sections; unlisted keys render as-is. */
export const SECTION_LABELS: Record<string, string> = {
  metadata: "Report metadata",
  runtime: "App runtime",
  os: "Operating system",
  display: "Displays",
  gpu: "GPU",
  process: "Processes",
  tools: "Installed tools",
  git: "Git",
  config: "Configuration",
  terminals: "Terminals",
  flowControl: "Terminal flow control",
  lifecycleLedger: "Terminal lifecycle events",
  mcpAudit: "MCP audit summary",
  projectViews: "Project views",
  rendererMemory: "Window memory",
  memoryTrends: "Memory trends",
  memoryAttribution: "Memory by project",
  resourceState: "Resource limits",
  workerGovernance: "Background workers",
  whySlow: "Slowness snapshot",
  counts: "Open projects and views",
  logs: "Logs",
  events: "Events",
};
