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
  let out = json;
  for (const rule of rules) {
    if (!rule.find) continue;
    try {
      if (rule.kind === "regex") {
        out = out.replace(new RegExp(rule.find, "g"), rule.replace);
      } else {
        out = out.split(rule.find).join(rule.replace);
      }
    } catch {
      // Skip invalid replacements (e.g. an uncompilable regex pattern), the
      // same way an empty `find` is skipped above.
    }
  }
  return out;
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
      regexRule(
        /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/
      ),
      // Full-form IPv6 requires 4+ groups so `HH:MM:SS` timestamps don't match.
      regexRule(/(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}/),
      // Compressed `::` form (e.g. `fe80::1`, `::1`).
      regexRule(/(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:?){0,7}/),
    ],
  },
  {
    id: "filepath",
    label: "Strip absolute file paths",
    rules: [
      // POSIX absolute path with 2+ segments (avoids mangling every lone `/`).
      regexRule(/\/(?:[^\s/"\\]+\/)+[^\s/"\\]+/),
      // Windows drive-letter path.
      regexRule(/[A-Za-z]:\\(?:[^\\/\s"]+\\)*[^\\/\s"]*/),
    ],
  },
];

/** Human-readable labels for the twelve diagnostic sections. */
export const SECTION_LABELS: Record<string, string> = {
  metadata: "Metadata",
  runtime: "Runtime",
  os: "Operating System",
  display: "Display",
  gpu: "GPU",
  process: "Process",
  tools: "Tools",
  git: "Git",
  config: "Configuration",
  terminals: "Terminals",
  logs: "Logs",
  events: "Events",
};
