/// <reference lib="dom" />
/**
 * What a stock Preact 11 page says about a picked element, read from its
 * vnode tree: the components above it by render parent, each one's rendered
 * DOM roots, and the jsx-source objects a dev transform left on the vnodes.
 * No hook is installed, no option set, and nothing in the page is written to;
 * whether `preact/debug` is loaded is the page's business, observed and
 * reported but never arranged.
 *
 * Preact records no owners and captures no stacks, so there are no owner
 * edges and no generated frames: a `__source` is the only position the page
 * gives, and it is already in authored coordinates. Without one, the picker
 * says the file and line are not exposed.
 *
 * Hover pays for one bounded lookup and a walk up to the nearest component;
 * the chain, roots and sources are read on selection only.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { Capabilities, Capability } from "../../../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import type { ElementPickerExtractor, ElementRefs } from "../registry.js";
import type { ExtractorContribution } from "../types.js";
import {
  Budget,
  ComponentIds,
  KnownRoots,
  componentName,
  componentsAbove,
  hasDebugPrototype,
  lookupHost,
  nearestComponent,
  own,
  renderedRoots,
  sourceOf,
  type HostMatch,
  type VNode,
} from "./vnode.js";

/** Restated from `COMPONENT_LIMITS`: a value import would bundle zod into the page. */
const LIMITS = { records: 64, roots: 32 } as const;

const STEPS = {
  hover: 2_048,
  hoverAncestry: 2_048,
  lookup: 8_192,
  ancestry: 4_096,
  roots: 32_768,
  /** One component's share of `roots`, so an app-sized outer component cannot starve the rest. */
  rootsPerRecord: 4_096,
} as const;

/** Restated from `ReportedFileSchema` and `MAX_SOURCE_COORDINATE`. */
const MAX_FILE_CHARS = 2048;
const MAX_COORDINATE = 10_000_000;

/**
 * File paths are the bulk of a reply, and a reply over the bridge's ceiling is
 * dropped whole, so sources stop at a share of it, the innermost first. The
 * reply as a whole is checked against the rest.
 */
const MAX_CANDIDATE_CHARS = 32 * 1024;
const CANDIDATE_OVERHEAD_CHARS = 256;
/** UTF-8 bytes, which bound the bridge's code units and the host's envelope bytes alike. */
const MAX_REPLY_BYTES = 96 * 1024;

const AVAILABLE: Capability = { state: "available" };
const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };

function recordFor(vnode: VNode, id: string): ComponentRecord {
  const name = componentName(vnode);
  return {
    componentId: id,
    framework: "preact",
    name:
      name === null
        ? null
        : { value: name.value, extraction: { kind: "runtime-field", field: name.field } },
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [],
  };
}

function coordinate(source: unknown, key: string): number | null {
  const value = own(source, key);
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_COORDINATE
    ? value
    : null;
}

class CandidateWriter {
  private next = 0;
  private chars = 0;
  /** Sources read but not sent, past the reply's share. */
  omitted = 0;

  /**
   * The vnode's jsx-source as a claim of `kind`, verbatim: 1-based line and
   * 1-based UTF-16 column, as Babel, esbuild and Oxc all write it. A source
   * missing its file or either coordinate is no position, so it is no claim.
   */
  write(vnode: VNode, kind: "element-creation" | "component-invocation"): SourceCandidate[] {
    const read = sourceOf(vnode);
    if (read === null) return [];
    const file = own(read.source, "fileName");
    const line = coordinate(read.source, "lineNumber");
    const column = coordinate(read.source, "columnNumber");
    if (typeof file !== "string" || file.length === 0 || file.length > MAX_FILE_CHARS) return [];
    if (line === null || column === null) return [];
    const size = file.length + CANDIDATE_OVERHEAD_CHARS;
    if (this.chars + size > MAX_CANDIDATE_CHARS) {
      this.omitted += 1;
      return [];
    }
    this.chars += size;
    this.next += 1;
    return [
      {
        kind,
        candidateId: `preact-source-${this.next}`,
        framework: "preact",
        extraction: { kind: "runtime-field", field: read.field },
        file,
        location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line, column },
      },
    ];
  }
}

function hoverOf(match: HostMatch, ids: ComponentIds): ExtractorContribution {
  const nearest = nearestComponent(match.vnode, match.root, new Budget(STEPS.hoverAncestry));
  const capabilities: Capabilities = {
    names: nearest === null ? UNKNOWN : AVAILABLE,
    chain: UNKNOWN,
    componentSelection: UNKNOWN,
    file: UNKNOWN,
    line: UNKNOWN,
    exactRange: UNKNOWN,
  };
  if (nearest === null) {
    return { componentChain: { nearestId: null, components: [], truncated: true }, capabilities };
  }
  const record = recordFor(nearest, ids.idOf(nearest));
  // One record by design: the rest of the chain is a selection's to read.
  return {
    componentChain: { nearestId: record.componentId, components: [record], truncated: true },
    capabilities,
  };
}

