/// <reference lib="dom" />
/**
 * What an Angular dev build says about a picked element: the components whose
 * host elements enclose it, which component's template declared each one and
 * the element itself, the file each class was compiled from, and the template
 * positions the compiler stamped when the app opted into them. Everything is
 * read through Angular's published debug API (`angularRuntime.ts`); its
 * lookups cache on the nodes they visit, as Angular DevTools' do, and nothing
 * else in the page is written to.
 *
 * Hover pays for one walk up to the nearest component host and its name, and
 * for a node Angular did not key, one question of whether a template holds it;
 * the owners, roots, class debug info and template stamps are read on selection.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { FrameworkEvidence } from "../../../../../shared/elementPicker/evidence.js";
import type { Capabilities, Capability } from "../../../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import type { ElementPickerExtractor, ElementRefs } from "../registry.js";
import type { ExtractorContribution } from "../types.js";
import {
  DEBUG_INFO_FIELD,
  InstanceIds,
  SOURCE_LOCATION_ATTRIBUTE,
  Steps,
  classDeclaration,
  debugApi,
  hostedOn,
  isAngularNode,
  isDocumentElement,
  isKeyed,
  isProductionBuild,
  observedName,
  parentOf,
  templateLocation,
  type DebugApi,
  type TemplateLocation,
} from "./angularRuntime.js";

/** Restated from `COMPONENT_LIMITS` and `EVIDENCE_LIMITS`: a value import would bundle zod into the page. */
const LIMITS = { records: 64, evidenceEntries: 8, evidenceFields: 16 } as const;

/** Elements walked up from the picked one, and owners asked after. A hover stops at the first host. */
const STEPS = { hover: 256, ancestry: 4_096, owners: 256 } as const;

/** The same share of the bridge's ceiling React's frames get, the innermost claims first. */
const MAX_CANDIDATE_CHARS = 32 * 1024;
const CANDIDATE_OVERHEAD_CHARS = 256;
/** UTF-8 bytes, which bound the bridge's code units and the host's envelope bytes alike. */
const MAX_REPLY_BYTES = 96 * 1024;

/** Each class-line entry opens with the field the lines were read from and their base. */
const LINES_PER_ENTRY = LIMITS.evidenceFields - 2;

const AVAILABLE: Capability = { state: "available" };
const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };
const PRODUCTION: Capability = { state: "unavailable", reason: "production-build" };

function recordFor(instance: object, id: string): ComponentRecord {
  return {
    componentId: id,
    framework: "angular",
    name: observedName(instance),
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [],
  };
}

class CandidateWriter {
  private next = 0;
  private chars = 0;
  /** Claims read but not sent, past the reply's share. */
  omitted = 0;
  /** Of those, the ones that named a line. */
  omittedLines = 0;
  /** The line `debugInfo` gave each file hint, by candidate id. */
  readonly classLines = new Map<string, number>();

  private admit(file: string, hasLine: boolean): string | null {
    const size = file.length + CANDIDATE_OVERHEAD_CHARS;
    if (this.chars + size > MAX_CANDIDATE_CHARS) {
      this.omitted += 1;
      if (hasLine) this.omittedLines += 1;
      return null;
    }
    this.chars += size;
    this.next += 1;
    return `angular-claim-${this.next}`;
  }

  template(
    location: TemplateLocation,
    kind: "template-location" | "component-invocation"
  ): SourceCandidate | null {
    const candidateId = this.admit(location.file, true);
    if (candidateId === null) return null;
    return {
      kind,
      candidateId,
      framework: "angular",
      extraction: { kind: "attribute", attribute: SOURCE_LOCATION_ATTRIBUTE },
      file: location.file,
      location: {
        lineBase: 0,
        columnBase: 0,
        columnUnit: "utf16",
        line: location.line,
        column: location.column,
      },
    };
  }

