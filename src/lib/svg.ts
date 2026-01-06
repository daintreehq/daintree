// Re-export the sanitization utilities from shared module
export {
  sanitizeSvg,
  validateSvg,
  isSvgSafe,
  type SvgSanitizeResult,
  type SvgSanitizeError,
  type SvgSanitizeOutcome,
} from "@shared/utils/svgSanitizer";

// Legacy type aliases for backward compatibility
export type SvgValidationResult = { ok: true; svg: string };
export type SvgValidationError = { ok: false; error: string };
export type SvgValidationOutcome = SvgValidationResult | SvgValidationError;

/**
 * Validate project SVG - returns sanitized SVG if valid.
 * This is used by the file upload UI to provide immediate feedback.
 * @deprecated Use sanitizeSvg from @shared/utils/svgSanitizer instead
 */
export { sanitizeSvg as validateProjectSvg } from "@shared/utils/svgSanitizer";

export function svgToDataUrl(svgText: string): string {
  const encoded = encodeURIComponent(svgText).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml,${encoded}`;
}
