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
