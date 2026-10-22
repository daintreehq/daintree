/// <reference lib="dom" />
/**
 * Svelte's extractor: reads the dev runtime's `__svelte_meta` stamps in the
 * page's main world and reports them in the picker's neutral terms. What it
 * reports is what the stamp says — a template location, the invocations and
 * blocks above it — attributed to the field it was read from; whether that
 * location is the right line of the right file is the host resolver's call.
 *
 * Hover reads only the node's own stamp and its frame chain. The document
 * sweeps (how many elements share a location, what the page's metadata
 * supports) and the structural walk run for a selection, and the sweeps are
 * cached until the document's structure changes.
 */

import type {
  ComponentChain,
  ComponentRecord,
} from "../../../../../shared/elementPicker/component.js";
import type { SvelteEvidence } from "../../../../../shared/elementPicker/evidence.js";
import type { Capabilities, Capability } from "../../../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import type { ExtractionPhase, ExtractorNotice } from "../../guestChannel.js";
import type { ElementPickerExtractor } from "../registry.js";
import type { ExtractorContribution } from "../types.js";
import { createMetadataAudit, type MetadataProbe } from "./audit.js";
import {
  SVELTE_LIMITS,
  componentFrames,
  field,
  invocationsOf,
  locKey,
  nearestMapped,
  parentOf,
  readAncestry,
  readFrame,
  readLoc,
  readMeta,
  sameLoc,
  type SvelteLoc,
} from "./meta.js";
import { structureOf, type SvelteStructure } from "./structure.js";

/** Restated from `COMPONENT_LIMITS`: a value import would bundle zod into the page. */
const MAX_COMPONENTS = 64;
/** Restated from `COMPONENT_LIMITS.roots`: the most roots one component selection holds. */
const MAX_ROOTS = 32;
/** Distinct locations the same-location scan caches before it starts over. */
const MAX_LOC_ENTRIES = 1_000;
/**
 * Under the bridge's 128K ceiling with room for the reply around it: a page
 * whose chain fills every frame with a kilobyte path is shortened, not dropped.
 */
const CONTRIBUTION_BUDGET_CHARS = 96 * 1024;
/** What a contribution keeps of its ancestry and chain when it is over budget. */
const SHORTENED_ANCESTRY = 4;
const SHORTENED_CHAIN = 8;

const LOC_FIELD = "__svelte_meta.loc";
const FRAME_FIELD = "__svelte_meta.parent";
const TAG_FIELD = "__svelte_meta.parent.componentTag";
const SVELTE_POSITION = { lineBase: 1, columnBase: 0, columnUnit: "utf16" } as const;

/**
 * What a host asks the page to select again, in Svelte's terms: the template
 * location and which of its live copies, and the invocation a widened
 * selection stood for. The copy is required: repeated markup shares file,
 * tag and revision, so a host that does not know which one it had cannot be
 * given the first in its place.
 */
export interface SvelteLocator {
  loc: SvelteLoc;
  index: number;
  component?: SvelteLoc | null;
}

interface LocScan {
  count: number;
  partial: boolean;
  order: WeakMap<Element, number>;
}

const available: Capability = { state: "available" };
const unknown: Capability = { state: "unknown" };
const unavailable = (reason: "not-exposed" | "unmapped"): Capability => ({
  state: "unavailable",
  reason,
});

function parseLoc(value: unknown): SvelteLoc | null {
  if (value === null || typeof value !== "object") return null;
  const { file, line, column } = value as Record<string, unknown>;
  if (typeof file !== "string" || file.length === 0 || file.length > SVELTE_LIMITS.locFile) {
    return null;
  }
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return null;
  if (typeof column !== "number" || !Number.isSafeInteger(column) || column < 0) return null;
  return { file, line, column };
}

export function parseSvelteLocator(value: unknown): SvelteLocator | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const loc = parseLoc(raw.loc);
  const index = raw.index;
  if (loc === null || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    return null;
  }
  if (raw.component === undefined || raw.component === null) return { loc, index };
  const component = parseLoc(raw.component);
  return component === null ? null : { loc, index, component };
}

