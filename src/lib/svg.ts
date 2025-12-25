const MAX_SVG_SIZE_BYTES = 250 * 1024; // 250KB

const DANGEROUS_PATTERNS = [
  /<script\b/i,
  /<foreignObject\b/i,
  /\bon\w+\s*=/i, // event handlers like onclick=, onload=
  /javascript:/i,
  /data:/i, // data URLs can embed scripts
];

const EXTERNAL_REFERENCE_PATTERNS = [
  /href\s*=\s*["']https?:/i,
  /xlink:href\s*=\s*["']https?:/i,
  /url\s*\(\s*["']?https?:/i,
];

export interface SvgValidationResult {
  ok: true;
  svg: string;
}

export interface SvgValidationError {
  ok: false;
  error: string;
}

export type SvgValidationOutcome = SvgValidationResult | SvgValidationError;

export function validateProjectSvg(svgText: string): SvgValidationOutcome {
  if (!svgText || typeof svgText !== "string") {
    return { ok: false, error: "SVG content is required" };
  }

  const trimmed = svgText.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "SVG content is empty" };
  }

  const sizeBytes = new Blob([trimmed]).size;
  if (sizeBytes > MAX_SVG_SIZE_BYTES) {
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    return {
      ok: false,
      error: `SVG is too large (${sizeMB}MB). Maximum size is 250KB.`,
    };
  }

  if (!trimmed.includes("<svg")) {
    return { ok: false, error: "Content does not appear to be a valid SVG" };
  }

  const svgMatch = trimmed.match(/<svg[^>]*>/i);
  if (!svgMatch) {
    return { ok: false, error: "Could not find SVG root element" };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        error: "SVG contains potentially unsafe content (scripts or event handlers)",
      };
    }
  }

  for (const pattern of EXTERNAL_REFERENCE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        error: "SVG contains external references which are not allowed",
      };
    }
  }

  return { ok: true, svg: trimmed };
}

export function svgToDataUrl(svgText: string): string {
  const encoded = encodeURIComponent(svgText).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml,${encoded}`;
}
