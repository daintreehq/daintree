/**
 * SVG Sanitizer - Strips dangerous content from SVG for safe rendering.
 *
 * Works in both main (Node.js) and renderer (browser) processes.
 * Uses regex-based sanitization to remove:
 * - Script tags
 * - Event handlers (onclick, onload, onerror, etc.)
 * - foreignObject, iframe, embed, object elements
 * - javascript: URLs
 * - External resource references (http/https URLs in href, xlink:href, url())
 * - data: URLs (can embed scripts)
 */

const MAX_SVG_SIZE_BYTES = 250 * 1024; // 250KB

/** Elements that must be completely removed (case-insensitive) */
const DANGEROUS_ELEMENTS = ["script", "foreignObject", "iframe", "embed", "object", "meta", "link"];

/** Event handler attributes to remove (matched with on* pattern) */
const EVENT_HANDLER_PATTERN = /\s+on\w+\s*=\s*["'][^"']*["']/gi;

/** Alternative event handler pattern with backticks or no quotes */
const EVENT_HANDLER_PATTERN_ALT = /\s+on\w+\s*=\s*[^\s>]+/gi;

/** javascript: URLs in any attribute */
const JAVASCRIPT_URL_PATTERN = /\bjavascript\s*:/gi;

/** data: URLs (can embed scripts via data:text/html) */
const DATA_URL_PATTERN = /\bdata\s*:/gi;

/** Pattern to match href/xlink:href attributes with quoted or unquoted values */
const HREF_ATTRIBUTE_PATTERN = /(^|\s)(xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Pattern to match url() functions in CSS */
const URL_FUNC_PATTERN = /\burl\s*\(\s*([^)]+)\)/gi;

/** Pattern to match CSS @import statements */
const CSS_IMPORT_PATTERN = /@import\s+(?:url\()?["']?[^"')]+["']?\)?\s*;?/gi;

