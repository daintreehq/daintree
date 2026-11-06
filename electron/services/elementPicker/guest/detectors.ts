/// <reference lib="dom" />
/**
 * Cheap, passive framework detectors. They read names — a global, an expando
 * key, an attribute, a tag — and report which fixed marker they matched. They
 * never call into the page, never install a hook, and never report a value the
 * page chose: every signal name below is a literal from these tables, so the
 * evidence a detection carries is ours even when the page is hostile.
 *
 * Two callers run them in different worlds. The main-world probe can see
 * globals and node expandos; the isolated-world bootstrap sees only the DOM, so
 * it reads attributes and tags. A marker is evidence, not a verdict: a class
 * that happens to start with `svelte-` costs at most an extractor that finds
 * nothing to extract.
 */

import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import type { ElementPickerFramework } from "../../../../shared/elementPicker/source.js";

type Via = FrameworkDetection["signals"][number]["via"];

/** Restated from `OBSERVATION_LIMITS`: a value import would bundle zod into the page. */
export const DETECTION_LIMITS = { detections: 8, signals: 16 } as const;

/** Elements the document sample visits; the probe stops there whatever it found. */
export const DOCUMENT_SAMPLE_LIMIT = 256;
/**
 * The body's last children, read for their tag alone when the sample stopped
 * short of them: a dev tool appends its own element there once the page has
 * loaded, after however much markup.
 */
export const BODY_TAIL_LIMIT = 8;
/** Ancestors walked from a selected element, its own node included. */
export const ANCESTRY_LIMIT = 64;
/** Own keys read off one node when looking for expandos. */
const EXPANDO_KEY_LIMIT = 32;
const ATTRIBUTE_LIMIT = 32;
const CLASS_LIMIT = 16;

interface GlobalMarker {
  framework: ElementPickerFramework;
  name: string;
  /** Matches globals that start with `name` (SvelteKit suffixes a build hash). */
  prefix?: true;
}

/**
 * Set by the framework itself, never by a devtools extension: a hook a user's
 * extension installed says the extension is present, not the framework.
 * Meta-frameworks count as evidence for the framework they render with.
 */
const GLOBAL_MARKERS: readonly GlobalMarker[] = [
  { framework: "svelte", name: "__svelte" },
  { framework: "svelte", name: "__sveltekit_", prefix: true },
  { framework: "react", name: "__NEXT_DATA__" },
  { framework: "react", name: "__next_f" },
  { framework: "vue", name: "__VUE__" },
  { framework: "vue", name: "__NUXT__" },
  // Hydration only: a client-rendered Solid app never sets it.
  { framework: "solid", name: "_$HY" },
  // Solid's dev build guards against a second copy of itself with this, and
  // it is the only mark a client-rendered app leaves.
  { framework: "solid", name: "Solid$$" },
];

interface ExpandoMarker {
  framework: ElementPickerFramework;
  name: string;
  /** React suffixes its keys with a per-root random string. */
  prefix?: true;
}

const EXPANDO_MARKERS: readonly ExpandoMarker[] = [
  { framework: "react", name: "__reactFiber$", prefix: true },
  { framework: "react", name: "__reactContainer$", prefix: true },
  { framework: "react", name: "__reactProps$", prefix: true },
  { framework: "vue", name: "__vue_app__" },
  { framework: "vue", name: "__vueParentComponent" },
  { framework: "vue", name: "__vnode" },
  { framework: "svelte", name: "__svelte_meta" },
  { framework: "angular", name: "__ngContext__" },
  // Preact's mangled `_children`, which only a render container carries.
  { framework: "preact", name: "__k" },
];

interface AttributeMarker {
  framework: ElementPickerFramework;
  name: string;
  prefix?: true;
}

const ATTRIBUTE_MARKERS: readonly AttributeMarker[] = [
  { framework: "angular", name: "ng-version" },
  { framework: "angular", name: "_nghost-", prefix: true },
  { framework: "angular", name: "_ngcontent-", prefix: true },
  { framework: "vue", name: "data-v-app" },
  { framework: "vue", name: "data-v-", prefix: true },
  { framework: "svelte", name: "data-sveltekit-", prefix: true },
  { framework: "astro", name: "data-astro-cid-", prefix: true },
  { framework: "astro", name: "data-astro-source-file" },
  { framework: "solid", name: "data-hk" },
];

