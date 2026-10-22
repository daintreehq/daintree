/// <reference lib="dom" />
/**
 * What a stock React 19 dev build says about a picked element, read from its
 * fibers: the components above it by render parent and by owner, each one's
 * rendered DOM roots, and the creation frames React captured, raw, for the
 * host to map. No hook is installed and nothing in the page is written to.
 *
 * Hover pays for one walk up to the nearest component and its name; the
 * owners, roots and stacks are read on selection only.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { Capabilities, Capability } from "../../../../../shared/elementPicker/observation.js";
import type { ObservedName, SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import type { ElementPickerExtractor, ElementRefs } from "../registry.js";
import type { ExtractorContribution } from "../types.js";
import {
  Budget,
  FIBER_TAGS,
  FiberIds,
  committedFiber,
  componentName,
  field,
  hostFiberOf,
  hostRoots,
  isComponentFiber,
  isFiber,
  isMemoImplementation,
  nearestComponent,
  parentOf,
  tagOf,
  canonicalFiber,
  type Fiber,
} from "./reactFiber.js";
import { creationFrames } from "./reactStack.js";

/** Restated from `COMPONENT_LIMITS`: a value import would bundle zod into the page. */
const LIMITS = { records: 64, roots: 32, candidates: 4 } as const;

const STEPS = {
  hover: 2_048,
  ancestry: 4_096,
  commit: 8_192,
  roots: 32_768,
  /** One component's share of `roots`, so an app-sized outer component cannot starve the rest. */
  rootsPerRecord: 4_096,
} as const;

/**
 * Frames are the bulk of a reply, and a reply over the bridge's ceiling is
 * dropped whole, so they stop at a share of it: the innermost component's
 * first. The reply as a whole is checked against the rest.
 */
const MAX_CANDIDATE_CHARS = 32 * 1024;
const CANDIDATE_OVERHEAD_CHARS = 256;
/** UTF-8 bytes, which bound the bridge's code units and the host's envelope bytes alike. */
const MAX_REPLY_BYTES = 96 * 1024;

const AVAILABLE: Capability = { state: "available" };
const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };
const PRODUCTION: Capability = { state: "unavailable", reason: "production-build" };

/** Only a development build gives fibers their `_debug*` fields, null or not. */
function isDevelopmentFiber(fiber: Fiber): boolean {
  try {
    return "_debugStack" in fiber;
  } catch {
    return false;
  }
}

function observedName(fiber: Fiber): ObservedName | null {
  const name = componentName(fiber);
  return name === null
    ? null
    : { value: name.value, extraction: { kind: "runtime-field", field: name.field } };
}

function recordFor(fiber: Fiber, id: string): ComponentRecord {
  return {
    componentId: id,
    framework: "react",
    name: observedName(fiber),
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [],
  };
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
  /** Located frames read but not sent, past a record's limit or the reply's share. */
  omitted = 0;

  write(
    fiber: Fiber,
    kind: "element-creation" | "component-invocation",
    limit: number
  ): SourceCandidate[] {
    const out: SourceCandidate[] = [];
    const { frames, omitted } = creationFrames(field(fiber, "_debugStack"), limit);
    this.omitted += omitted;
    for (const frame of frames) {
      const size = frame.file.length + CANDIDATE_OVERHEAD_CHARS;
      if (this.chars + size > MAX_CANDIDATE_CHARS) {
        this.omitted += 1;
        continue;
      }
      this.chars += size;
      this.next += 1;
      out.push({
        kind,
        candidateId: `react-frame-${this.next}`,
        framework: "react",
        extraction: {
          kind: "generated-stack-frame",
          field: "_debugStack",
          frameIndex: frame.index,
        },
        file: frame.file,
        location: {
          lineBase: 1,
          columnBase: 1,
          columnUnit: "utf16",
          line: frame.line,
          column: frame.column,
        },
      });
    }
    return out;
  }
}

