import type { DOMPurify } from "dompurify";

/**
 * The last word on a Mermaid diagram before it reaches the DOM. Mermaid's own
 * strict mode already runs DOMPurify, but the diagram source is untrusted repo
 * content and the renderer's CSP allows inline script, so the SVG is held to
 * a policy owned here rather than to whatever a Mermaid release ships.
 *
 * Beyond script, the SVG must not be a way to leave the document: a link would
 * navigate the renderer itself, and any external `url()`, `href` or `<image>`
 * is a fetch the author chose. Only same-document references (`#marker-id`)
 * survive — Mermaid needs those for arrowheads, gradients and filters.
 *
 * DOMPurify does not look inside CSS, so the diagram's `<style>` block is
 * re-parsed by the browser's own CSS parser into a detached sheet: a rule survives only when every
 * selector is scoped under this diagram's root id — the shape Mermaid emits —
 * so an author-supplied `}` can't smuggle in a rule that restyles the app.
 * Checks run on the parser's serialization, which has already decoded any
 * escapes (`u\72l(` and friends).
 */

const FORBID_TAGS = [
  "a",
  "foreignobject",
  "image",
  "feimage",
  "script",
  "iframe",
  "object",
  "embed",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
];

/** Larger than any real diagram; past it the markup is not worth a DOM parse. */
const MAX_SVG_CHARS = 5_000_000;

const EXTERNAL_URL = /url\(\s*(?!['"]?\s*#)/i;
const RESOURCE_FUNCTION = /image-set\(|image\(|cross-fade\(|element\(/i;

/**
 * True when a CSS value could fetch something or hides its meaning behind
 * escapes. Mermaid's own output has neither, so being strict costs nothing.
 */
function isUnsafeCss(text: string): boolean {
  return text.includes("\\") || EXTERNAL_URL.test(text) || RESOURCE_FUNCTION.test(text);
}

function isScopedSelector(selector: string, scope: string): boolean {
  if (!selector.startsWith(scope)) return false;
  const next = selector.charAt(scope.length);
  return next === "" || /[\s.:[>+~]/.test(next);
}

function parseStyleSheet(css: string): CSSStyleSheet | null {
  // A constructed sheet is parsed but never applied to any document, and
  // `replaceSync` does not fetch `@import`s.
  if (typeof CSSStyleSheet === "undefined") return null;
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return null;
  }
  return sheet;
}

function scopeStyleSheet(css: string, rootId: string): string {
  const sheet = parseStyleSheet(css);
  if (!sheet) return "";
  const scope = `#${rootId}`;
  const kept: string[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    const text = rule.cssText;
    if (isUnsafeCss(text)) continue;
    // Keyframes carry no selector, only a global animation name.
    if ("name" in rule && "findRule" in rule) {
      kept.push(text);
      continue;
    }
    if (!("selectorText" in rule) || typeof rule.selectorText !== "string") continue;
    const selectors = rule.selectorText.split(",").map((selector) => selector.trim());
    if (selectors.every((selector) => isScopedSelector(selector, scope))) kept.push(text);
  }
  return kept.join("\n");
}

function scrubAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const { name, value } = attribute;
    if (name === "href" || name === "xlink:href") {
      if (!value.trim().startsWith("#")) element.removeAttribute(name);
      continue;
    }
    if (isUnsafeCss(value) && (value.includes("(") || name === "style")) {
      element.removeAttribute(name);
    }
  }
}

/** Returns the sanitized SVG markup, or null when nothing diagram-shaped is left. */
export function sanitizeMermaidSvg(purify: DOMPurify, svg: string): string | null {
  if (svg.length > MAX_SVG_CHARS) return null;
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS,
    RETURN_DOM_FRAGMENT: true,
  });
  const root = fragment.firstElementChild;
  if (!root || root.localName !== "svg" || fragment.childElementCount !== 1) return null;
  const rootId = root.getAttribute("id") ?? "";
  if (!/^[A-Za-z][\w-]*$/.test(rootId)) return null;

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    scrubAttributes(element);
    if (element.localName === "style") {
      element.textContent = scopeStyleSheet(element.textContent ?? "", rootId);
    }
  }
  const holder = document.createElement("div");
  holder.appendChild(fragment);
  return holder.innerHTML;
}