const TAG_MARKERS: ReadonlyMap<string, ElementPickerFramework> = new Map([
  // Astro's dev toolbar, appended to the body only while the toolbar is on,
  // which is exactly when the compiler stamps source attributes: the toolbar
  // takes those off the elements, so on a page with no islands or scoped
  // styles it is the one mark left.
  ["astro-dev-toolbar", "astro"],
  ["astro-island", "astro"],
  ["astro-slot", "astro"],
  ["astro-static-slot", "astro"],
  ["next-route-announcer", "react"],
  ["nextjs-portal", "react"],
]);

/** What an island's renderer is, read off its `renderer-url`; the island itself is Astro's. */
const ISLAND_RENDERERS: ReadonlyArray<[string, ElementPickerFramework]> = [
  ["@astrojs/react", "react"],
  ["@astrojs/preact", "preact"],
  ["@astrojs/vue", "vue"],
  ["@astrojs/svelte", "svelte"],
  ["@astrojs/solid", "solid"],
];

/** The framework a `renderer-url` names, by the same fixed table detection reads; null for any other. */
export function islandRenderer(rendererUrl: string): ElementPickerFramework | null {
  for (const [needle, framework] of ISLAND_RENDERERS) {
    if (rendererUrl.includes(needle)) return framework;
  }
  return null;
}

/**
 * Svelte's scoped-style class: `svelte-` and a base-36 hash of five to eight
 * characters, about one in eight of them letters only. A page's own
 * `svelte-header` reads the same; that costs an extractor finding nothing,
 * where demanding a digit would miss those components outright.
 */
const SVELTE_CLASS = /^svelte-[a-z0-9]{5,8}$/;

/**
 * The detections found so far, bounded the way the wire schema bounds them so
 * an over-eager page cannot make the guest build a message the host will drop.
 */
export class DetectionSet {
  private readonly byFramework = new Map<ElementPickerFramework, Map<string, Via>>();

  add(framework: ElementPickerFramework, via: Via, name: string): void {
    let signals = this.byFramework.get(framework);
    if (signals === undefined) {
      if (this.byFramework.size >= DETECTION_LIMITS.detections) return;
      signals = new Map();
      this.byFramework.set(framework, signals);
    }
    const key = via + " " + name;
    if (signals.has(key) || signals.size >= DETECTION_LIMITS.signals) return;
    signals.set(key, via);
  }

  get size(): number {
    return this.byFramework.size;
  }

  has(framework: ElementPickerFramework): boolean {
    return this.byFramework.has(framework);
  }

  toArray(): FrameworkDetection[] {
    const out: FrameworkDetection[] = [];
    for (const [framework, signals] of this.byFramework) {
      out.push({
        framework,
        signals: [...signals].map(([key, via]) => ({ via, name: key.slice(via.length + 1) })),
      });
    }
    return out;
  }
}

/** Main world only: an isolated world has its own globals and sees none of the page's. */
export function detectGlobals(scope: object, into: DetectionSet): void {
  let names: string[] | null = null;
  for (const marker of GLOBAL_MARKERS) {
    if (marker.prefix) {
      try {
        names ??= Object.keys(scope);
      } catch {
        names = [];
      }
      if (names.some((name) => name.startsWith(marker.name))) {
        into.add(marker.framework, "global", marker.name + "*");
      }
      continue;
    }
    let present = false;
    try {
      present = marker.name in scope;
    } catch {
      // A proxy-backed global object can throw on `in`; that is no evidence either way.
    }
    if (present) into.add(marker.framework, "global", marker.name);
  }
}