function hoverOf(host: Fiber, ids: FiberIds): ExtractorContribution {
  const nearest = nearestComponent(host, new Budget(STEPS.hover));
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
  host: { fiber: Fiber; own: boolean },
  ids: FiberIds,
  refs: ElementRefs
): ExtractorContribution {
  const development = isDevelopmentFiber(host.fiber);
  const records: ComponentRecord[] = [];
  /** The committed half of each record's fiber, by index. */
  const fibers: Fiber[] = [];
  const indexById = new Map<string, number>();
  const commitBudget = new Budget(STEPS.commit);
  let truncated = false;

  const add = (fiber: Fiber): number | null => {
    const id = ids.idOf(fiber);
    const known = indexById.get(id);
    if (known !== undefined) return known;
    if (records.length >= LIMITS.records) return null;
    const canonical = canonicalFiber(fiber);
    indexById.set(id, records.length);
    records.push(recordFor(canonical, id));
    fibers.push(committedFiber(canonical, commitBudget));
    return records.length - 1;
  };

  // Render ancestry, innermost first. Each record's render parent is the next.
  const ancestry = new Budget(STEPS.ancestry);
  let reachedRoot = false;
  for (let next = parentOf(host.fiber); next !== null; next = parentOf(next)) {
    if (!ancestry.spend()) {
      truncated = true;
      break;
    }
    if (tagOf(next) === FIBER_TAGS.hostRoot) {
      reachedRoot = true;
      break;
    }
    if (!isComponentFiber(next) || isMemoImplementation(next)) continue;
    // A return pointer back into the chain is a loop, not an ancestor.
    if (indexById.has(ids.idOf(next)) || add(next) === null) {
      truncated = true;
      break;
    }
  }
  const rendered = records.length;
  for (let index = 0; index < rendered; index += 1) {
    if (index + 1 < rendered) records[index]!.renderParentId = records[index + 1]!.componentId;
    else if (reachedRoot) records[index]!.renderParentId = null;
  }

  // Owners. One outside the render chain — an element made in one component
  // and rendered by another, through context or a store — gets a record of
  // its own, with the render parent nobody walked left out.
  if (development) {
    for (let index = 0; index < records.length; index += 1) {
      const owner = field(fibers[index], "_debugOwner");
      if (owner === null) {
        records[index]!.ownerId = null;
        continue;
      }
      // A server component's owner is not a fiber; that is #13885's to read.
      if (!isFiber(owner) || !isComponentFiber(owner)) continue;
      const ownerIndex = add(owner);
      if (ownerIndex === null) {
        truncated = true;
        continue;
      }
      if (ownerIndex !== index) records[index]!.ownerId = records[ownerIndex]!.componentId;
    }
    if (cutOwnerCycles(records)) truncated = true;
  }

  const rootBudget = new Budget(STEPS.roots);
  records.forEach((record, index) => {
    const roots = hostRoots(
      fibers[index]!,
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
  const sourceCandidates =
    development && host.own ? writer.write(host.fiber, "element-creation", LIMITS.candidates) : [];
  if (development) {
    records.forEach((record, index) => {
      record.sourceCandidates = writer.write(
        fibers[index]!,
        "component-invocation",
        LIMITS.candidates
      );
    });
  }

  let kept = records;
  let elementCandidates = sourceCandidates;
  let omitted = writer.omitted;
  const build = (): ExtractorContribution => {
    const componentChain: ComponentChain = {
      nearestId: rendered > 0 ? kept[0]!.componentId : null,
      components: kept,
      truncated,
    };
    const hasFrames =
      elementCandidates.length > 0 || kept.some((record) => record.sourceCandidates.length > 0);
    return {
      componentChain,
      sourceCandidates: elementCandidates,
      // What the reading rests on, for a reader deciding how far to trust it.
      frameworkEvidence: [
        {
          kind: "generic",
          framework: "react",
          fields: [
            { name: "fiberLookup", value: host.own ? "element" : "ancestor" },
            { name: "debugFields", value: development },
            { name: "framesOmitted", value: omitted },
          ],
        },
      ],
      capabilities: {
        names: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
        chain: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
        componentSelection: kept.some((record) => record.rootElementIds.length > 0)
          ? AVAILABLE
          : NOT_EXPOSED,
        // A frame is a claim in generated coordinates: the host has yet to map it.
        file: development ? (hasFrames ? UNKNOWN : NOT_EXPOSED) : PRODUCTION,
        line: development ? (hasFrames ? UNKNOWN : NOT_EXPOSED) : PRODUCTION,
        exactRange: development ? NOT_EXPOSED : PRODUCTION,
      },
    };
  };

  // The frame budget keeps a reply small, but names are page data too. Past
  // the ceiling the frames go first, then the outermost records, until it fits.
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
    if (typeof record.ownerId === "string" && !ids.has(record.ownerId)) delete record.ownerId;
  }
  return kept;
}

export function createReactExtractor(): ElementPickerExtractor {
  // Per install, so ids last as long as the bootstrap that shows them.
  const ids = new FiberIds("react-");
  return {
    extract(element, phase, refs) {
      const host = hostFiberOf(element);
      if (host === null) return null;
      return phase === "hover" ? hoverOf(host.fiber, ids) : selectionOf(host, ids, refs);
    },
  };
}
