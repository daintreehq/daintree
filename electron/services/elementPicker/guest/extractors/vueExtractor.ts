/// <reference lib="dom" />
/**
 * What a stock Vue 3 dev build says about a picked element, read from its
 * component instances: the components above it by render parent and by owner,
 * each one's rendered DOM roots, the files `@vitejs/plugin-vue` names for them,
 * and the template positions `vite-plugin-vue-inspector` stamps, when the user
 * runs it. No hook is installed and nothing in the page is written to.
 *
 * A component's `__file` is a file and nothing finer, so it is only ever a
 * `file-hint`; a line comes from a stamp or not at all. Hover pays for one
 * lookup and a name; the chain, roots and sources are read on selection only.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { GenericEvidence } from "../../../../../shared/elementPicker/evidence.js";
import type { Capabilities, Capability } from "../../../../../shared/elementPicker/observation.js";
import type {
  Extraction,
  ObservedName,
  SourceCandidate,
} from "../../../../../shared/elementPicker/source.js";
import type { ElementPickerExtractor, ElementRefs } from "../registry.js";
import type { ExtractorContribution } from "../types.js";
import {
  Budget,
  InstanceIds,
  appVersion,
  componentFile,
  componentName,
  ownVNodeAt,
  field,
  instanceApp,
  isInstance,
  isProductionApp,
  lookUp,
  ownerOf,
  parentOf,
  renderedRoots,
  staticBlockOf,
  type Lookup,
  type VueInstance,
} from "./vueInstance.js";
import { anchorStamp, elementStamp, invocationStamp, type Stamp } from "./vueStamps.js";

/** Restated from `COMPONENT_LIMITS` and `OBSERVATION_LIMITS`: a value import would bundle zod into the page. */
const LIMITS = { records: 64, roots: 32, candidates: 4 } as const;
/** Restated from `ReportedFileSchema`. */
const MAX_FILE_CHARS = 2048;

const STEPS = {
  ancestry: 4_096,
  roots: 32_768,
  /** One component's share of `roots`, so an app-sized outer component cannot starve the rest. */
  rootsPerRecord: 4_096,
  /** Looking for the static block a node Vue left unmarked came from. */
  staticSearch: 4_096,
} as const;

/** Paths are the bulk of a reply, and a reply over the bridge's ceiling is dropped whole. */
const MAX_CANDIDATE_CHARS = 32 * 1024;
const CANDIDATE_OVERHEAD_CHARS = 256;
/** UTF-8 bytes, which bound the bridge's code units and the host's envelope bytes alike. */
const MAX_REPLY_BYTES = 96 * 1024;

const AVAILABLE: Capability = { state: "available" };
const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };

function observedName(instance: VueInstance): ObservedName | null {
  const name = componentName(instance);
  return name === null
    ? null
    : { value: name.value, extraction: { kind: "runtime-field", field: name.field } };
}

function recordFor(instance: VueInstance, id: string): ComponentRecord {
  return {
    componentId: id,
    framework: "vue",
    name: observedName(instance),
    // An instance on the page is a client one; server-only output leaves none.
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [],
  };
}

function hasDevRuntime(): boolean {
  try {
    return "__VUE_HMR_RUNTIME__" in globalThis;
  } catch {
    return false;
  }
}

function evidence(fields: GenericEvidence["fields"]): GenericEvidence {
  return { kind: "generic", framework: "vue", fields };
}

/** Owner edges come from page data, so one that loops is cut rather than sent to be refused. */
function cutOwnerCycles(records: ComponentRecord[]): boolean {
  const byId = new Map(records.map((record) => [record.componentId, record]));
  let cut = false;
  for (const start of records) {
    const path = new Set<string>();
    for (let record: ComponentRecord | undefined = start; record !== undefined;) {
      path.add(record.componentId);
      const next: string | null | undefined = record.ownerId;
      if (typeof next !== "string") break;
      if (path.has(next)) {
        delete record.ownerId;
        cut = true;
        break;
      }
      record = byId.get(next);
    }
  }
  return cut;
}