  /**
   * The class's file, as a hint: the compiler names a line but no column, and
   * a position needs one. The line travels beside it in the evidence, where
   * nothing can present it as a place in the file.
   */
  definition(declaration: { file: string; line: number | null }): SourceCandidate | null {
    const candidateId = this.admit(declaration.file, declaration.line !== null);
    if (candidateId === null) return null;
    if (declaration.line !== null) this.classLines.set(candidateId, declaration.line);
    return {
      kind: "file-hint",
      candidateId,
      framework: "angular",
      extraction: { kind: "runtime-field", field: `${DEBUG_INFO_FIELD}.filePath` },
      file: declaration.file,
    };
  }
}

/** Angular rendered the element, or something inside its view, but left nothing to read it with. */
function unreadable(reason: Capability): ExtractorContribution {
  return {
    // With no API to tell its own nodes from a library's, any other reader knows better.
    ownership: "fallback",
    componentChain: { nearestId: null, components: [], truncated: false },
    frameworkEvidence: [
      { kind: "generic", framework: "angular", fields: [{ name: "debugApi", value: false }] },
    ],
    capabilities: {
      names: reason,
      chain: reason,
      componentSelection: reason,
      file: reason,
      line: reason,
      exactRange: reason,
    },
  };
}

/**
 * Whether Angular rendered the element itself, rather than holding a node some
 * library put inside one of its views: keyed, or found in a template. A node
 * neither is still inside Angular's components, and is described as such only
 * for want of a reader that knows it, such as a React tree mounted there.
 */
function renderedByAngular(element: Element, api: DebugApi): boolean {
  if (isKeyed(element)) return true;
  const owner = api.ownerOf(element);
  return owner !== null && owner !== undefined;
}

