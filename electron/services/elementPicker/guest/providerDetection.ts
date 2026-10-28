/// <reference lib="dom" />
/**
 * Declarative detection for plugin providers, in the main-world probe. A
 * provider declares names to look for and how to compare them; this reads names
 * only, the way the core detectors do: it never reads a global's value, never
 * calls into the page and reports the declared marker, not what the page called
 * it, so the evidence a detection carries is the manifest's even on a hostile page.
 */

import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import { DETECTION_LIMITS, DOCUMENT_SAMPLE_LIMIT } from "./detectors.js";

/** What the host hands the probe: a registered provider's id and its rules, never a path or source. */
export interface ProviderProbeRule {
  kind: "global" | "expando" | "attribute" | "tag";
  name: string;
  match: "exact" | "prefix";
}
export interface ProviderProbe {
  id: string;
  rules: readonly ProviderProbeRule[];
}

/** Property names read off the global object when a rule asks for a prefix. */
const GLOBAL_NAME_LIMIT = 4096;
const NODE_KEY_LIMIT = 32;
const EXPANDO_NAME_LIMIT = 128;

function nameMatches(rule: ProviderProbeRule, name: string): boolean {
  return rule.match === "exact" ? name === rule.name : name.startsWith(rule.name);
}

function globalPresent(scope: object, rule: ProviderProbeRule): boolean {
  if (rule.match === "exact") {
    try {
      return rule.name in scope;
    } catch {
      return false;
    }
  }
  try {
    const names = Object.getOwnPropertyNames(scope);
    const limit = Math.min(names.length, GLOBAL_NAME_LIMIT);
    for (let index = 0; index < limit; index += 1) {
      if (nameMatches(rule, names[index] as string)) return true;
    }
  } catch {
    // A global object that cannot be listed is no evidence either way.
  }
  return false;
}

function nodeHas(node: Element, rule: ProviderProbeRule): boolean {
  try {
    if (rule.kind === "tag") return nameMatches(rule, node.localName);
    if (rule.kind === "attribute") {
      const names = node.getAttributeNames();
      const limit = Math.min(names.length, NODE_KEY_LIMIT);
      for (let index = 0; index < limit; index += 1) {
        if (nameMatches(rule, names[index] as string)) return true;
      }
      return false;
    }
    if (rule.match === "exact") return Object.hasOwn(node, rule.name);
    // Own names, enumerable or not: frameworks define their expandos either way.
    const keys = Object.getOwnPropertyNames(node);
    const limit = Math.min(keys.length, EXPANDO_NAME_LIMIT);
    for (let index = 0; index < limit; index += 1) {
      if (nameMatches(rule, keys[index] as string)) return true;
    }
  } catch {
    // A node that cannot be asked is no evidence either way.
  }
  return false;
}

/**
 * The providers whose rules matched, as detections the host validates against
 * the wire schema and its own registry. Bounded: one pass over at most
 * {@link DOCUMENT_SAMPLE_LIMIT} elements, however many providers or rules.
 */
export function detectProviders(
  providers: readonly ProviderProbe[],
  scope: object,
  doc: Document,
  room: number = DETECTION_LIMITS.detections
): FrameworkDetection[] {
  if (providers.length === 0 || room <= 0) return [];
  const signals = new Map<string, Map<string, FrameworkDetection["signals"][number]>>();
  const note = (id: string, rule: ProviderProbeRule): void => {
    let seen = signals.get(id);
    if (seen === undefined) {
      seen = new Map();
      signals.set(id, seen);
    }
    const via = rule.kind === "tag" ? "document-sample" : rule.kind;
    const key = via + " " + rule.name;
    if (!seen.has(key) && seen.size < DETECTION_LIMITS.signals) {
      seen.set(key, { via, name: rule.name });
    }
  };

  const nodeRules: Array<{ id: string; rule: ProviderProbeRule }> = [];
  for (const provider of providers) {
    for (const rule of provider.rules) {
      if (rule.kind === "global") {
        if (globalPresent(scope, rule)) note(provider.id, rule);
      } else {
        nodeRules.push({ id: provider.id, rule });
      }
    }
  }
  const root = doc.documentElement;
  if (nodeRules.length > 0 && root !== null) {
    const walker = doc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
    let visited = 0;
    for (
      let node: Node | null = walker.currentNode;
      node !== null && visited < DOCUMENT_SAMPLE_LIMIT;
    ) {
      if (node.nodeType === 1) {
        visited += 1;
        for (const { id, rule } of nodeRules) {
          if (nodeHas(node as Element, rule)) note(id, rule);
        }
      }
      node = walker.nextNode();
    }
  }

  const found: FrameworkDetection[] = [];
  for (const [framework, seen] of signals) {
    if (found.length >= room) break;
    found.push({ framework, signals: [...seen.values()] });
  }
  return found;
}