class CandidateWriter {
  private next = 0;
  private chars = 0;
  /** Claims read but not sent: past a limit, the reply's share, or a path too long to carry. */
  omitted = 0;

  private admit(file: string): boolean {
    const size = file.length + CANDIDATE_OVERHEAD_CHARS;
    if (file.length > MAX_FILE_CHARS || this.chars + size > MAX_CANDIDATE_CHARS) {
      this.omitted += 1;
      return false;
    }
    this.chars += size;
    this.next += 1;
    return true;
  }

  private id(): string {
    return `vue-claim-${this.next}`;
  }

  stamp(kind: "template-location" | "component-invocation", stamp: Stamp): SourceCandidate | null {
    if (!this.admit(stamp.file)) return null;
    return {
      kind,
      candidateId: this.id(),
      framework: "vue",
      extraction: stamp.extraction,
      file: stamp.file,
      location: {
        lineBase: 1,
        columnBase: 1,
        columnUnit: "utf16",
        line: stamp.line,
        column: stamp.column,
      },
    };
  }

  fileHint(file: string, extraction: Extraction): SourceCandidate | null {
    if (!this.admit(file)) return null;
    return { kind: "file-hint", candidateId: this.id(), framework: "vue", extraction, file };
  }
}

/**
 * Where the element's own facts were read: its element vnode, the static
 * vnode on a hydrated block's first node, the static block it sits in, an
 * ancestor with nothing more, a component waiting to hydrate on it, or none.
 */
type ElementSource = "element" | "static" | "static-block" | "ancestor" | "pending" | "none";

function present<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

function withoutInstance(found: Extract<Lookup, { kind: "app" }>, phase: "hover" | "selection") {
  // Only an empty field a dev build would have filled establishes a production
  // one; otherwise the metadata is simply not there (Vapor, an island's static
  // markup, nodes Vue never mounted).
  const missing: Capability = isProductionApp(found.app, found.container)
    ? { state: "unavailable", reason: "production-build" }
    : NOT_EXPOSED;
  const sources = phase === "hover" ? UNKNOWN : missing;
  const contribution: ExtractorContribution = {
    // It says only that Vue is here and keeps nothing on its nodes; any
    // framework that can say more about the element should.
    ownership: "fallback",
    componentChain: { nearestId: null, components: [], truncated: false },
    capabilities: {
      names: missing,
      chain: missing,
      componentSelection: missing,
      file: sources,
      line: sources,
      exactRange: sources,
    },
  };
  if (phase === "selection") {
    contribution.frameworkEvidence = [
      evidence([
        { name: "instanceLookup", value: "none" },
        { name: "version", value: appVersion(found.app) },
        { name: "appInstanceExposed", value: field(found.app, "_instance") != null },
        { name: "hmrRuntime", value: hasDevRuntime() },
      ]),
    ];
  }
  return contribution;
}

function hoverOf(instance: VueInstance, ids: InstanceIds): ExtractorContribution {
  const record = recordFor(instance, ids.idOf(instance));
  // One record by design: the rest of the chain is a selection's to read.
  return {
    componentChain: { nearestId: record.componentId, components: [record], truncated: true },
    capabilities: {
      names: record.name === null ? UNKNOWN : AVAILABLE,
      chain: UNKNOWN,
      componentSelection: UNKNOWN,
      file: UNKNOWN,
      line: UNKNOWN,
      exactRange: UNKNOWN,
    },
  };
}

