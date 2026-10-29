import { sanitizeSvg, type SvgSanitizeOutcome } from "@shared/utils/svgSanitizer";

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

export function svgToDataUrl(svgText: string): string {
  const encoded = encodeURIComponent(svgText).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml,${encoded}`;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Why a preview refuses sanitized markup that doesn't parse as an SVG document. */
export const SVG_PARSE_ERROR = "Its markup couldn't be parsed. It may be incomplete or malformed.";

/** Why a preview refuses markup that parsed but that the image decoder still couldn't draw. */
export const SVG_DRAW_ERROR = "Its markup parsed, but it couldn't be drawn as an image.";

export interface RenderableSvg {
  markup: string;
  /** Whether the root sets its own width, and so has an intrinsic size as an image. */
  sized: boolean;
}

/**
 * The markup to render as an `image/svg+xml` image and whether it sets its own
 * width, or null if it isn't usable.
 *
 * `image/svg+xml` is namespace-strict: a root `<svg>` that omits `xmlns` (common
 * in hand-written and tool-exported files) renders blank. `sanitizeSvg` only
 * requires the string to contain `<svg`, so declare the namespace when it's
 * absent rather than silently showing nothing.
 */
export function renderableSvg(sanitizedSvg: string): RenderableSvg | null {
  const parse = (markup: string): RenderableSvg | null => {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    // A parse failure yields a <parsererror> document rather than throwing.
    if (parsed.querySelector("parsererror")) return null;
    const root = parsed.documentElement;
    if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) return null;
    return { markup, sized: root.hasAttribute("width") };
  };

  const direct = parse(sanitizedSvg);
  if (direct) return direct;

  // Retry once with the namespace declared on the root element. Only rewrites
  // the opening tag, so sanitized content is otherwise untouched.
  if (!/\sxmlns\s*=/.test(sanitizedSvg)) {
    return parse(sanitizedSvg.replace(/<svg\b/i, `<svg xmlns="${SVG_NAMESPACE}"`));
  }
  return null;
}

/**
 * `sanitizeSvg` for a preview, plus the check the sanitizer can't make without
 * a DOM: that what it leaves parses as an SVG document. The sanitizer only
 * looks for `<svg`, so markup truncated mid-write passes it and would otherwise
 * preview as an empty stage, indistinguishable from an intentionally empty file.
 */
export function sanitizeSvgForPreview(svgText: string): SvgSanitizeOutcome {
  const outcome = sanitizeSvg(svgText);
  if (!outcome.ok || renderableSvg(outcome.svg) !== null) return outcome;
  return { ok: false, error: SVG_PARSE_ERROR };
}
