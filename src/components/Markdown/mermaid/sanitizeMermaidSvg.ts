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

const EXTERNAL_URL = /url\((?!\s*['"]?\s*#)/i;
const RESOURCE_FUNCTION = /image-set\(|image\(|cross-fade\(|element\(/i;

/**
 * True when a CSS value could fetch something or hides its meaning behind
 * escapes. Mermaid's own output has neither, so being strict costs nothing.
 */
function isUnsafeCss(text: string): boolean {
  return text.includes("\\") || EXTERNAL_URL.test(text) || RESOURCE_FUNCTION.test(text);
}

/**
 * Mermaid's own animation names. An author-supplied `@keyframes spin` would
 * replace the app's animation of the same name everywhere, so no other name
 * gets through.
 */
const KEYFRAME_NAMES = new Set(["dash", "edge-animation-frame"]);

/**
 * True when the selector can only match the diagram root or something inside
 * it: it opens with the root's id (or one of the ids namespaced under it), and
 * that first compound is not followed by a sibling combinator, which would
 * reach the elements next to the diagram.
 */
function isScopedSelector(selector: string, scope: string): boolean {
  if (!selector.startsWith(scope)) return false;
  const rest = selector.slice(scope.length);
  if (rest !== "" && !/^[\s.:[>\-_]/.test(rest)) return false;
  let depth = 0;
  let quote = "";
  let index = 0;
  for (; index < rest.length; index++) {
    const char = rest.charAt(index);
    // Brackets inside a quoted attribute value are text, not nesting.
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(char)) break;
  }
  if (quote || depth !== 0) return false;
  const combinator = rest.slice(index).trimStart().charAt(0);
  return combinator !== "+" && combinator !== "~";
}

function hasNestedRules(rule: CSSRule): boolean {
  const nested: unknown = Reflect.get(rule, "cssRules");
  return (
    typeof nested === "object" &&
    nested !== null &&
    "length" in nested &&
    typeof nested.length === "number" &&
    nested.length > 0
  );
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
      if (typeof rule.name === "string" && KEYFRAME_NAMES.has(rule.name)) kept.push(text);
      continue;
    }
    if (!("selectorText" in rule) || typeof rule.selectorText !== "string") continue;
    // A nested rule (`#id { :is(&, body) {} }`) picks its own targets; Mermaid
    // never emits one.
    if (hasNestedRules(rule)) continue;
    const selectors = rule.selectorText.split(",").map((selector) => selector.trim());
    if (selectors.every((selector) => isScopedSelector(selector, scope))) kept.push(text);
  }
  return kept.join("\n");
}

const ID_REFERENCE_ATTRS = ["aria-labelledby", "aria-describedby"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Moves every id in the diagram under its root id. Most of Mermaid's ids
 * already are, but some renderers mint bare ones (`linearGradient-3`), which
 * collide with the same diagram mounted twice or with another diagram's. Once
 * everything shares the root's prefix, renaming the root renames them all.
 */
function namespaceIds(root: Element, rootId: string): void {
  const renamed = new Map<string, string>();
  const taken = new Set<string>();
  for (const element of root.querySelectorAll("[id]")) {
    const id = element.getAttribute("id") ?? "";
    if (id.startsWith(rootId)) {
      taken.add(id);
      continue;
    }
    let next = `${rootId}-${id.replace(/[^\w-]/g, "_")}`;
    while (taken.has(next)) next = `${next}_`;
    taken.add(next);
    renamed.set(id, next);
    element.setAttribute("id", next);
  }
  if (renamed.size === 0) return;

  const renameReferences = (value: string): string =>
    value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (match, quote: string, id: string) => {
      const next = renamed.get(id);
      return next === undefined ? match : `url(${quote}#${next}${quote})`;
    });

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const { name, value } = attribute;
      if (name === "id") continue;
      if (name === "href" || name === "xlink:href") {
        const next = renamed.get(value.trim().slice(1));
        if (value.trim().startsWith("#") && next !== undefined) {
          element.setAttribute(name, `#${next}`);
        }
      } else if (ID_REFERENCE_ATTRS.includes(name)) {
        element.setAttribute(
          name,
          value
            .split(/\s+/)
            .map((token) => renamed.get(token) ?? token)
            .join(" ")
        );
      } else if (value.includes("url(")) {
        element.setAttribute(name, renameReferences(value));
      }
    }
    if (element.localName === "style" && element.textContent) {
      let css = renameReferences(element.textContent);
      for (const [id, next] of renamed) {
        css = css.replace(new RegExp(`#${escapeRegExp(id)}(?![\\w-])`, "g"), `#${next}`);
      }
      element.textContent = css;
    }
  }
}

/**
 * Mermaid still routes some labels (math, a few class-diagram members)
 * through `foreignObject` whatever `htmlLabels` says. Stripping those leaves a
 * diagram with holes in it, which reads worse than the source.
 */
function hasHtmlOnlyLabels(svg: string): boolean {
  for (const match of svg.matchAll(/<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/gi)) {
    if ((match[1] ?? "").replace(/<[^>]*>/g, "").trim()) return true;
  }
  return false;
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
  if (svg.length > MAX_SVG_CHARS || hasHtmlOnlyLabels(svg)) return null;
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
  }
  namespaceIds(root, rootId);
  for (const element of root.querySelectorAll("style")) {
    element.textContent = scopeStyleSheet(element.textContent ?? "", rootId);
  }
  const holder = document.createElement("div");
  holder.appendChild(fragment);
  return holder.innerHTML;
}
