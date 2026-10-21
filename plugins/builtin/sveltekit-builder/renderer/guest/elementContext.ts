/// <reference lib="dom" />
import type { ElementContext } from "../../shared/protocol.js";

/**
 * Mirrors `ELEMENT_CONTEXT_LIMITS` in the protocol, which this file can't
 * import: that module pulls in zod, and the guest asset ships without it. The
 * guest runtime suite checks the two agree.
 */
export const GUEST_CONTEXT_LIMITS = {
  selector: 512,
  markup: 2048,
  styles: 40,
  property: 64,
  value: 256,
} as const;

const MAX_SELECTOR_DEPTH = 8;
const MAX_MARKUP_DEPTH = 2;
const MAX_CHILDREN = 12;
const MAX_ATTRIBUTE = 160;
const MAX_ATTRIBUTES = 24;
const MAX_TEXT = 80;
/** Child nodes looked at per element, written or not: comments and whitespace cost a visit too. */
const MAX_VISITS = 64;

/**
 * Typography and colour are inherited, so a value the parent already has says
 * nothing about this element and is left out.
 */
const INHERITED = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "visibility",
  "cursor",
] as const;

/**
 * Everything else is compared with the value an unstyled element computes to,
 * never with the parent: a child's margin is not the parent's margin, however
 * often the two happen to match. `null` is always kept — a box's measured size
 * and its display type are what the rest is read against.
 */
const OWN: ReadonlyArray<readonly [string, string | null]> = [
  ["display", null],
  ["position", "static"],
  ["width", null],
  ["height", null],
  ["box-sizing", "content-box"],
  ["margin", "0px"],
  ["padding", "0px"],
  ["border-width", "0px"],
  ["border-style", "none"],
  ["border-color", ""],
  ["border-radius", "0px"],
  ["background-color", "rgba(0, 0, 0, 0)"],
  ["background-image", "none"],
  ["box-shadow", "none"],
  ["opacity", "1"],
  ["transform", "none"],
  ["overflow", "visible"],
  ["z-index", "auto"],
  ["gap", "normal"],
  ["flex-direction", "row"],
  ["flex-wrap", "nowrap"],
  ["justify-content", "normal"],
  ["align-items", "normal"],
  ["grid-template-columns", "none"],
  ["max-width", "none"],
];

/** Properties that only mean something under a given display or position. */
const ONLY_WHEN: Readonly<Record<string, (style: CSSStyleDeclaration) => boolean>> = {
  "border-color": (style) => style.getPropertyValue("border-style") !== "none",
  "flex-direction": (style) => style.getPropertyValue("display").includes("flex"),
  "flex-wrap": (style) => style.getPropertyValue("display").includes("flex"),
  "grid-template-columns": (style) => style.getPropertyValue("display").includes("grid"),
};

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** HTML reports upper-case tag names and SVG keeps its own case; compared one way. */
function nameOf(node: Element): string {
  return node.tagName.toUpperCase();
}

function escapeIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // CSSOM's identifier serialization, for the characters a page actually uses.
  return value
    .replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char)
    .replace(/^(-?)(\d)/, (_match, dash: string, digit: string) => `${dash}\\3${digit} `);
}

/**
 * Class names a build tool generated mean nothing to the agent reading the
 * selector and change on the next build: CSS-module and styled-component
 * hashes, and Tailwind's arbitrary values, which need escaping to be read at all.
 */
