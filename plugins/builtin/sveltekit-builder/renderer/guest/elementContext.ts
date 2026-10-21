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
const MAX_TEXT = 80;

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

function escapeIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char);
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

function unique(document: Document, selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
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
  const document = node.ownerDocument;
  const parts: string[] = [];
  let current: Element | null = node;
  for (let depth = 0; current !== null && depth < MAX_SELECTOR_DEPTH; depth += 1) {
    const id = current.getAttribute("id");
    if (id !== null && id.length > 0 && id.length <= 80) {
      const anchor = "#" + escapeIdent(id);
      if (unique(document, anchor)) {
        parts.unshift(anchor);
        break;
      }
    }
    parts.unshift(step(current));
    if (current.tagName === "BODY" || current.tagName === "HTML") break;
    if (unique(document, parts.join(" > "))) break;
    current = current.parentElement;
  }
  return clamp(parts.join(" > "), GUEST_CONTEXT_LIMITS.selector);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** What a field holds is the user's, not the page's design: it never leaves the page. */
function holdsUserInput(node: Element): boolean {
  return node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT";
}

function attributeValue(node: Element, name: string, value: string): string | null {
  // Handlers are code, not design.
  if (name.startsWith("on")) return null;
  if (name === "value" && holdsUserInput(node)) return "[redacted]";
  if (/^\s*data:/i.test(value) || /\bdata:[^,\s]*,/i.test(value)) return "data:…";
  return clamp(value, MAX_ATTRIBUTE);
}

function openTag(node: Element): string {
  let tag = "<" + node.tagName.toLowerCase();
  for (const attribute of Array.from(node.attributes)) {
    const value = attributeValue(node, attribute.name, attribute.value);
    if (value === null) continue;
    tag += value === "" ? ` ${attribute.name}` : ` ${attribute.name}="${escapeAttribute(value)}"`;
  }
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

/** Children whose text is a payload, not content: said to be there, never copied. */
const OPAQUE = new Set(["SCRIPT", "STYLE", "TEXTAREA", "TEMPLATE", "NOSCRIPT"]);

function writeMarkup(node: Element, depth: number, out: string[]): void {
  out.push(openTag(node));
  if (VOID.has(node.tagName)) return;
  if (OPAQUE.has(node.tagName)) {
    if (node.textContent !== null && node.textContent.length > 0) out.push("…");
  } else if (depth >= MAX_MARKUP_DEPTH) {
    if (node.childNodes.length > 0) out.push("…");
  } else {
    let written = 0;
    for (const child of Array.from(node.childNodes)) {
      if (written >= MAX_CHILDREN) {
        out.push("…");
        break;
      }
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length === 0) continue;
        out.push(escapeText(clamp(text, MAX_TEXT)));
        written += 1;
      } else if (child.nodeType === 1) {
        writeMarkup(child as Element, depth + 1, out);
        written += 1;
      }
    }
  }
  out.push(`</${node.tagName.toLowerCase()}>`);
}

/** The element's markup two levels deep, with input values, payloads and handlers left out. */
export function markupFor(node: Element): { markup: string; truncated: boolean } {
  const out: string[] = [];
  writeMarkup(node, 0, out);
  const markup = out.join("");
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
    out.push({ property, value: clamp(value, GUEST_CONTEXT_LIMITS.value) });
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