/** Main world only, for the same reason: expandos are per-world properties. */
export function detectExpandos(node: Element, into: DetectionSet): void {
  let keys: string[];
  try {
    keys = Object.keys(node);
  } catch {
    return;
  }
  const limit = Math.min(keys.length, EXPANDO_KEY_LIMIT);
  const listed = new Set<string>();
  for (let index = 0; index < limit; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    for (const marker of EXPANDO_MARKERS) {
      const matches = marker.prefix ? key.startsWith(marker.name) : key === marker.name;
      if (!matches) continue;
      into.add(marker.framework, "expando", marker.prefix ? marker.name + "*" : key);
      listed.add(marker.name);
    }
  }
  // Asked by name as well: Vue defines its expandos non-enumerable, so no list has them.
  for (const marker of EXPANDO_MARKERS) {
    if (marker.prefix || listed.has(marker.name)) continue;
    let own = false;
    try {
      own = Object.hasOwn(node, marker.name);
    } catch {
      // A node that cannot be asked is no evidence either way.
    }
    if (own) into.add(marker.framework, "expando", marker.name);
  }
}

/** Attributes, tags and classes: the part of a node every world can see. */
export function detectMarkup(node: Element, via: Via, into: DetectionSet): void {
  const tag = node.localName;
  const tagFramework = TAG_MARKERS.get(tag);
  if (tagFramework !== undefined) into.add(tagFramework, via, "<" + tag + ">");
  if (tag === "astro-island") {
    const renderer = node.getAttribute("renderer-url");
    if (renderer !== null) {
      for (const [needle, framework] of ISLAND_RENDERERS) {
        if (renderer.includes(needle)) into.add(framework, via, "astro-island[renderer-url]");
      }
    }
  }
  if (node.id === "__next") into.add("react", via, "#__next");

  const attributes = node.attributes;
  const attributeCount = Math.min(attributes.length, ATTRIBUTE_LIMIT);
  for (let index = 0; index < attributeCount; index += 1) {
    const name = attributes[index]?.name;
    if (name === undefined) continue;
    // First match only: `data-v-app` is not also a scoped-style `data-v-*`.
    for (const marker of ATTRIBUTE_MARKERS) {
      const matches = marker.prefix ? name.startsWith(marker.name) : name === marker.name;
      if (!matches) continue;
      into.add(marker.framework, via, marker.prefix ? marker.name + "*" : name);
      break;
    }
  }

  const classes = node.classList;
  const classCount = Math.min(classes.length, CLASS_LIMIT);
  for (let index = 0; index < classCount; index += 1) {
    const entry = classes[index];
    if (entry !== undefined && SVELTE_CLASS.test(entry)) {
      into.add("svelte", via, "class=svelte-*");
      break;
    }
  }
}

/**
 * A bounded walk of the document in tree order and, when that stopped short,
 * the tags of the body's last few children. Bounded by count rather than time
 * so two runs over the same document report the same thing.
 */
export function sampleDocument(
  doc: Document,
  into: DetectionSet,
  options: { expandos: boolean; limit?: number }
): void {
  const root = doc.documentElement;
  if (root === null) return;
  const limit = options.limit ?? DOCUMENT_SAMPLE_LIMIT;
  const walker = doc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
  let visited = 0;
  let node: Node | null = walker.currentNode;
  for (; node !== null && visited < limit; node = walker.nextNode()) {
    if (node.nodeType !== 1) continue;
    visited += 1;
    const element = node as Element;
    detectMarkup(element, "document-sample", into);
    if (options.expandos) detectExpandos(element, into);
  }
  if (node === null) return;
  let tail = doc.body?.lastElementChild ?? null;
  for (let count = 0; tail !== null && count < BODY_TAIL_LIMIT; count += 1) {
    const framework = TAG_MARKERS.get(tail.localName);
    if (framework !== undefined) into.add(framework, "document-sample", "<" + tail.localName + ">");
    tail = tail.previousElementSibling;
  }
}

/** The element and its ancestors, crossing out of shadow roots to their hosts. */
export function detectAncestry(start: Element, into: DetectionSet): void {
  let node: Element | null = start;
  for (let depth = 0; node !== null && depth < ANCESTRY_LIMIT; depth += 1) {
    detectMarkup(node, "attribute", into);
    node = parentAcrossShadow(node);
  }
}

export function parentAcrossShadow(node: Element): Element | null {
  if (node.parentElement !== null) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