function hoverOf(element: Element, api: DebugApi, ids: InstanceIds): ExtractorContribution {
  const steps = new Steps(STEPS.hover);
  let nearest: object | null = null;
  for (let node: Element | null = element; node !== null && steps.spend(); node = parentOf(node)) {
    const instance = hostedOn(node, api);
    // A host Angular would not answer for ends the label rather than skipping to the next one.
    if (instance === undefined) break;
    if (instance !== null) {
      nearest = instance;
      break;
    }
  }
  const capabilities: Capabilities = {
    names: nearest === null ? UNKNOWN : AVAILABLE,
    chain: UNKNOWN,
    componentSelection: UNKNOWN,
    file: UNKNOWN,
    line: UNKNOWN,
    exactRange: UNKNOWN,
  };
  const ownership = renderedByAngular(element, api) ? {} : { ownership: "fallback" as const };
  if (nearest === null) {
    return {
      ...ownership,
      componentChain: { nearestId: null, components: [], truncated: true },
      capabilities,
    };
  }
  const record = recordFor(nearest, ids.idOf(nearest));
  // One record by design: the rest of the chain is a selection's to read.
  return {
    ...ownership,
    componentChain: { nearestId: record.componentId, components: [record], truncated: true },
    capabilities,
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

/**
 * The class lines for the file hints still in the reply, keyed by candidate
 * id, in as many generic entries as they need: each says which field it was
 * read from and its line base before the lines themselves.
 */
function classLineEvidence(
  lines: ReadonlyMap<string, number>,
  kept: readonly ComponentRecord[],
  room: number
): FrameworkEvidence[] {
  const fields = kept
    .flatMap((record) => record.sourceCandidates)
    .filter((candidate) => lines.has(candidate.candidateId))
    .map((candidate) => ({
      name: candidate.candidateId,
      value: lines.get(candidate.candidateId)!,
    }));
  const entries: FrameworkEvidence[] = [];
  for (let at = 0; at < fields.length && entries.length < room; at += LINES_PER_ENTRY) {
    entries.push({
      kind: "generic",
      framework: "angular",
      fields: [
        { name: "field", value: `${DEBUG_INFO_FIELD}.lineNumber` },
        { name: "lineBase", value: 1 },
        ...fields.slice(at, at + LINES_PER_ENTRY),
      ],
    });
  }
  return entries;
}

function selectionOf(
  element: Element,
  api: DebugApi,
  ids: InstanceIds,
  refs: ElementRefs
): ExtractorContribution {
  const records: ComponentRecord[] = [];
  const instances: object[] = [];
  /** The host each record was found on; owners outside the chain have theirs looked up. */
  const hosts: Array<Element | null> = [];
  const indexById = new Map<string, number>();
  let truncated = false;

  const add = (instance: object, host: Element | null): number | null => {
    const id = ids.idOf(instance);
    const known = indexById.get(id);
    if (known !== undefined) return known;
    if (records.length >= LIMITS.records) return null;
    indexById.set(id, records.length);
    records.push(recordFor(instance, id));
    instances.push(instance);
    hosts.push(host);
    return records.length - 1;
  };

  // Host ancestry, innermost first: the component hosts the element sits
  // inside in the DOM, a host it was projected into among them. Each record's
  // render parent is the next; a host Angular would not answer for is a gap
  // no edge is drawn across.
  const ancestry = new Steps(STEPS.ancestry);
  let reachedTop = false;
  let lookup: "host" | "ancestor" | "none" = "none";
  for (let node: Element = element; ;) {
    if (!ancestry.spend()) {
      truncated = true;
      break;
    }
    const instance = hostedOn(node, api);
    if (instance === undefined) {
      truncated = true;
      break;
    }
    if (instance !== null) {
      if (lookup === "none") lookup = node === element ? "host" : "ancestor";
      // Two hosts naming one instance is a page that lies, not an ancestor.
      if (indexById.has(ids.idOf(instance)) || add(instance, node) === null) {
        truncated = true;
        break;
      }
    }
    const parent = parentOf(node);
    if (parent === null) {
      // A detached subtree ends without reaching the document, so its top has no observed parent.
      reachedTop = isDocumentElement(node);
      break;
    }
    node = parent;
  }
  const rendered = records.length;
  for (let index = 0; index < rendered; index += 1) {
    if (index + 1 < rendered) records[index]!.renderParentId = records[index + 1]!.componentId;
    else if (reachedTop) records[index]!.renderParentId = null;
  }

  // Owners: the component whose template declared each one. Content projected
  // into another component is still its declarer's, and a host moved out of
  // its declarer's subtree is too, so an owner can sit outside the chain.
  let templateOwnerId: string | null = null;
  if (api.owners) {
    // The template the element itself is written in, read first so its own
    // owners are walked like any other record's. Kept apart from the chain:
    // for projected content it is not the component it renders inside.
    const elementOwner = api.ownerOf(element);
    if (elementOwner !== undefined && elementOwner !== null) {
      const ownerIndex = add(elementOwner, null);
      if (ownerIndex === null) truncated = true;
      else templateOwnerId = records[ownerIndex]!.componentId;
    }
    const owners = new Steps(STEPS.owners);
    for (let index = 0; index < records.length; index += 1) {
      if (!owners.spend()) {
        truncated = true;
        break;
      }
      const owner = api.ownerOf(instances[index]!);
      if (owner === undefined) continue;
      if (owner === null) {
        records[index]!.ownerId = null;
        continue;
      }
      const ownerIndex = add(owner, null);
      if (ownerIndex === null) {
        truncated = true;
        continue;
      }
      if (ownerIndex !== index) records[index]!.ownerId = records[ownerIndex]!.componentId;
    }
    if (cutOwnerCycles(records)) truncated = true;
  }

  // A component's rendered root is its host element.
  records.forEach((record, index) => {
    const host = hosts[index] ?? api.hostOf(instances[index]!) ?? null;
    hosts[index] = host;
    const token = host === null ? null : refs.ref(host);
    if (token !== null) record.rootElementIds.push(token);
    record.rootsComplete = token !== null;
  });

  const writer = new CandidateWriter();
  const ownLocation = templateLocation(element);
  const elementCandidates: SourceCandidate[] = [];
  if (ownLocation !== null) {
    const candidate = writer.template(ownLocation, "template-location");
    if (candidate !== null) elementCandidates.push(candidate);
  }
  records.forEach((record, index) => {
    // The host's own stamp is where its declaring template writes this component.
    const host = hosts[index];
    const invocation = host === null || host === undefined ? null : templateLocation(host);
    if (invocation !== null) {
      const candidate = writer.template(invocation, "component-invocation");
      if (candidate !== null) record.sourceCandidates.push(candidate);
    }
    const declaration = classDeclaration(instances[index]!);
    if (declaration !== null) {
      const candidate = writer.definition(declaration);
      if (candidate !== null) record.sourceCandidates.push(candidate);
    }
  });

  // The element's own stamp is Angular's word on it; a node in no template is anyone's.
  const ownership =
    ownLocation !== null
      ? { ownership: "direct" as const }
      : lookup === "host" || isKeyed(element) || templateOwnerId !== null
        ? {}
        : { ownership: "fallback" as const };

  let kept = records;
  let sourceCandidates = elementCandidates;
  let omitted = writer.omitted;
  let omittedLines = writer.omittedLines;
  const build = (): ExtractorContribution => {
    const componentChain: ComponentChain = {
      nearestId: rendered > 0 ? kept[0]!.componentId : null,
      components: kept,
      truncated,
    };
    const claims = [...sourceCandidates, ...kept.flatMap((record) => record.sourceCandidates)];
    const lines = classLineEvidence(writer.classLines, kept, LIMITS.evidenceEntries - 1);
    const owner =
      templateOwnerId !== null && kept.some((record) => record.componentId === templateOwnerId)
        ? templateOwnerId
        : null;
    // A claim held back for size is still one the runtime made.
    const hasFile = omitted > 0 || claims.length > 0;
    const hasLine =
      omittedLines > 0 || lines.length > 0 || claims.some((claim) => claim.kind !== "file-hint");
    return {
      ...ownership,
      componentChain,
      sourceCandidates,
      // What the reading rests on, for a reader deciding how far to trust it.
      frameworkEvidence: [
        {
          kind: "generic",
          framework: "angular",
          fields: [
            { name: "debugApi", value: true },
            { name: "owningComponentApi", value: api.owners },
            { name: "hostElementApi", value: api.hosts },
            { name: "componentLookup", value: lookup },
            { name: "templateOwnerId", value: owner },
            { name: "templateOffset", value: ownLocation === null ? null : ownLocation.offset },
            { name: "claimsOmitted", value: omitted },
          ],
        },
        ...lines,
      ],
      capabilities: {
        names: kept.some((record) => record.name !== null) ? AVAILABLE : NOT_EXPOSED,
        chain: kept.length > 0 ? AVAILABLE : NOT_EXPOSED,
        componentSelection: kept.some((record) => record.rootElementIds.length > 0)
          ? AVAILABLE
          : NOT_EXPOSED,
        // Every claim is a project-relative path the host has yet to place.
        file: hasFile ? UNKNOWN : NOT_EXPOSED,
        line: hasLine ? UNKNOWN : NOT_EXPOSED,
        // A stamp is where an element starts, and a class line no range at all.
        exactRange: NOT_EXPOSED,
      },
    };
  };

  // Past the ceiling the claims go first, then the outermost records, until it fits.
  let contribution = build();
  if (fits(contribution)) return contribution;
  for (const claim of [...sourceCandidates, ...kept.flatMap((record) => record.sourceCandidates)]) {
    omitted += 1;
    if (claim.kind !== "file-hint" || writer.classLines.has(claim.candidateId)) omittedLines += 1;
  }
  sourceCandidates = [];
  for (const record of kept) record.sourceCandidates = [];
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

export function createAngularExtractor(): ElementPickerExtractor {
  // Per install, so ids last as long as the bootstrap that shows them.
  const ids = new InstanceIds();
  return {
    extract(element, phase, refs) {
      // Null is a look that found no Angular above the element; a look cut short throws.
      if (!isAngularNode(element)) return null;
      // Read per request: an app publishes it as it bootstraps, which can follow the install.
      const api = debugApi();
      if (api === null) return unreadable(isProductionBuild() ? PRODUCTION : NOT_EXPOSED);
      return phase === "hover" ? hoverOf(element, api, ids) : selectionOf(element, api, ids, refs);
    },
  };
}