function isCrossOriginFrame(node: Element): boolean {
  if (node.tagName !== "IFRAME" && node.tagName !== "FRAME") return false;
  try {
    return (node as HTMLIFrameElement).contentDocument === null;
  } catch {
    return true;
  }
}

/**
 * A closed shadow root retargets the event to its host, so the real hit is
 * unreachable: an upgraded custom element with no open root is visual-only
 * rather than its own markup, which would be a lie about what was picked.
 */
function hidesItsOwnContent(node: Element): boolean {
  if (node.shadowRoot !== null) return false;
  const name = node.tagName.toLowerCase();
  return name.includes("-") && customElements.get(name) !== undefined;
}

/**
 * Rendered, but not by a template Svelte can name. The common case is the
 * last one: the dev build stamps every element it compiled, so an element
 * with no stamp came from `{@html}`, a third-party widget or the page's own
 * scripting.
 */
function isUnmapped(hit: Element, ignoringStamp = false): boolean {
  if (hit.getRootNode() !== hit.ownerDocument) return true;
  if (hit.tagName === "CANVAS" || hit.closest("canvas") !== null) return true;
  if (isCrossOriginFrame(hit)) return true;
  if (hidesItsOwnContent(hit)) return true;
  return !ignoringStamp && readLoc(hit) === null;
}

/** An unstamped node the template's shape can still place, or undefined. */
function placeableOf(node: Element): SvelteStructure | undefined {
  return readLoc(node) === null && !isUnmapped(node, true) ? structureOf(node) : undefined;
}

/** Any stamp at all, readable or not, on the node or within a bounded walk above it. */
function hasStampAbove(node: Element): boolean {
  let current: Element | null = node;
  for (let depth = 0; current !== null && depth < SVELTE_LIMITS.ancestors; depth += 1) {
    if (readMeta(current) !== null) return true;
    current = parentOf(current);
  }
  return false;
}