function usableClass(name: string): boolean {
  if (name.length === 0 || name.length > 40) return false;
  if (/[[\]:/()%.!@#]/.test(name)) return false;
  // A trailing hash segment with a digit in it: css-1x2y3z, Button_root__a1B2c, jsx-123456.
  const tail = /[-_]([a-zA-Z0-9]{5,})$/.exec(name)?.[1];
  return !(tail !== undefined && /\d/.test(tail));
}

type QueryRoot = Document | ShadowRoot;

/** Whether `selector` finds this node and nothing else, in the tree the node is actually in. */
function names(root: QueryRoot, selector: string, node: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === node;
  } catch {
    return false;
  }
}

function step(node: Element): string {
  const tag = node.tagName.toLowerCase();
  const classes = (node.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(usableClass)
    .slice(0, 2)
    .map((name) => "." + escapeIdent(name))
    .join("");
  let part = tag + classes;
  const parent = node.parentElement;
  if (parent !== null) {
    const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
  }
  return part;
}

/**
 * A selector that finds this element in the page as it is now: anchored at the
 * nearest unique id, otherwise a short child chain that stops as soon as it
 * names one element. A description to find it by, not an identity — the next
 * render can make it match something else.
 */
export function selectorFor(node: Element): string {
  const rootNode = node.getRootNode();
  // Inside a shadow root the selector is relative to that root: a document
  // query can't see the node at all, and would vouch for a light-DOM lookalike.
  const root: QueryRoot =
    typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot
      ? rootNode
      : node.ownerDocument;
  const parts: string[] = [];
  let current: Element | null = node;
  for (let depth = 0; current !== null && depth < MAX_SELECTOR_DEPTH; depth += 1) {
    const id = current.getAttribute("id");
    if (id !== null && id.length > 0 && id.length <= 80) {
      const anchor = "#" + escapeIdent(id);
      if (names(root, anchor, current)) {
        parts.unshift(anchor);
        break;
      }
    }
    parts.unshift(step(current));
    if (nameOf(current) === "BODY" || nameOf(current) === "HTML") break;
    if (names(root, parts.join(" > "), node)) break;
    current = current.parentElement;
  }
  // Whole steps come off the front until it fits, never a cut through one:
  // half a step is a selector that finds nothing, or something else.
  while (parts.length > 1 && parts.join(" > ").length > GUEST_CONTEXT_LIMITS.selector) {
    parts.shift();
  }
  return clamp(parts.join(" > "), GUEST_CONTEXT_LIMITS.selector);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * Attributes whose values describe the design: what the element is, what it
 * says, how it is laid out. Any other value — a `data-token`, a CSRF meta's
 * `content`, a nonce — may be the application's state or a credential, and
 * is shown as present without being copied.
 */
const DESCRIPTIVE = new Set([
  "id",
  "class",
  "role",
  "type",
  "name",
  "for",
  "href",
  "src",
  "srcset",
  "alt",
  "title",
  "placeholder",
  "style",
  "width",
  "height",
  "disabled",
  "hidden",
  "tabindex",
  "target",
  "rel",
  "lang",
  "dir",
  "colspan",
  "rowspan",
  "viewbox",
  "fill",
  "stroke",
  "d",
  "data-testid",
  "data-state",
]);

/** What the user put into the page — typed, chosen, ticked — is theirs, never the page's design. */
const USER_STATE = new Set(["value", "checked", "selected"]);

/** Fields and editable regions: their content is whatever the user typed into them. */
function holdsUserInput(node: Element): boolean {
  const name = nameOf(node);
  if (name === "INPUT" || name === "TEXTAREA" || name === "SELECT" || name === "OPTION")
    return true;
  return node.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** A URL's path, without the userinfo, query values or fragment that carry tokens. */
function redactUrlValue(value: string): string {
  if (/^\s*data:/i.test(value) || /\bdata:[^,\s]*,/i.test(value)) return "data:…";
  if (value.trimStart().startsWith("#")) return value;
  return value
    .replace(/\/\/[^/?#@\s]*@/g, "//")
    .replace(/#.*$/s, "")
    .replace(/([?&][^=&#\s]*)=[^&#\s]*/g, "$1=");
}

/** A CSS value with every `url(…)` emptied: an embedded payload or a tokened address. */
function redactCssUrls(value: string): string {
  return value.replace(/url\((?:[^()]|\([^)]*\))*\)/gi, "url(…)");
}

function attributeValue(node: Element, name: string, value: string): string | null {
  const lower = name.toLowerCase();
  // Handlers are code, not design.
  if (lower.startsWith("on")) return null;
  if (USER_STATE.has(lower))
    return holdsUserInput(node) ? "[redacted]" : clamp(value, MAX_ATTRIBUTE);
  if (lower.startsWith("aria-")) return clamp(value, MAX_ATTRIBUTE);
  if (!DESCRIPTIVE.has(lower)) return value === "" ? "" : "…";
  if (lower === "style") return clamp(redactCssUrls(value), MAX_ATTRIBUTE);
  if (lower === "href" || lower === "src" || lower === "srcset") {
    return clamp(redactUrlValue(value), MAX_ATTRIBUTE);
  }
  if (/^\s*data:/i.test(value)) return "data:…";
  return clamp(value, MAX_ATTRIBUTE);
}

function openTag(node: Element): string {
  let tag = "<" + node.tagName.toLowerCase();
  const attributes = node.attributes;
  const shown = Math.min(attributes.length, MAX_ATTRIBUTES);
  for (let index = 0; index < shown; index += 1) {
    const attribute = attributes[index];
    if (attribute === undefined) continue;
    const value = attributeValue(node, attribute.name, attribute.value);
    if (value === null) continue;
    tag += value === "" ? ` ${attribute.name}` : ` ${attribute.name}="${escapeAttribute(value)}"`;
  }
  if (attributes.length > shown) tag += " …";
  return tag + ">";
}

const VOID = new Set([
  "AREA",
  "BASE",
  "BR",
  "COL",
  "EMBED",
  "HR",
  "IMG",
  "INPUT",
  "LINK",
  "META",
  "SOURCE",
  "TRACK",
  "WBR",
]);

/**
 * Children whose text is a payload or the user's own, not content: said to be
 * there, never copied. A select's options are what the user chose among.
 */
const OPAQUE = new Set(["SCRIPT", "STYLE", "TEXTAREA", "TEMPLATE", "NOSCRIPT", "SELECT"]);

/** The excerpt so far, and how long it is: writing stops once it can't fit anything more. */
interface Excerpt {
  parts: string[];
  length: number;
}

function write(out: Excerpt, text: string): void {
  out.parts.push(text);
  out.length += text.length;
}

function writeMarkup(node: Element, depth: number, out: Excerpt): void {
  if (out.length > GUEST_CONTEXT_LIMITS.markup) return;
  write(out, openTag(node));
  const name = nameOf(node);
  if (VOID.has(name)) return;
  const editable = holdsUserInput(node);
  if (OPAQUE.has(name) || editable) {
    if (node.firstChild !== null) write(out, editable ? "[redacted]" : "…");
  } else if (depth >= MAX_MARKUP_DEPTH) {
    if (node.firstChild !== null) write(out, "…");
  } else {
    let written = 0;
    let visits = 0;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      visits += 1;
      if (
        written >= MAX_CHILDREN ||
        visits > MAX_VISITS ||
        out.length > GUEST_CONTEXT_LIMITS.markup
      ) {
        write(out, "…");
        break;
      }
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length === 0) continue;
        write(out, escapeText(clamp(text, MAX_TEXT)));
        written += 1;
      } else if (child.nodeType === 1) {
        writeMarkup(child as Element, depth + 1, out);
        written += 1;
      }
    }
  }
  write(out, `</${node.tagName.toLowerCase()}>`);
}

/** The element's markup two levels deep, with input values, payloads and handlers left out. */
export function markupFor(node: Element): { markup: string; truncated: boolean } {
  const out: Excerpt = { parts: [], length: 0 };
  writeMarkup(node, 0, out);
  const markup = out.parts.join("");
  if (markup.length <= GUEST_CONTEXT_LIMITS.markup) return { markup, truncated: false };
  return { markup: markup.slice(0, GUEST_CONTEXT_LIMITS.markup - 1) + "…", truncated: true };
}

function allZero(value: string): boolean {
  return value.split(/\s+/).every((part) => part === "0px" || part === "0");
}

/** The computed styles that describe this element, without the ones that describe nothing. */
export function stylesFor(node: Element): ElementContext["styles"] {
  const view = node.ownerDocument.defaultView;
  if (view === null || typeof view.getComputedStyle !== "function") return [];
  let style: CSSStyleDeclaration;
  let parentStyle: CSSStyleDeclaration | null = null;
  try {
    style = view.getComputedStyle(node);
    if (node.parentElement !== null) parentStyle = view.getComputedStyle(node.parentElement);
  } catch {
    return [];
  }
  const out: ElementContext["styles"] = [];
  const push = (property: string, value: string) => {
    if (out.length >= GUEST_CONTEXT_LIMITS.styles) return;
    out.push({ property, value: clamp(redactCssUrls(value), GUEST_CONTEXT_LIMITS.value) });
  };
  for (const [property, baseline] of OWN) {
    const value = style.getPropertyValue(property).trim();
    if (value === "") continue;
    const condition = ONLY_WHEN[property];
    if (condition !== undefined && !condition(style)) continue;
    if (baseline !== null) {
      if (value === baseline) continue;
      if (baseline === "0px" && allZero(value)) continue;
    }
    push(property, value);
  }
  for (const property of INHERITED) {
    const value = style.getPropertyValue(property).trim();
    if (value === "") continue;
    if (parentStyle !== null && parentStyle.getPropertyValue(property).trim() === value) continue;
    push(property, value);
  }
  return out;
}

export function elementContextOf(node: Element): ElementContext | null {
  try {
    const { markup, truncated } = markupFor(node);
    return {
      selector: selectorFor(node) || node.tagName.toLowerCase(),
      markup,
      ...(truncated ? { markupTruncated: true as const } : {}),
      styles: stylesFor(node),
    };
  } catch {
    // The page can break any DOM API it likes; the selection still goes out.
    return null;
  }
}