/** Pattern to match HTML entities that could encode dangerous characters */
const HTML_ENTITY_PATTERN = /&(#x[0-9a-f]+|#[0-9]+|colon|tab|newline);?/gi;

export interface SvgSanitizeResult {
  /** Whether sanitization succeeded */
  ok: true;
  /** The sanitized SVG content */
  svg: string;
  /** Whether any dangerous content was removed */
  modified: boolean;
}

export interface SvgSanitizeError {
  ok: false;
  error: string;
}

export type SvgSanitizeOutcome = SvgSanitizeResult | SvgSanitizeError;

/**
 * Reset regex lastIndex to avoid false negatives with global regexes
 */
const testPattern = (pattern: RegExp, value: string): boolean => {
  pattern.lastIndex = 0;
  return pattern.test(value);
};

/**
 * Decode HTML entities that could be used to bypass filtering
 */
const decodeHtmlEntities = (value: string): string => {
  return value.replace(HTML_ENTITY_PATTERN, (match, body) => {
    const lower = String(body).toLowerCase();
    if (lower === "colon") return ":";
    if (lower === "tab") return "\t";
    if (lower === "newline") return "\n";
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return match;
  });
};

/**
 * Normalize URL value by removing quotes and decoding entities
 */
const normalizeUrlValue = (value: string): string => {
  const unquoted = value.trim().replace(/^["']|["']$/g, "");
  return decodeHtmlEntities(unquoted).trim();
};

/**
 * Check if a URL value is a safe local reference (empty or starts with #)
 */
const isLocalReference = (value: string): boolean => {
  const normalized = normalizeUrlValue(value);
  return normalized === "" || normalized.startsWith("#");
};

/**
 * Strip unsafe href/xlink:href attributes, allowing only local references
 */
const stripUnsafeHrefAttributes = (svg: string): string => {
  return svg.replace(HREF_ATTRIBUTE_PATTERN, (match, prefix, xlink, dquoted, squoted, unquoted) => {
    const rawValue = dquoted ?? squoted ?? unquoted ?? "";
    if (isLocalReference(rawValue)) {
      return match;
    }
    const attrName = xlink ? "xlink:href" : "href";
    return `${prefix}${attrName}=""`;
  });
};

/**
 * Strip unsafe url() functions in CSS, allowing only local references
 */
const stripUnsafeUrlFunctions = (svg: string): string => {
  return svg.replace(URL_FUNC_PATTERN, (match, rawValue) => {
    if (isLocalReference(rawValue)) {
      return match;
    }
    return 'url("")';
  });
};

/**
 * Check if SVG contains unsafe href/xlink:href attributes
 */
const hasUnsafeHrefAttributes = (svg: string): boolean => {
  let unsafe = false;
  svg.replace(HREF_ATTRIBUTE_PATTERN, (_match, _prefix, _xlink, dquoted, squoted, unquoted) => {
    const rawValue = dquoted ?? squoted ?? unquoted ?? "";
    if (!isLocalReference(rawValue)) {
      unsafe = true;
    }
    return _match;
  });
  return unsafe;
};

/**
 * Check if SVG contains unsafe url() functions
 */
const hasUnsafeUrlFunctions = (svg: string): boolean => {
  let unsafe = false;
  svg.replace(URL_FUNC_PATTERN, (_match, rawValue) => {
    if (!isLocalReference(rawValue)) {
      unsafe = true;
    }
    return _match;
  });
  return unsafe;
};

/**
 * Sanitize SVG content by removing dangerous elements and attributes.
 * Returns the cleaned SVG or an error if the input is invalid.
 *
 * @param svgText - Raw SVG content to sanitize
 * @returns Sanitized SVG or error
 */
export function sanitizeSvg(svgText: string): SvgSanitizeOutcome {
  if (!svgText || typeof svgText !== "string") {
    return { ok: false, error: "SVG content is required" };
  }

  let svg = svgText.trim();
  if (svg.length === 0) {
    return { ok: false, error: "SVG content is empty" };
  }

  // Check size limit
  const sizeBytes = new Blob([svg]).size;
  if (sizeBytes > MAX_SVG_SIZE_BYTES) {
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    return {
      ok: false,
      error: `SVG is too large (${sizeMB}MB). Maximum size is 250KB.`,
    };
  }

  // Verify it's actually SVG (case-insensitive)
  if (!/<svg\b/i.test(svg)) {
    return { ok: false, error: "Content does not appear to be a valid SVG" };
  }

  const svgMatch = svg.match(/<svg[^>]*>/i);
  if (!svgMatch) {
    return { ok: false, error: "Could not find SVG root element" };
  }

  const originalSvg = svg;

  // Remove dangerous elements completely (including their content)
  for (const element of DANGEROUS_ELEMENTS) {
    // Match opening tag through closing tag (handles nested content)
    const openClosePattern = new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}>`, "gi");
    svg = svg.replace(openClosePattern, "");

    // Also handle self-closing variants
    const selfClosingPattern = new RegExp(`<${element}\\b[^>]*\\/?>`, "gi");
    svg = svg.replace(selfClosingPattern, "");
  }

  // Remove event handlers (onclick, onload, onerror, etc.)
  svg = svg.replace(EVENT_HANDLER_PATTERN, "");
  svg = svg.replace(EVENT_HANDLER_PATTERN_ALT, "");

  // Remove CSS @import statements
  svg = svg.replace(CSS_IMPORT_PATTERN, "");

  // Strip unsafe href/xlink:href and url() with entity decoding
  svg = stripUnsafeHrefAttributes(svg);
  svg = stripUnsafeUrlFunctions(svg);

  // Remove javascript: URLs
  svg = svg.replace(JAVASCRIPT_URL_PATTERN, "removed:");

  // Remove data: URLs (can contain malicious content)
  svg = svg.replace(DATA_URL_PATTERN, "removed:");

  // Verify the result still contains an SVG element (case-insensitive)
  if (!/<svg\b/i.test(svg)) {
    return { ok: false, error: "SVG was completely stripped during sanitization" };
  }

  const modified = svg !== originalSvg;

  return { ok: true, svg, modified };
}

/**
 * Validate SVG content without modifying it.
 * Returns true if the SVG passes all security checks.
 *
 * @param svgText - SVG content to validate
 * @returns Validation result with ok flag and optional error
 */
export function validateSvg(svgText: string): SvgSanitizeOutcome {
  const result = sanitizeSvg(svgText);
  if (!result.ok) {
    return result;
  }

  // If sanitization modified the content, it means the original had dangerous content
  if (result.modified) {
    return {
      ok: false,
      error: "SVG contains potentially unsafe content that would be removed during sanitization",
    };
  }

  return result;
}

/**
 * Check if SVG content is safe without sanitizing.
 * Faster than sanitizeSvg for pre-flight checks.
 *
 * @param svgText - SVG content to check
 * @returns true if SVG appears safe
 */
export function isSvgSafe(svgText: string): boolean {
  if (!svgText || typeof svgText !== "string") {
    return false;
  }

  const svg = svgText.trim();
  if (svg.length === 0 || !/<svg\b/i.test(svg)) {
    return false;
  }

  // Check size
  const sizeBytes = new Blob([svg]).size;
  if (sizeBytes > MAX_SVG_SIZE_BYTES) {
    return false;
  }

  // Check for dangerous elements
  for (const element of DANGEROUS_ELEMENTS) {
    const pattern = new RegExp(`<${element}\\b`, "i");
    if (testPattern(pattern, svg)) {
      return false;
    }
  }

  // Check for event handlers (both quoted and unquoted)
  if (testPattern(EVENT_HANDLER_PATTERN, svg) || testPattern(EVENT_HANDLER_PATTERN_ALT, svg)) {
    return false;
  }

  // Check for javascript: URLs
  if (testPattern(JAVASCRIPT_URL_PATTERN, svg)) {
    return false;
  }

  // Check for data: URLs
  if (testPattern(DATA_URL_PATTERN, svg)) {
    return false;
  }

  // Check for CSS @import
  if (testPattern(CSS_IMPORT_PATTERN, svg)) {
    return false;
  }

  // Check for unsafe href/xlink:href and url() references
  if (hasUnsafeHrefAttributes(svg)) {
    return false;
  }

  if (hasUnsafeUrlFunctions(svg)) {
    return false;
  }

  return true;
}