function selectionOf(
  element: Element,
  found: Extract<Lookup, { kind: "instance" }>,
  ids: InstanceIds,
  refs: ElementRefs
): ExtractorContribution {
  const records: ComponentRecord[] = [];
  const instances: VueInstance[] = [];
  const indexById = new Map<string, number>();
  let truncated = false;

  const add = (instance: VueInstance): number | null => {
    const id = ids.idOf(instance);
    const known = indexById.get(id);
    if (known !== undefined) return known;
    if (records.length >= LIMITS.records) return null;
    indexById.set(id, records.length);
    records.push(recordFor(instance, id));
    instances.push(instance);
    return records.length - 1;
  };

  // Markup Vue left unmarked may sit in a static block of a component below
  // the instance it was found through; that component is the nearest one.
  const block = found.own
    ? null
    : staticBlockOf(found.instance, element, new Budget(STEPS.staticSearch));
  const nearest = block?.instance ?? found.instance;

  // Render ancestry, innermost first. Each record's render parent is the next.
  add(nearest);
  const ancestry = new Budget(STEPS.ancestry);
  let reachedRoot = false;
  for (let current = nearest; ;) {
    const parent = parentOf(current);
    if (parent === null) {
      reachedRoot = true;
      break;
    }
    if (parent === undefined || !ancestry.spend()) {
      truncated = true;
      break;
    }
    // A parent pointer back into the chain is a loop, not an ancestor.
    if (indexById.has(ids.idOf(parent)) || add(parent) === null) {
      truncated = true;
      break;
    }
    current = parent;
  }
  const rendered = records.length;
  for (let index = 0; index < rendered; index += 1) {
    if (index + 1 < rendered) records[index]!.renderParentId = records[index + 1]!.componentId;
    else if (reachedRoot) records[index]!.renderParentId = null;
  }

  // Owners. One outside the render chain — a component rendered through a
  // Teleport's or a slot's indirection from somewhere the walk did not pass —
  // gets a record of its own, with the render parent nobody walked left out.
  for (let index = 0; index < records.length; index += 1) {
    const owner = ownerOf(instances[index]!);
    if (owner === undefined) continue;
    if (owner === null) {
      records[index]!.ownerId = null;
      continue;
    }
    const ownerIndex = add(owner);
    if (ownerIndex === null) {
      truncated = true;
      continue;
    }
    if (ownerIndex !== index) records[index]!.ownerId = records[ownerIndex]!.componentId;
  }
  if (cutOwnerCycles(records)) truncated = true;

  const rootBudget = new Budget(STEPS.roots);
  records.forEach((record, index) => {
    const roots = renderedRoots(
      instances[index]!,
      LIMITS.roots,
      new Budget(STEPS.rootsPerRecord, rootBudget)
    );
    let complete = roots.complete;
    for (const node of roots.elements) {
      const token = refs.ref(node);
      if (token === null) complete = false;
      else record.rootElementIds.push(token);
    }
    record.rootsComplete = complete;
  });

  const writer = new CandidateWriter();
  // Which template the element is written in: its own vnode's author, or, for
  // markup a static block inserted, the block's. A stamp is held to that
  // template's file. A node a component is still waiting to hydrate on has
  // nothing of its own yet.
  const own = found.own ? ownVNodeAt(element) : null;
  const source: ElementSource =
    own?.kind ?? (block !== null ? "static-block" : found.own ? "none" : "ancestor");
  const authorVNode =
    own?.kind === "element" || own?.kind === "static" ? own.vnode : (block?.vnode ?? null);
  const author = field(authorVNode, "ctx");
  const templateFile = isInstance(author) ? componentFile(author) : null;
  const readable = source !== "pending" && source !== "none";
  // Only an element vnode carries props a component could have handed down.
  const elementVNode = own?.kind === "element" ? own.vnode : null;
  const read = readable
    ? elementStamp(element, elementVNode, elementVNode ? found.instance : null)
    : null;
  const stamp = read === null ? null : anchorStamp(read, templateFile);
  const elementCandidates = present([
    stamp === null ? null : writer.stamp("template-location", stamp),
    templateFile === null
      ? null
      : writer.fileHint(templateFile, {
          kind: "runtime-field",
          field: block === null ? "__vnode.ctx.type.__file" : "staticVNode.ctx.type.__file",
        }),
  ]);
  records.forEach((record, index) => {
    const instance = instances[index]!;
    const invoked = invocationStamp(instance);
    // The tag that used a component is written in its owner's template.
    const caller = ownerOf(instance);
    const invocation =
      invoked === null ? null : anchorStamp(invoked, caller ? componentFile(caller) : null);
    const file = componentFile(instance);
    record.sourceCandidates = present([
      invocation === null ? null : writer.stamp("component-invocation", invocation),
      file === null ? null : writer.fileHint(file, { kind: "runtime-field", field: "type.__file" }),
    ]).slice(0, LIMITS.candidates);
  });

  const lookup = found.own ? "element" : "ancestor";
  const version = appVersion(instanceApp(found.instance));
  const dev = hasDevRuntime();
  let kept = records;
  let candidates = elementCandidates;
  let omitted = writer.omitted;

  const build = (): ExtractorContribution => {
    const all = [...candidates, ...kept.flatMap((record) => record.sourceCandidates)];
    const positioned = all.some((candidate) => candidate.kind !== "file-hint");
    // Claims held back are still claims the runtime made; the page just could not send them.
    const missing = omitted > 0 ? UNKNOWN : NOT_EXPOSED;
    const componentChain: ComponentChain = {
      nearestId: rendered > 0 ? kept[0]!.componentId : null,
      components: kept,
      truncated,
    };
    const capabilities: Capabilities = {
      names: kept.some((record) => record.name !== null) ? AVAILABLE : NOT_EXPOSED,
      chain: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
      // A walk cut short has not shown there is nothing to select.
      componentSelection: kept.some((record) => record.rootElementIds.length > 0)
        ? AVAILABLE
        : kept.some((record) => !record.rootsComplete)
          ? UNKNOWN
          : NOT_EXPOSED,
      file: all.length > 0 ? AVAILABLE : missing,
      line: positioned ? AVAILABLE : missing,
      // A stamp is where a tag opens; whether the host can find where it ends is the host's to say.
      exactRange: positioned ? UNKNOWN : missing,
    };
    return {
      componentChain,
      sourceCandidates: candidates,
      // What the reading rests on, for a reader deciding how far to trust it.
      frameworkEvidence: [
        evidence([
          { name: "instanceLookup", value: lookup },
          { name: "version", value: version },
          { name: "hmrRuntime", value: dev },
          { name: "elementSource", value: source },
          { name: "elementStamp", value: stamp === null ? null : stamp.extraction.kind },
          { name: "claimsOmitted", value: omitted },
        ]),
      ],
      capabilities,
    };
  };

  // The candidate budget keeps a reply small, but names are page data too.
  // Past the ceiling the claims go first, then the outermost records, until it fits.
  let contribution = build();
  if (fits(contribution)) return contribution;
  omitted += candidates.length;
  candidates = [];
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
    if (typeof record.ownerId === "string" && !ids.has(record.ownerId)) delete record.ownerId;
  }
  return kept;
}

