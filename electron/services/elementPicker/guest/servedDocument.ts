/// <reference lib="dom" />
/**
 * The markup a dev server served for this document, and where a live element
 * sits in it. The host reads the response back from the browser's own cache
 * and hands it to an extractor at install; nothing here asks the server again.
 * It is for a framework whose dev tooling takes its own stamps off the live
 * elements after load, as Astro's toolbar does: the served copy still has them.
 *
 * The served markup is parsed once, on the first selection that needs it, by
 * the browser's own parser, so it yields the tree this document was built from
 * before any script ran. A live element is matched to it by its path from the
 * root, and only where everything on that path still agrees: at every level
 * the same number of elements of its name under its parent, and at the end
 * the same id and the same text of its own. Page script that added, removed
 * or rewrote any of that makes the match fail rather than drift to a
 * neighbour. Elements of other names may come and go — a dev toolbar appended
 * to the body, a style injected into the head, the picker's own overlay — so
 * they do not count. Identical markup moved into an identical place still
 * reads as matching: structure is evidence, not identity.
 */

import { ANCESTRY_LIMIT } from "./detectors.js";

/** What the host hands an extractor: the bytes the document was parsed from, and the URL they were served for. */
export interface ServedDocumentInput {
  url: string;
  html: string;
}

/** Element children read under one parent before the match gives up. */
export const SERVED_SIBLING_LIMIT = 1024;
/** Characters of an element's own text compared, once whitespace is collapsed. */
export const SERVED_TEXT_LIMIT = 1024;

/**
 * `unavailable`: there is no served copy to read, it could not be parsed, or
 * the page has moved to another URL since it was served. `unmatched`: there
 * is, but the element has no counterpart in it that everything agrees on.
 */
export type ServedLookup = Element | "unavailable" | "unmatched";

export interface ServedDocument {
  lookup(element: Element): ServedLookup;
  dispose(): void;
}

interface Step {
  name: string;
  namespace: string | null;
  ordinal: number;
  count: number;
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/** Where `element` sits among its parent's children of its own name, or null past the bound. */
function stepOf(element: Element, parent: Element): Step | null {
  let ordinal = -1;
  let count = 0;
  let seen = 0;
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
    seen += 1;
    if (seen > SERVED_SIBLING_LIMIT) return null;
    if (child.localName !== element.localName || child.namespaceURI !== element.namespaceURI) {
      continue;
    }
    if (child === element) ordinal = count;
    count += 1;
  }
  return ordinal === -1
    ? null
    : { name: element.localName, namespace: element.namespaceURI, ordinal, count };
}

/** The steps from the document element down to `element`; null outside the light DOM or past the bound. */
function pathOf(element: Element): Step[] | null {
  const doc = element.ownerDocument;
  if (!element.isConnected || element.getRootNode() !== doc) return null;
  const steps: Step[] = [];
  let node = element;
  for (let depth = 0; depth < ANCESTRY_LIMIT; depth += 1) {
    const parent = node.parentElement;
    if (parent === null) return node === doc.documentElement ? steps.reverse() : null;
    const step = stepOf(node, parent);
    if (step === null) return null;
    steps.push(step);
    node = parent;
  }
  return null;
}

function follow(steps: readonly Step[], live: Document, served: Document): Element | null {
  let node = served.documentElement;
  if (node === null || node.localName !== live.documentElement?.localName) return null;
  for (const step of steps) {
    let match: Element | null = null;
    let count = 0;
    let seen = 0;
    for (let child = node.firstElementChild; child !== null; child = child.nextElementSibling) {
      seen += 1;
      if (seen > SERVED_SIBLING_LIMIT) return null;
      if (child.localName !== step.name || child.namespaceURI !== step.namespace) continue;
      if (count === step.ordinal) match = child;
      count += 1;
    }
    if (match === null || count !== step.count) return null;
    node = match;
  }
  return node;
}

/** The element's own text nodes, whitespace collapsed, bounded. */
function ownText(element: Element): string {
  let text = "";
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType !== 3) continue;
    text += child.nodeValue ?? "";
    // Collapsing never lengthens it, so this much always covers the compared prefix.
    if (text.length > SERVED_TEXT_LIMIT * 4) break;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, SERVED_TEXT_LIMIT);
}

function agrees(live: Element, served: Element): boolean {
  return live.getAttribute("id") === served.getAttribute("id") && ownText(live) === ownText(served);
}

function isInput(value: unknown): value is ServedDocumentInput {
  if (typeof value !== "object" || value === null) return false;
  const { url, html } = value as Record<string, unknown>;
  return typeof url === "string" && typeof html === "string";
}

/**
 * A reader over what the host handed in, which may be nothing. Holds the
 * parsed copy for as long as the extractor that owns it is installed.
 */
export function createServedDocument(input: unknown): ServedDocument {
  let pending: ServedDocumentInput | null = isInput(input) ? input : null;
  const url = pending === null ? null : withoutFragment(pending.url);
  let parsed: Document | null = null;

  function document(): Document | null {
    if (pending !== null) {
      const { html } = pending;
      pending = null;
      try {
        parsed = new DOMParser().parseFromString(html, "text/html");
      } catch {
        // A page enforcing Trusted Types refuses a plain string here.
        parsed = null;
      }
    }
    return parsed;
  }

  return {
    lookup(element) {
      if (url === null) return "unavailable";
      // A client-side navigation keeps the document and swaps its markup, so
      // what was served for another URL describes another page.
      if (withoutFragment(element.ownerDocument.location?.href ?? "") !== url) {
        return "unavailable";
      }
      const served = document();
      if (served === null) return "unavailable";
      const steps = pathOf(element);
      if (steps === null) return "unmatched";
      const counterpart = follow(steps, element.ownerDocument, served);
      return counterpart !== null && agrees(element, counterpart) ? counterpart : "unmatched";
    },
    dispose() {
      pending = null;
      parsed = null;
    },
  };
}
