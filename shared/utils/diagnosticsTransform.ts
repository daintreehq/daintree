/**
 * Pure transform utilities for diagnostic bundles. Used by both renderer
 * (preview) and main process (final save) so the preview always matches the
 * saved output.
 */

export interface ReplacementRule {
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
  for (const { find, replace } of rules) {
    if (!find) continue;
    try {
      out = out.split(find).join(replace);
    } catch {
      // Skip invalid replacements
    }
  }
  return out;
}

/** Section metadata for the review dialog. */
export interface DiagnosticSectionMeta {
  key: string;
  label: string;
}

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