/**
 * The instance named `componentId` among those `element` renders inside,
 * found by the walk a selection's render chain takes. An owner outside that
 * chain has no roots around the element to widen to.
 */
function enclosingInstance(
  element: Element,
  componentId: string,
  ids: InstanceIds
): VueInstance | null {
  const found = lookUp(element);
  if (found === null || found.kind !== "instance") return null;
  const block = found.own
    ? null
    : staticBlockOf(found.instance, element, new Budget(STEPS.staticSearch));
  const ancestry = new Budget(STEPS.ancestry);
  for (
    let current: VueInstance | null | undefined = block?.instance ?? found.instance;
    current !== null && current !== undefined;
    current = parentOf(current)
  ) {
    if (ids.idOf(current) === componentId) return current;
    if (!ancestry.spend()) return null;
  }
  return null;
}

export function createVueExtractor(): ElementPickerExtractor {
  // Per install, so ids last as long as the bootstrap that shows them.
  const ids = new InstanceIds("vue-");
  return {
    extract(element, phase, refs) {
      const found = lookUp(element);
      if (found === null) return null;
      if (found.kind === "app") return withoutInstance(found, phase);
      return phase === "hover"
        ? hoverOf(found.instance, ids)
        : selectionOf(element, found, ids, refs);
    },
    locate(query, anchor) {
      if (anchor === null || field(query, "kind") !== "roots") return null;
      const componentId = field(query, "componentId");
      if (typeof componentId !== "string") return null;
      const instance = enclosingInstance(anchor, componentId, ids);
      if (instance === null) return null;
      const roots = renderedRoots(instance, LIMITS.roots, new Budget(STEPS.rootsPerRecord));
      return { elements: roots.elements, data: { complete: roots.complete } };
    },
  };
}
