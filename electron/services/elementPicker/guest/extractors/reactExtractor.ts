/// <reference lib="dom" />
/**
 * What a stock React 19 dev build says about a picked element, read from its
 * fibers: the components above it by render parent and by owner, each one's
 * rendered DOM roots, and the creation frames React captured, raw, for the
 * host to map. No hook is installed and nothing in the page is written to.
 *
 * Each component record carries two kinds of frame, which are different
 * claims: `component-invocation`, from the component's own element, where it
 * was called; and one `component-definition`, from an element the component
 * itself created, whose last frame above React's render entry is the function
 * React ran as the component, which is where it is written.
 *
 * Server components (#13885) are records too, read from the `_debugInfo` the
 * Flight client left on the fibers below them rather than from a fiber of
 * their own. They render on the server, so no DOM in the page is theirs to
 * list, and their frames are the server's, faked by Flight for the host to map.
 *
 * Hover pays for one walk up to the nearest component and its name; the
 * owners, roots and stacks are read on selection only.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { GenericEvidence } from "../../../../../shared/elementPicker/evidence.js";
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
  parentOf,
  tagOf,
  canonicalFiber,
  readOwnedElement,
  receivedStacks,
  renderFunction,
  type Fiber,
} from "./reactFiber.js";
import {
  ServerIds,
  isServerInfo,
  serverEntries,
  serverEnvironment,
  serverName,
  type ServerInfo,
} from "./reactServer.js";
import { componentFrame, creationFrames, type CreationFrame } from "./reactStack.js";

/**
 * Restated from `COMPONENT_LIMITS`: a value import would bundle zod into the
 * page. A record's four candidates are its invocation frames and its one
 * definition frame.
 */
const LIMITS = { records: 64, roots: 32, candidates: 4, invocations: 3 } as const;

const STEPS = {
  hover: 2_048,
  ancestry: 4_096,
  commit: 8_192,
  roots: 32_768,
  /** One component's share of `roots`, so an app-sized outer component cannot starve the rest. */
  rootsPerRecord: 4_096,
  /** Looking for an element a component made itself, which is almost always its first child. */
  definitions: 8_192,
  definitionsPerRecord: 512,
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
/**
 * A server record's field path grows by one `.owner` per hop it was reached
 * through; past this it could not be named within the extraction's own bound
 * once a field is appended, so the walk stops there instead.
 */
const MAX_PATH_CHARS = 96;

const AVAILABLE: Capability = { state: "available" };
const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };
const PRODUCTION: Capability = { state: "unavailable", reason: "production-build" };

/** A release as Next.js numbers them; anything else the page put there is not reported. */
const NEXT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,64})?$/;

/** What a record was read from: a client component's fiber, or a server component's info. */
type Origin =
  | { kind: "client"; fiber: Fiber }
  /** `path` is the field the info was read at, relative to the fiber the walk found it on. */
  | { kind: "server"; info: ServerInfo; path: string };

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

/**
 * A server component leaves no instance in the page, so its roots are never
 * listed: the DOM below it belongs to the fibers its output made, and saying
 * which of those are its own would be a reconstruction, not an observation.
 */
function serverRecordFor(info: ServerInfo, id: string, path: string): ComponentRecord {
  const name = serverName(info);
  return {
    componentId: id,
    framework: "react",
    name:
      name === null
        ? null
        : { value: name, extraction: { kind: "runtime-field", field: `${path}.name` } },
    environment: serverEnvironment(info),
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [],
  };
}

/**
 * The half of `fiber`'s pair whose `_debugInfo` the last commit wrote. React
 * sets it on the half a render works on, so where the halves disagree the one
 * a DOM node or a return pointer names may hold an earlier render's list.
 * `committedFiber` keeps the half it is given when it cannot tell, so only an
 * answer naming the other half is one; asked from both sides and told
 * nothing, which list is current is unknown, and that is null.
 */
function debugInfoHolder(fiber: Fiber, budget: Budget): Fiber | null {
  const alternate = field(fiber, "alternate");
  if (!isFiber(alternate) || field(alternate, "_debugInfo") === field(fiber, "_debugInfo")) {
    return fiber;
  }
  if (committedFiber(fiber, budget) === alternate) return alternate;
  if (committedFiber(alternate, budget) === fiber) return fiber;
  return null;
}