function selectionOf(
  match: HostMatch,
  lookupTruncated: boolean,
  ids: ComponentIds,
  refs: ElementRefs
): ExtractorContribution {
  const ancestry = componentsAbove(
    match.vnode,
    match.root,
    new Budget(STEPS.ancestry),
    LIMITS.records
  );
  // A lookup that ran out settled for an ancestor, and whatever it never
  // reached between that and the picked node is missing from the chain.
  let truncated = ancestry.truncated || lookupTruncated;
  const records: ComponentRecord[] = [];
  const vnodes: VNode[] = [];
  for (const vnode of ancestry.components) {
    const id = ids.idOf(vnode);
    // Two vnodes claiming one instance is page data in a shape Preact never makes.
    if (records.some((record) => record.componentId === id)) {
      truncated = true;
      break;
    }
    records.push(recordFor(vnode, id));
    vnodes.push(vnode);
  }
  const reachedRoot = ancestry.reachedRoot && records.length === ancestry.components.length;
  records.forEach((record, index) => {
    const parent = records[index + 1];
    if (parent !== undefined) record.renderParentId = parent.componentId;
    else if (reachedRoot) record.renderParentId = null;
  });

  const rootBudget = new Budget(STEPS.roots);
  records.forEach((record, index) => {
    const roots = renderedRoots(
      vnodes[index]!,
      match.root,
      LIMITS.roots,
      new Budget(STEPS.rootsPerRecord, rootBudget)
    );
    let complete = roots.complete;
    for (const element of roots.elements) {
      const token = refs.ref(element);
      if (token === null) complete = false;
      else record.rootElementIds.push(token);
    }
    record.rootsComplete = complete;
  });

  const writer = new CandidateWriter();
  // Only the picked node's own vnode says where the node was created.
  const sourceCandidates = match.own ? writer.write(match.vnode, "element-creation") : [];
  records.forEach((record, index) => {
    record.sourceCandidates = writer.write(vnodes[index]!, "component-invocation");
  });
  const debug = hasDebugPrototype(match.vnode);

  let kept = records;
  let elementCandidates = sourceCandidates;
  let omitted = writer.omitted;
  const build = (): ExtractorContribution => {
    const componentChain: ComponentChain = {
      nearestId: kept.length > 0 ? kept[0]!.componentId : null,
      components: kept,
      truncated,
    };
    // Sources held back for size are still sources the page exposed.
    const located =
      omitted > 0 ||
      elementCandidates.length > 0 ||
      kept.some((record) => record.sourceCandidates.length > 0);
    return {
      componentChain,
      sourceCandidates: elementCandidates,
      // What the reading rests on, for a reader deciding how far to trust it.
      frameworkEvidence: [
        {
          kind: "generic",
          framework: "preact",
          fields: [
            { name: "vnodeLookup", value: match.own ? "element" : "ancestor" },
            { name: "lookupTruncated", value: lookupTruncated },
            { name: "debugPrototype", value: debug },
            { name: "sourcesOmitted", value: omitted },
          ],
        },
      ],
      capabilities: {
        names: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
        chain: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
        componentSelection: kept.some((record) => record.rootElementIds.length > 0)
          ? AVAILABLE
          : NOT_EXPOSED,
        // A jsx-source is an authored position already; checking it is the host's.
        file: located ? AVAILABLE : NOT_EXPOSED,
        line: located ? AVAILABLE : NOT_EXPOSED,
        // A start position only; the host may find the element's range in the file.
        exactRange: located ? UNKNOWN : NOT_EXPOSED,
      },
    };
  };

  // The candidate budget keeps a reply small, but names are page data too. Past
  // the ceiling the sources go first, then the outermost records, until it fits.
  let contribution = build();
  if (fits(contribution)) return contribution;
  omitted += elementCandidates.length;
  elementCandidates = [];
  for (const record of kept) {
    omitted += record.sourceCandidates.length;
    record.sourceCandidates = [];
  }
  contribution = build();
  while (!fits(contribution) && kept.length > 1) {
    kept = keepInnermost(kept, Math.floor(kept.length / 2));
    truncated = true;
    contribution = build();
  }
  return contribution;
}

function fits(contribution: ExtractorContribution): boolean {
  return new TextEncoder().encode(JSON.stringify(contribution)).length <= MAX_REPLY_BYTES;
}

/** The first `count` records, with every edge into a record left behind omitted rather than dangling. */
function keepInnermost(records: ComponentRecord[], count: number): ComponentRecord[] {
  const kept = records.slice(0, count);
  const ids = new Set(kept.map((record) => record.componentId));
  for (const record of kept) {
    if (typeof record.renderParentId === "string" && !ids.has(record.renderParentId)) {
      delete record.renderParentId;
    }
  }
  return kept;
}

export function createPreactExtractor(): ElementPickerExtractor {
  // Per install, so ids last as long as the bootstrap that shows them.
  const ids = new ComponentIds("preact-");
  const roots = new KnownRoots();
  let disposed = false;
  return {
    extract(element, phase, refs) {
      if (disposed) return null;
      const selection = phase === "selection";
      // Only a selection sweeps the document for a portal's tree; hover uses what it has seen.
      const lookup = lookupHost(
        element,
        roots,
        new Budget(selection ? STEPS.lookup : STEPS.hover),
        selection
      );
      if (lookup.match === null) return null;
      return selection
        ? selectionOf(lookup.match, lookup.truncated, ids, refs)
        : hoverOf(lookup.match, ids);
    },
    locate(query, anchor) {
      if (disposed || anchor === null || own(query, "kind") !== "roots") return null;
      const componentId = own(query, "componentId");
      if (typeof componentId !== "string") return null;
      const { match } = lookupHost(anchor, roots, new Budget(STEPS.lookup), true);
      if (match === null) return null;
      const ancestry = componentsAbove(
        match.vnode,
        match.root,
        new Budget(STEPS.ancestry),
        LIMITS.records
      );
      const component = ancestry.components.find((vnode) => ids.idOf(vnode) === componentId);
      if (component === undefined) return null;
      const found = renderedRoots(
        component,
        match.root,
        LIMITS.roots,
        new Budget(STEPS.rootsPerRecord)
      );
      return { elements: found.elements, data: { complete: found.complete } };
    },
    dispose() {
      disposed = true;
      roots.clear();
    },
  };
}
