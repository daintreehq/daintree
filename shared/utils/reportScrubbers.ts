/**
 * Renderer-safe redaction for crash-report surfaces. The main-process
 * `pathScrubber.ts` depends on `os.homedir()`, which is unavailable in the
 * sandboxed renderer, so this module reimplements path scrubbing with the
 * static, username-agnostic patterns only. Secret scrubbing reuses the shared
 * `scrubSecrets` (no Node imports), so there is a single source of truth for
 * secret sigils.
 *
 * Apply at the viewer / report-builder boundary — never at the capture layer.
 * The main-process action-breadcrumb ring stays raw; redaction happens only
 * when content is rendered or built into a shareable report.
 */
import { scrubSecrets } from "./secretScrubber.js";

export { scrubSecrets };

/**
 * Replace user-account segments in common macOS / Linux / Windows paths with a
 * `USER` placeholder. Username-agnostic — uses only static patterns, so it is
 * safe in the renderer where `os.homedir()` is unavailable. Handles both
 * forward-slash and backslash Windows paths (lesson #4979).
 */
export function scrubReportPath(str: string): string {
  return str
    .replace(/\/Users\/[^/]+\//g, "/Users/USER/")
    .replace(/\/home\/[^/]+\//g, "/home/USER/")
    .replace(/C:\\Users\\[^\\]+\\/gi, "C:\\Users\\USER\\")
    .replace(/C:\/Users\/[^/]+\//gi, "C:/Users/USER/");
}

/**
 * Full redaction pass for report text: scrub user paths first, then known
 * secret sigils. Idempotent — both passes are.
 */
export function scrubReportText(str: string): string {
  return scrubSecrets(scrubReportPath(str));
}