function ownerPath(path: string): string | null {
  const next = `${path}.owner`;
  return next.length <= MAX_PATH_CHARS ? next : null;
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
 * Whether a frame V8 named `frameName` could be a call of `render`: by its
 * name, a class's method, or anonymous. A consistency check, not identity:
 * two functions can share a name, which is why clones are told apart by
 * their stacks first.
 */
function ranAs(frameName: string | null, render: unknown): boolean {
  const raw = field(render, "name");
  if (typeof raw !== "string") return false;
  // V8 prints a bound function's frame under the target's own name.
  const name = raw.replace(/^(?:bound )+/, "");
  if (name === "") return frameName === null;
  return frameName === name || (frameName?.startsWith(`${name}.`) ?? false);
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
    return this.writeStack(field(fiber, "_debugStack"), "_debugStack", kind, limit);
  }

  writeStack(
    stack: unknown,
    path: string,
    kind: "element-creation" | "component-invocation",
    limit: number
  ): SourceCandidate[] {
    const out: SourceCandidate[] = [];
    const { frames, omitted } = creationFrames(stack, limit);
    this.omitted += omitted;
    for (const frame of frames) {
      const candidate = this.candidate(kind, frame, path);
      if (candidate !== null) out.push(candidate);
    }
    return out;
  }

  /**
   * Where `component` is written, from an element its own render made, and
   * nothing when it made none. React makes an element whose ref another
   * component overrides with `cloneElement` that component's own while
   * keeping the stack it was first made with, so an element that is a copy of
   * one it was handed is passed over, and a frame counts only when V8 named
   * it for the function React renders the component with.
   */
  writeDefinition(component: Fiber, budget: Budget): SourceCandidate[] {
    const received = receivedStacks(component);
    const render = renderFunction(component);
    const frame = readOwnedElement(component, budget, (fiber) => {
      const stack = field(fiber, "_debugStack");
      if (received.has(stack)) return null;
      const found = componentFrame(stack);
      return found !== null && ranAs(found.name, render) ? found : null;
    });
    const candidate =
      frame === null ? null : this.candidate("component-definition", frame, "_debugStack");
    return candidate === null ? [] : [candidate];
  }

  /**
   * Where a server component is written: the location Flight gives an info,
   * a child's creation stack whose last frame is the component's own function,
   * which React's component stacks cite it by. Counted only when the frame
   * runs under the component's name, as React itself checks.
   */
  writeServerDefinition(info: ServerInfo, path: string): SourceCandidate[] {
    const name = serverName(info);
    const frame = componentFrame(field(info, "debugLocation"));
    if (frame === null || name === null) return [];
    // V8 prints a method called by another name as `Object.Page [as default]`.
    const ran = frame.name?.replace(/ \[as [^\]]*\]$/, "") ?? null;
    if (ran !== name && !(ran?.endsWith(`.${name}`) ?? false)) return [];
    const candidate = this.candidate("component-definition", frame, `${path}.debugLocation`);
    return candidate === null ? [] : [candidate];
  }

  private candidate(
    kind: "element-creation" | "component-invocation" | "component-definition",
    frame: CreationFrame,
    path: string
  ): SourceCandidate | null {
    const size = frame.file.length + CANDIDATE_OVERHEAD_CHARS;
    if (this.chars + size > MAX_CANDIDATE_CHARS) {
      this.omitted += 1;
      return null;
    }
    this.chars += size;
    this.next += 1;
    return {
      kind,
      candidateId: `react-frame-${this.next}`,
      framework: "react",
      extraction: { kind: "generated-stack-frame", field: path, frameIndex: frame.index },
      file: frame.file,
      location: {
        lineBase: 1,
        columnBase: 1,
        columnUnit: "utf16",
        line: frame.line,
        column: frame.column,
      },
    };
  }
}

/**
 * What a Next.js page says of itself: the version on `window.next`, and
 * which router's globals it set. Page data like any other, so only a value
 * shaped like a release is passed on, and the router only by a fixed name.
 */