export function createSvelteExtractor(): ElementPickerExtractor {
  const audit = createMetadataAudit(notice);
  /** Per invocation: Svelte builds one frame object per call site per render. */
  const componentIds = new WeakMap<object, string>();
  const idPrefix = "svelte-" + Math.random().toString(36).slice(2, 8) + "-";
  let nextComponent = 0;
  /**
   * One sweep per location, answering both questions an observation asks of
   * it: how many elements share the location, and which of them a given one
   * is. Separately they cost a full document scan each.
   */
  const locScans = new Map<string, LocScan>();
  let mutations: MutationObserver | null = null;
  let notify: ((notice: ExtractorNotice) => void) | null = null;
  let disposed = false;
  let truncationReported = false;

  function notice(code: ExtractorNotice): void {
    notify?.(code);
  }

  function componentIdOf(frame: object): string {
    let id = componentIds.get(frame);
    if (id === undefined) {
      nextComponent += 1;
      id = idPrefix + nextComponent;
      componentIds.set(frame, id);
    }
    return id;
  }

  function scanLoc(loc: SvelteLoc): LocScan {
    const key = locKey(loc);
    const cached = locScans.get(key);
    if (cached !== undefined) return cached;
    let count = 0;
    const order = new WeakMap<Element, number>();
    const all = document.getElementsByTagName("*");
    // Past the bound the count is a floor and says so: one copy counted is not
    // proof the markup is unique.
    const limit = Math.min(all.length, SVELTE_LIMITS.scan);
    for (let index = 0; index < limit; index += 1) {
      const element = all[index];
      if (element === undefined) continue;
      const other = readLoc(element);
      if (other !== null && sameLoc(other, loc)) {
        order.set(element, count);
        count += 1;
      }
    }
    const result: LocScan = {
      count: Math.min(Math.max(count, 1), SVELTE_LIMITS.occurrences),
      partial: all.length > SVELTE_LIMITS.scan,
      order,
    };
    // A document with an unusual number of distinct locations must not turn the
    // cache into the leak it exists to prevent.
    if (locScans.size >= MAX_LOC_ENTRIES) locScans.clear();
    locScans.set(key, result);
    return result;
  }

  /**
   * The element a pick stands for: itself when stamped, or unstamped but
   * placeable by shape; otherwise the nearest stamped ancestor.
   */
  function targetOf(hit: Element): { target: Element; placeable: SvelteStructure | undefined } {
    const placeable = placeableOf(hit);
    return { target: placeable !== undefined ? hit : (nearestMapped(hit) ?? hit), placeable };
  }

  function componentRecords(target: Element): ComponentChain {
    const components: ComponentRecord[] = [];
    const walk = invocationsOf(target);
    let truncated = walk.truncated;
    for (const frame of walk.frames) {
      // A frame whose tag or call site does not read is a component this page
      // cannot name and place, which a record cannot say: a null name claims
      // anonymity. It stays in the evidence's ancestry.
      const read = readFrame(frame);
      if (read === null || read.componentTag === undefined) continue;
      if (components.length >= MAX_COMPONENTS) {
        truncated = true;
        break;
      }
      const candidate: SourceCandidate = {
        kind: "component-invocation",
        candidateId: "svelte-call-" + components.length,
        framework: "svelte",
        extraction: { kind: "runtime-field", field: FRAME_FIELD },
        file: read.file,
        location: { ...SVELTE_POSITION, line: read.line, column: read.column },
      };
      components.push({
        componentId: componentIdOf(frame),
        framework: "svelte",
        name: { value: read.componentTag, extraction: { kind: "runtime-field", field: TAG_FIELD } },
        // A stamp is written by the client runtime as it renders the instance.
        environment: "client",
        // Render and owner edges are left unobserved: a snippet passed down is
        // rendered by one component and written by another, and the chain
        // alone does not say which a frame is.
        rootElementIds: [],
        rootsComplete: false,
        sourceCandidates: [candidate],
      });
    }
    return { nearestId: components[0]?.componentId ?? null, components, truncated };
  }

  function capabilitiesOf(
    probe: MetadataProbe | null,
    located: { loc: boolean; structure: boolean; unmapped: boolean },
    chain: ComponentChain
  ): Capabilities {
    const unreadable =
      probe !== null && !probe.locations
        ? unavailable("not-exposed")
        : located.unmapped
          ? unavailable("unmapped")
          : unknown;
    // Every record is named and placed, so one is enough for all three.
    const named = chain.components.length > 0 ? available : null;
    const noChain = probe !== null && !probe.ancestry ? unavailable("not-exposed") : unknown;
    return {
      names: named ?? noChain,
      chain: named ?? noChain,
      componentSelection: named ?? noChain,
      file: located.loc || located.structure ? available : unreadable,
      // A shape is placed against the template by the host, which may yet name a line.
      line: located.loc ? available : located.structure ? unknown : unreadable,
      // A stamp is a start position; the host may find the range in the template.
      exactRange: unknown,
    };
  }

  function evidenceOf(
    target: Element,
    hit: Element,
    loc: SvelteLoc | null,
    placeable: SvelteStructure | undefined,
    ancestry: SvelteEvidence["ancestry"]
  ): SvelteEvidence {
    const scan = loc === null ? null : scanLoc(loc);
    const locIndex = scan?.order.get(target);
    const structure = placeable ?? (loc === null ? undefined : structureOf(target));
    return {
      kind: "svelte",
      ancestry,
      sameLocCount: scan?.count ?? 1,
      ...(scan?.partial === true && { sameLocCountPartial: true as const }),
      // Past the sweep the element is not in it: no occurrence is claimed, so
      // nothing can land on the first copy in its place.
      ...(locIndex !== undefined && { locIndex }),
      ...(structure !== undefined && { structure }),
      // An unstamped hit the shape placed is markup, not a visual-only region.
      unmapped: placeable !== undefined ? isUnmapped(hit, true) : isUnmapped(hit),
    };
  }

  /**
   * Keeps the reply under the bridge's ceiling: past it the bootstrap would
   * hear nothing at all, where a shortened chain still traces the selection.
   */
  function withinBudget(contribution: ExtractorContribution): ExtractorContribution {
    if (JSON.stringify(contribution).length <= CONTRIBUTION_BUDGET_CHARS) return contribution;
    const chain = contribution.componentChain;
    const shortened: ExtractorContribution = {
      ...contribution,
      ...(chain !== undefined && {
        componentChain: {
          nearestId: chain.nearestId,
          components: chain.components.slice(0, SHORTENED_CHAIN),
          truncated: chain.truncated || chain.components.length > SHORTENED_CHAIN,
        },
      }),
      frameworkEvidence: contribution.frameworkEvidence?.map((entry) =>
        entry.kind === "svelte"
          ? { ...entry, ancestry: entry.ancestry.slice(0, SHORTENED_ANCESTRY) }
          : entry
      ),
    };
    reportTruncation();
    return JSON.stringify(shortened).length <= CONTRIBUTION_BUDGET_CHARS
      ? shortened
      : { capabilities: contribution.capabilities };
  }

  function reportTruncation(): void {
    if (truncationReported) return;
    truncationReported = true;
    notice("ancestry-truncated");
  }

  function describe(
    target: Element,
    phase: ExtractionPhase,
    hit: Element,
    placeable: SvelteStructure | undefined
  ): ExtractorContribution | null {
    // Nothing of Svelte's here: another framework's island, or the page's own
    // markup. Saying nothing leaves the element to whoever does know it.
    if (!hasStampAbove(target)) return null;
    const loc = readLoc(target);
    const chain = componentRecords(target);
    const sourceCandidates: SourceCandidate[] =
      loc === null
        ? []
        : [
            {
              kind: "template-location",
              candidateId: "svelte-loc",
              framework: "svelte",
              extraction: { kind: "runtime-field", field: LOC_FIELD },
              file: loc.file,
              location: { ...SVELTE_POSITION, line: loc.line, column: loc.column },
            },
          ];
    if (phase === "hover") {
      return withinBudget({
        componentChain: chain,
        sourceCandidates,
        capabilities: capabilitiesOf(
          audit.probed(),
          { loc: loc !== null, structure: false, unmapped: false },
          chain
        ),
      });
    }
    // The frames are the template's, which an unstamped element inherits.
    const ancestry = readAncestry(readMeta(target) ?? readMeta(nearestMapped(target) ?? target));
    if (ancestry.truncated) reportTruncation();
    const evidence = evidenceOf(target, hit, loc, placeable, ancestry.frames);
    return withinBudget({
      componentChain: chain,
      sourceCandidates,
      frameworkEvidence: [evidence],
      capabilities: capabilitiesOf(
        audit.probe(),
        {
          loc: loc !== null,
          structure: evidence.structure !== undefined,
          unmapped: evidence.unmapped,
        },
        chain
      ),
    });
  }

  function frameNamed(anchor: Element, componentId: unknown): object | null {
    if (typeof componentId !== "string") return null;
    return componentFrames(anchor).find((frame) => componentIds.get(frame) === componentId) ?? null;
  }

  /**
   * The outermost connected elements an invocation rendered, from one it
   * rendered. Membership is the stamp's frame, not a readable location: a root
   * whose `loc` is malformed was still rendered by the invocation.
   */
  function componentRoots(frame: object, start: Element): { roots: Element[]; complete: boolean } {
    const belongs = (node: Element): boolean =>
      readMeta(node) !== null && componentFrames(node).includes(frame);
    let root: Element = start;
    let edge = false;
    for (let depth = 0; depth < SVELTE_LIMITS.ancestors; depth += 1) {
      const parent = parentOf(root);
      if (parent === null || !belongs(parent)) {
        edge = true;
        break;
      }
      root = parent;
    }
    // Out of ancestors before the invocation's edge: its siblings there are
    // its interior, not its roots, and nothing is better than them.
    if (!edge) return { roots: [], complete: false };
    // Where the root sits, not the walk's way out: a root directly inside a
    // shadow root has its siblings there, not among its host's light children.
    const container =
      root.parentElement ?? (root.parentNode instanceof ShadowRoot ? root.parentNode : null);
    if (container === null) return { roots: [root], complete: true };
    const roots: Element[] = [];
    for (const child of Array.from(container.children)) {
      if (child !== root && !belongs(child)) continue;
      if (roots.length >= MAX_ROOTS) return { roots, complete: false };
      roots.push(child);
    }
    return { roots: roots.length > 0 ? roots : [root], complete: true };
  }

  /**
   * The element compiled from `loc`, found by the same identity a pick
   * reports — never a cached node, which a hot update has replaced — and
   * bounded like every other sweep.
   */
  function elementAt(loc: SvelteLoc, index: number): Element | null {
    const root = document.body ?? document.documentElement;
    if (root === null) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let seen = 0;
    let scanned = 0;
    for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
      if (scanned++ >= SVELTE_LIMITS.scan) return null;
      if (!(node instanceof Element)) continue;
      const found = readLoc(node);
      if (found === null || !sameLoc(found, loc)) continue;
      if (seen === index) return node;
      seen += 1;
    }
    return null;
  }

  function reselect(
    raw: unknown,
    anchor: Element | null
  ): { elements: Element[]; data?: Record<string, unknown> } | null {
    const locator = parseSvelteLocator(raw);
    if (locator === null) return null;
    // The element the host was told about, while it is still the same node;
    // else the occurrence at the location, as after a hot update.
    const target = anchor ?? elementAt(locator.loc, locator.index);
    if (target === null) return null;
    const wanted = locator.component;
    if (wanted === undefined || wanted === null) return { elements: [target] };
    // A widened selection stays widened, on the invocation that was edited; a
    // call site the element is not inside is not a component to keep.
    const frame = componentFrames(target).find((candidate) => {
      const read = readFrame(candidate);
      return read !== null && read.componentTag !== undefined && sameLoc(read, wanted);
    });
    return frame === undefined
      ? { elements: [target] }
      : { elements: [target], data: { componentId: componentIdOf(frame) } };
  }

  function watchStructure(): void {
    if (mutations !== null || typeof MutationObserver !== "function") return;
    // Only structure changes what a location renders and which copy is which;
    // a class flip moves geometry and nothing else.
    mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) {
        locScans.clear();
        audit.onMutation();
      }
    });
    mutations.observe(document.documentElement ?? document, { childList: true, subtree: true });
  }

  return {
    extract(element, phase) {
      if (disposed) return null;
      return describe(
        element,
        phase,
        element,
        phase === "selection" ? placeableOf(element) : undefined
      );
    },
    pick(hit) {
      if (disposed) return null;
      const { target, placeable } = targetOf(hit);
      return { target, data: describe(target, "selection", hit, placeable) };
    },
    locate(query, anchor) {
      if (disposed || query === null || typeof query !== "object") return null;
      const kind = field(query, "kind");
      if (kind === "roots") {
        if (anchor === null) return null;
        const frame = frameNamed(anchor, field(query, "componentId"));
        if (frame === null) return null;
        const { roots, complete } = componentRoots(frame, anchor);
        return { elements: roots, data: { complete } };
      }
      if (kind === "reselect") {
        // Before reading the page again: a hot update can replace the nodes a
        // cached sweep counted without the observer having said so yet.
        locScans.clear();
        return reselect(field(query, "locator"), anchor);
      }
      return null;
    },
    start(sink) {
      if (disposed) return;
      notify = sink;
      watchStructure();
      audit.start();
    },
    dispose() {
      disposed = true;
      notify = null;
      mutations?.disconnect();
      mutations = null;
      locScans.clear();
      audit.dispose();
    },
  };
}