function nextFields(): GenericEvidence["fields"] {
  const scope: unknown = globalThis;
  const fields: GenericEvidence["fields"] = [];
  const version = field(field(scope, "next"), "version");
  if (typeof version === "string" && NEXT_VERSION.test(version)) {
    fields.push({ name: "nextVersion", value: version });
  }
  let router: string | null = null;
  try {
    if (Array.isArray(field(scope, "__next_f"))) router = "app";
    else if (isNextData(field(scope, "__NEXT_DATA__"))) router = "pages";
  } catch {
    // A revoked proxy throws on `Array.isArray`; that is no router either way.
  }
  if (router !== null) fields.push({ name: "nextRouter", value: router });
  return fields;
}

/**
 * The Pages Router's data object, which always names its build. An element
 * with that id reaches the window by name too, and is not it.
 */
function isNextData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (typeof Node !== "undefined" && value instanceof Node) return false;
  } catch {
    return false;
  }
  return typeof field(value, "buildId") === "string";
}

/**
 * The innermost component above `host`, client or server, in the order a
 * selection's chain reads them: a fiber's own record is inside the server
 * components its `_debugInfo` lists, and those are inside its parent. The
 * memo stands for its implementation.
 */
function nearestOf(host: Fiber, budget: Budget): Origin | null {
  for (let at: Fiber | null = host; at !== null && budget.spend(); at = parentOf(at)) {
    if (at !== host) {
      if (tagOf(at) === FIBER_TAGS.hostRoot) return null;
      if (isComponentFiber(at)) return { kind: "client", fiber: canonicalFiber(at) };
    }
    const holder = debugInfoHolder(at, budget);
    // A list that may be an earlier render's names nothing, and hides what is further out.
    if (holder === null) return null;
    const { entries, cut } = serverEntries(holder);
    const innermost = entries.at(-1);
    if (innermost !== undefined) {
      return { kind: "server", info: innermost.info, path: `_debugInfo[${innermost.index}]` };
    }
    // What the read left out may be nearer than anything further out.
    if (cut) return null;
  }
  return null;
}

function hoverOf(host: Fiber, ids: FiberIds, serverIds: ServerIds): ExtractorContribution {
  const nearest = nearestOf(host, new Budget(STEPS.hover));
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
  const record =
    nearest.kind === "client"
      ? recordFor(nearest.fiber, ids.idOf(nearest.fiber))
      : serverRecordFor(nearest.info, serverIds.idOf(nearest.info), nearest.path);
  // One record by design: the rest of the chain is a selection's to read.
  return {
    componentChain: { nearestId: record.componentId, components: [record], truncated: true },
    capabilities,
  };
}

function selectionOf(
  host: { fiber: Fiber; own: boolean },
  ids: FiberIds,
  serverIds: ServerIds,
  refs: ElementRefs
): ExtractorContribution {
  const development = isDevelopmentFiber(host.fiber);
  const records: ComponentRecord[] = [];
  /** What each record was read from, by index; a client record's fiber is its committed half. */
  const origins: Origin[] = [];
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
    origins.push({ kind: "client", fiber: committedFiber(canonical, commitBudget) });
    return records.length - 1;
  };

  const addServer = (info: ServerInfo, path: string): number | null => {
    const id = serverIds.idOf(info);
    const known = indexById.get(id);
    if (known !== undefined) return known;
    if (records.length >= LIMITS.records) return null;
    indexById.set(id, records.length);
    records.push(serverRecordFor(info, id, path));
    origins.push({ kind: "server", info, path });
    return records.length - 1;
  };

  /**
   * The server components between `fiber` and its parent, innermost first,
   * so each is the render parent of the record before it. False when the
   * walk has to stop.
   */
  const climb = (fiber: Fiber): boolean => {
    const holder = debugInfoHolder(fiber, commitBudget);
    if (holder === null) {
      truncated = true;
      return false;
    }
    const { entries, cut } = serverEntries(holder);
    for (let at = entries.length - 1; at >= 0; at -= 1) {
      const { info, index } = entries[at]!;
      // One already in the chain would make the render edges loop.
      if (indexById.has(serverIds.idOf(info)) || addServer(info, `_debugInfo[${index}]`) === null) {
        truncated = true;
        return false;
      }
    }
    // The entries left out may hold a server component, so nothing further
    // out can be named this one's render parent.
    if (cut) truncated = true;
    return !cut;
  };

  // Render ancestry, innermost first. Each record's render parent is the next.
  const ancestry = new Budget(STEPS.ancestry);
  let reachedRoot = false;
  if (climb(host.fiber)) {
    for (let next = parentOf(host.fiber); next !== null; next = parentOf(next)) {
      if (!ancestry.spend()) {
        truncated = true;
        break;
      }
      if (tagOf(next) === FIBER_TAGS.hostRoot) {
        reachedRoot = true;
        break;
      }
      if (isComponentFiber(next) && !isMemoImplementation(next)) {
        // A return pointer back into the chain is a loop, not an ancestor.
        if (indexById.has(ids.idOf(next)) || add(next) === null) {
          truncated = true;
          break;
        }
      }
      // Server components can sit above any fiber, a fragment or a boundary included.
      if (!climb(next)) break;
    }
  }
  const rendered = records.length;
  for (let index = 0; index < rendered; index += 1) {
    if (index + 1 < rendered) records[index]!.renderParentId = records[index + 1]!.componentId;
    else if (reachedRoot) records[index]!.renderParentId = null;
  }

  // Owners. One outside the render chain — an element made in one component
  // and rendered by another, through context or a store, or a server
  // component that rendered nothing between — gets a record of its own, with
  // the render parent nobody walked left out. A fiber made from an element
  // the server created is owned by that server component's info.
  if (development) {
    for (let index = 0; index < records.length; index += 1) {
      const origin = origins[index]!;
      const owner =
        origin.kind === "client" ? field(origin.fiber, "_debugOwner") : field(origin.info, "owner");
      if (owner === null) {
        records[index]!.ownerId = null;
        continue;
      }
      let ownerIndex: number | null;
      if (isFiber(owner)) {
        if (!isComponentFiber(owner)) continue;
        ownerIndex = add(owner);
      } else if (isServerInfo(owner)) {
        const path = origin.kind === "client" ? "_debugOwner" : ownerPath(origin.path);
        ownerIndex = path === null ? null : addServer(owner, path);
      } else {
        continue;
      }
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
    const origin = origins[index]!;
    if (origin.kind === "server") return;
    const roots = hostRoots(
      origin.fiber,
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
    const definitionBudget = new Budget(STEPS.definitions);
    records.forEach((record, index) => {
      const origin = origins[index]!;
      record.sourceCandidates =
        origin.kind === "client"
          ? [
              ...writer.write(origin.fiber, "component-invocation", LIMITS.invocations),
              ...writer.writeDefinition(
                origin.fiber,
                new Budget(STEPS.definitionsPerRecord, definitionBudget)
              ),
            ]
          : [
              ...writer.writeStack(
                field(origin.info, "debugStack"),
                `${origin.path}.debugStack`,
                "component-invocation",
                LIMITS.invocations
              ),
              ...writer.writeServerDefinition(origin.info, origin.path),
            ];
    });
  }

  const next = nextFields();
  let kept = records;
  let elementCandidates = sourceCandidates;
  let omitted = writer.omitted;
  const build = (): ExtractorContribution => {
    const componentChain: ComponentChain = {
      nearestId: rendered > 0 ? kept[0]!.componentId : null,
      components: kept,
      truncated,
    };
    // Frames read but held back for size are still frames the runtime exposed.
    const hasFrames =
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
          framework: "react",
          fields: [
            { name: "fiberLookup", value: host.own ? "element" : "ancestor" },
            { name: "debugFields", value: development },
            { name: "framesOmitted", value: omitted },
            ...next,
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
  const serverIds = new ServerIds("react-server-");
  return {
    extract(element, phase, refs) {
      const host = hostFiberOf(element);
      if (host === null) return null;
      return phase === "hover"
        ? hoverOf(host.fiber, ids, serverIds)
        : selectionOf(host, ids, serverIds, refs);
    },
  };
}
