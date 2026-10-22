/// <reference lib="dom" />
/**
 * The framework-neutral picker the bootstrap runs in every bound document:
 * overlay, hit-testing, keyboard walk, element identity, and the selection-time
 * detectors. It runs in an isolated world, so page script can neither reach its
 * state nor read what it draws; the cost is that it cannot see a framework's
 * expandos, which is what the main-world extractors behind the bridge are for.
 *
 * Hover stays cheap: the pointer only records the latest hit, one animation
 * frame resolves it, and a hover reports only when the hovered element changes.
 */

import type {
  Capability,
  ElementContext,
  FrameworkDetection,
  HoverObservation,
  SelectionObservation,
} from "../../../../shared/elementPicker/observation.js";
import type {
  ElementPickerEvent,
  SelectionScope,
} from "../../../../shared/elementPicker/protocol.js";
import type { ElementPickerFramework } from "../../../../shared/elementPicker/source.js";
import {
  EXTRACTOR_NOTICES,
  MAX_BRIDGE_MESSAGE_CHARS,
  MAX_ELEMENT_REFS,
  MAX_LOCATED_REPLY_CHARS,
  MAX_LOCATE_REQUEST_CHARS,
  channelEvent,
  elementRefToken,
  type ExtractRequest,
  type ExtractionPhase,
  type ExtractorNotice,
  type LocateRequest,
} from "../guestChannel.js";
import { DetectionSet, detectAncestry, parentAcrossShadow } from "./detectors.js";
import { classWordsOf, elementContextOf } from "./elementContext.js";
import type { ExtractorContribution, PickerAvailability, PickerMode } from "./types.js";

/** Restated from the shared schemas: a value import would bundle zod into the page. */
const LIMITS = {
  label: 200,
  tagName: 64,
  bounds: 32,
  url: 2048,
  sourceCandidates: 16,
  frameworkEvidence: 8,
  components: 64,
  roots: 32,
  componentName: 128,
  /** `MAX_ELEMENT_PICKER_MESSAGE_BYTES`, less what the prelude's envelope adds around the event. */
  eventBytes: 256 * 1024 - 1024,
  evidenceFields: 16,
  evidenceFieldName: 64,
  evidenceFieldValue: 256,
  shadowHosts: 32,
} as const;
const MAX_RECT_PX = 2 ** 52;
const FRAMEWORKS: ReadonlySet<string> = new Set([
  "svelte",
  "react",
  "vue",
  "angular",
  "astro",
  "preact",
  "solid",
]);
/** Replies kept per request; the first one whose id matches wins. */
const MAX_REPLIES = 4;
/** Reverse id lookups kept before dead ones are swept and the oldest let go. */
const MAX_HELD_IDS = 2_000;
/** What an over-ceiling selection keeps of each framework's ancestry. */
const SHORTENED_ANCESTRY = 4;
const PROBE_SIZE = 100;
/** 16px line plus padding; the label is one line. */
const LABEL_HEIGHT = 20;

/** Keys the arrow walk leaves to a page control that has focus. */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "grid",
  "tree",
  "menu",
  "menubar",
  "tablist",
  "radiogroup",
]);

/** Every activating event, stopped at the earliest point the picker can reach. */
const ACTIVATING_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "dragstart",
] as const;

export interface PickerHost {
  channel: string;
  mode: PickerMode;
  post(event: ElementPickerEvent): void;
}

export interface PickerHandle {
  setMode(mode: PickerMode): void;
  /** Drop the selection and its outline without reporting it: the host asked. */
  clearSelection(): void;
  clearHover(): void;
  /**
   * Take the host's latest account of this document's readers, and describe
   * the selection and hover again where that changes what they say.
   */
  setAvailability(availability: PickerAvailability): void;
  /**
   * Select again what the host had selected, typically after an edit replaced
   * its nodes. False, with the selection unchanged, when it cannot be found.
   */
  reselect(request: unknown): boolean;
  dispose(): void;
  /** The overlay's closed shadow root, which nothing outside the picker can otherwise reach. */
  getOverlayRoot(): ShadowRoot | null;
}

type ObservationFields = Omit<HoverObservation, "phase">;
type ComponentChain = ObservationFields["componentChain"];

/**
 * One selected element. A click keeps the node it landed on as well as the
 * element its framework says the click stands for: the pick is asked again
 * every time the selection is described, so the answer never outlives the
 * page it was given for.
 */
interface SelectionEntry {
  hit: Element;
  target: Element;
  picked: boolean;
}

type ScopeState =
  | { kind: "element" }
  | { kind: "component"; componentId: string; framework: string; rootsComplete: boolean };

const ELEMENT_SCOPE: ScopeState = { kind: "element" };

interface Extracted {
  framework: ElementPickerFramework;
  data: ExtractorContribution;
  /** The element a pick stands for, when its framework named one other than the node asked about. */
  target: Element | null;
}

/** What the main-world readers said about one element. */
interface Extraction {
  /** Every framework's answer this side could take, in install order. */
  contributions: readonly Extracted[];
  /** Frameworks whose reader looked and found nothing. */
  empty: ReadonlySet<ElementPickerFramework>;
}

const NO_ANSWER: Extraction = { contributions: [], empty: new Set() };

type SelectionEvent = Extract<ElementPickerEvent, { type: "selectionChanged" }>;

/** Bootstrap-worded, so nothing the page writes reaches a notice the host shows. */
const NOTICE_ISSUES: Record<
  ExtractorNotice,
  (framework: ElementPickerFramework) => Extract<ElementPickerEvent, { type: "runtimeIssue" }>
> = {
  "not-dev-build": (framework) => ({
    type: "runtimeIssue",
    code: "not-dev-build",
    framework,
    detail: `this page has no ${framework} dev metadata; it looks like a production build`,
  }),
  "metadata-unavailable": (framework) => ({
    type: "runtimeIssue",
    code: "metadata-unavailable",
    framework,
    detail: `the dev server is running but no element carries ${framework} dev metadata`,
  }),
  "ancestry-truncated": (framework) => ({
    type: "runtimeIssue",
    code: "capacity",
    framework,
    detail: `${framework} ancestry was shortened to the picker's limits`,
  }),
};

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_RECT_PX, Math.min(MAX_RECT_PX, value));
}

/** UTF-8 bytes, as the host measures the envelope; code units undercount non-ASCII text. */
function byteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return typeof TextEncoder === "function"
    ? new TextEncoder().encode(text).length
    : text.length * 3;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isPlainObject);
}

function isChainShape(value: unknown): value is ObservationFields["componentChain"] {
  return (
    isPlainObject(value) &&
    (value.nearestId === null || typeof value.nearestId === "string") &&
    isObjectArray(value.components) &&
    typeof value.truncated === "boolean"
  );
}

const CAPABILITY_KEYS = ["names", "chain", "componentSelection", "file", "line", "exactRange"];
const CAPABILITY_STATES: ReadonlySet<unknown> = new Set(["available", "unknown", "unavailable"]);

const UNKNOWN: Capability = { state: "unknown" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };

function reopenUnavailable(
  capabilities: ObservationFields["capabilities"]
): ObservationFields["capabilities"] {
  const reopen = (capability: Capability) =>
    capability.state === "unavailable" ? UNKNOWN : capability;
  return {
    names: reopen(capabilities.names),
    chain: reopen(capabilities.chain),
    componentSelection: reopen(capabilities.componentSelection),
    file: reopen(capabilities.file),
    line: reopen(capabilities.line),
    exactRange: reopen(capabilities.exactRange),
  };
}

function serialize(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    // Never "unchanged": `post` reports it as it would anything else.
    return null;
  }
}

function everyCapability(capability: Capability): ObservationFields["capabilities"] {
  return {
    names: capability,
    chain: capability,
    componentSelection: capability,
    file: capability,
    line: capability,
    exactRange: capability,
  };
}

function isCapabilitiesShape(value: unknown): value is ObservationFields["capabilities"] {
  return (
    isPlainObject(value) &&
    CAPABILITY_KEYS.every((key) => {
      const entry = value[key];
      return isPlainObject(entry) && CAPABILITY_STATES.has(entry.state);
    })
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

const GENERIC_KEYS: ReadonlySet<string> = new Set(["kind", "framework", "fields"]);
const FIELD_KEYS: ReadonlySet<string> = new Set(["name", "value"]);

function isFieldShape(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, FIELD_KEYS)) return false;
  const { name, value: field } = value;
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= LIMITS.evidenceFieldName &&
    (field === null ||
      typeof field === "boolean" ||
      (typeof field === "number" && Number.isFinite(field)) ||
      (typeof field === "string" && field.length <= LIMITS.evidenceFieldValue))
  );
}

type EvidenceEntry = ObservationFields["frameworkEvidence"][number];

/** Every rule `GenericEvidenceSchema` holds it to, so an entry that passes here passes the host. */
function isGenericEvidenceShape(value: unknown): value is EvidenceEntry {
  return (
    isPlainObject(value) &&
    value.kind === "generic" &&
    hasOnlyKeys(value, GENERIC_KEYS) &&
    typeof value.framework === "string" &&
    FRAMEWORKS.has(value.framework) &&
    Array.isArray(value.fields) &&
    value.fields.length <= LIMITS.evidenceFields &&
    value.fields.every(isFieldShape)
  );
}

/**
 * The describing framework's own evidence. Svelte's variant is checked only
 * for its shape and the host holds it to the rest, as it did when one
 * framework's answer was taken whole.
 */
function isEvidenceShape(value: unknown): value is EvidenceEntry {
  if (isPlainObject(value) && value.kind === "svelte") {
    return (
      Array.isArray(value.ancestry) &&
      typeof value.sameLocCount === "number" &&
      typeof value.unmapped === "boolean"
    );
  }
  return isGenericEvidenceShape(value);
}

function describes(contribution: ExtractorContribution): boolean {
  return (
    isChainShape(contribution.componentChain) ||
    isCapabilitiesShape(contribution.capabilities) ||
    (isObjectArray(contribution.sourceCandidates) && contribution.sourceCandidates.length > 0)
  );
}

/**
 * The contribution that describes the element: the best-ranked one that says
 * anything about it, the first of equals in install order. One carrying
 * evidence alone describes nothing, so it never stands in for a framework
 * whose extractor is absent or silent. In a pick it is also the one whose
 * named element the pick stands for, and naming one is itself a description.
 */
function primaryOf(contributions: readonly Extracted[]): Extracted | null {
  let best: Extracted | null = null;
  let bestRank = Infinity;
  for (const contribution of contributions) {
    if (contribution.target === null && !describes(contribution.data)) continue;
    // Compared, not looked up: the value is the page's, and `"constructor"` is a key of every object.
    const ownership = contribution.data.ownership;
    const rank = ownership === "direct" ? 0 : ownership === "fallback" ? 2 : 1;
    if (rank < bestRank) {
      best = contribution;
      bestRank = rank;
    }
  }
  return best;
}

export function createPicker(host: PickerHost): PickerHandle {
  let mode: PickerMode = host.mode;
  let disposed = false;
  let hovered: Element | null = null;
  /** The nearest component the hovered element's framework named, for its label. */
  let hoverName: string | null = null;
  let selection: SelectionEntry[] = [];
  let scope: ScopeState = ELEMENT_SCOPE;
  /** The primary selected element's chain, as its framework described it, for widening. */
  let selectedChain: { framework: string; chain: ComponentChain } | null = null;
  /** The latest pointer hit not yet resolved; `undefined` when nothing is pending. */
  let pendingHit: Element | null | undefined = undefined;
  let frame = 0;
  let overlayHost: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let overlayLayer: HTMLElement | null = null;
  let overlayProbe: HTMLElement | null = null;
  let overlayBlocked = false;
  /** Watches the outlined elements themselves, which a root-sized observer misses. */
  let resizes: ResizeObserver | null = null;
  let tracked: Element[] = [];
  const ids = new WeakMap<Element, string>();
  /**
   * The other direction, for a host asking for an element by the id it was
   * told. Weak, so a replaced node is not kept alive; a replaced node is not
   * the same element and is not returned.
   */
  const held = new Map<string, WeakRef<Element>>();
  let nextId = 0;
  let nextRequest = 0;
  let awaitingRequest = 0;
  /** The terminal event the pending request is answered by; any other is not its answer. */
  let awaitingReply: "extracted" | "located" | null = null;
  let replies: string[] = [];
  /**
   * The elements the pending request's reply names, by the token it names
   * them with; null where two events claimed one token for different nodes.
   */
  let named = new Map<string, Element | null>();
  let namingEvents = 0;
  /** A selection being described: page code that runs inside it cannot start another. */
  let emitting = false;
  let availability: PickerAvailability = { detection: "pending", extractors: {} };
  /** What the last selection report said, so an availability update that changes nothing sends nothing. */
  let lastSelection: string | null = null;
  let lastHover: string | null = null;
  /** Notices already turned into issues in this document, by framework and code. */
  const noticed = new Set<string>();
  /** Frameworks this document already reported from a selection, so a walk is not re-sent on every click. */
  const reported = new Set<string>();
  const teardown: Array<() => void> = [];
  const selectTeardown: Array<() => void> = [];
  const overlayTag = "daintree-element-picker-" + Math.random().toString(36).slice(2, 10);
  const handshakeEvent = channelEvent(host.channel, "handshake");
  const extractEvent = channelEvent(host.channel, "extract");
  const extractedEvent = channelEvent(host.channel, "extracted");
  const elementEvent = channelEvent(host.channel, "element");
  const disposeEvent = channelEvent(host.channel, "dispose");
  const locateEvent = channelEvent(host.channel, "locate");
  const locatedEvent = channelEvent(host.channel, "located");
  const noticeEvent = channelEvent(host.channel, "notice");

  function listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options: AddEventListenerOptions,
    bucket: Array<() => void>
  ): void {
    target.addEventListener(type, handler, options);
    bucket.push(() => target.removeEventListener(type, handler, options));
  }

  function idOf(node: Element): string {
    let id = ids.get(node);
    if (id === undefined) {
      nextId += 1;
      id = "el-" + nextId;
      ids.set(node, id);
      hold(id, node);
    } else if (!held.has(id)) {
      // Reported again after its lookup was let go: the host may ask for it now.
      hold(id, node);
    }
    return id;
  }

  function hold(id: string, node: Element): void {
    if (typeof WeakRef !== "function") return;
    if (held.size >= MAX_HELD_IDS) {
      for (const [key, ref] of held) {
        const node = ref.deref();
        if (node === undefined || !node.isConnected) held.delete(key);
      }
      // A long-lived document is pointed at more live elements than the cap;
      // past it the oldest ids go, and a host asking for one falls back to its
      // framework's locator.
      while (held.size >= MAX_HELD_IDS) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
      }
    }
    held.set(id, new WeakRef(node));
  }

  /** An element this picker can select: in this document, connected, and not its own overlay. */
  function usable(node: Element | null | undefined): node is Element {
    return (
      node instanceof Element &&
      node.isConnected &&
      node.ownerDocument === document &&
      !isOverlay(node)
    );
  }

  function primary(): Element | null {
    return selection[0]?.target ?? null;
  }

  function describe(node: Element): string {
    let label = node.localName;
    const id = node.getAttribute("id");
    if (id !== null && id.length > 0) label += "#" + id;
    for (const entry of classWordsOf(node).slice(0, 2)) label += "." + entry;
    return clamp(label, LIMITS.label);
  }

  function boundsOf(node: Element): Array<{ x: number; y: number; width: number; height: number }> {
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    const toRect = (rect: DOMRect) => ({
      x: finite(rect.left),
      y: finite(rect.top),
      width: Math.max(0, finite(rect.width)),
      height: Math.max(0, finite(rect.height)),
    });
    const rects = node.getClientRects();
    for (let index = 0; index < rects.length && out.length < LIMITS.bounds; index += 1) {
      const rect = rects[index];
      if (rect !== undefined) out.push(toRect(rect));
    }
    if (out.length === 0) out.push(toRect(node.getBoundingClientRect()));
    return out;
  }

  function ancestryDetections(node: Element): FrameworkDetection[] {
    const detections = new DetectionSet();
    detectAncestry(node, detections);
    return detections.toArray();
  }

  /**
   * The node a reply names by `token`, when this request's `element` events
   * gave it one and only one. Rechecked: a page listener can move a node while
   * the reply is dispatched. A string that is not one of this request's tokens
   * names nothing: a main-world reader cannot know an element id.
   */
  function adopt(token: unknown, nodes: ReadonlyMap<string, Element | null>): Element | null {
    if (typeof token !== "string") return null;
    const node = nodes.get(token);
    return usable(node) ? node : null;
  }

  /**
   * Swap a reply's element tokens for element ids, in place. Anything else in
   * `rootElementIds` is dropped, and a record that lost a root that way no
   * longer lists them all.
   */
  function adoptRoots(chain: unknown, nodes: ReadonlyMap<string, Element | null>): void {
    if (!isPlainObject(chain) || !Array.isArray(chain.components)) return;
    for (const record of chain.components.slice(0, LIMITS.components)) {
      if (!isPlainObject(record) || !Array.isArray(record.rootElementIds)) continue;
      const tokens: unknown[] = record.rootElementIds;
      const ids: string[] = [];
      let lost = tokens.length > LIMITS.roots;
      for (const token of tokens.slice(0, LIMITS.roots)) {
        const node = adopt(token, nodes);
        if (node === null) {
          lost = true;
          continue;
        }
        const id = idOf(node);
        if (!ids.includes(id)) ids.push(id);
      }
      record.rootElementIds = ids;
      if (lost) record.rootsComplete = false;
    }
  }

  /**
   * One synchronous exchange with the main world: dispatched on `target` so
   * the other world's listener gets its own wrapper for the same node, with
   * every reply and every element it names arriving inside the dispatch.
   * Nothing at all means no extractor is installed, which is the common case
   * and costs one event.
   */
  function exchange(
    target: EventTarget,
    type: string,
    detail: string,
    id: number,
    reply: "extracted" | "located"
  ): { replies: string[]; named: Map<string, Element | null> } {
    // Page code runs inside the dispatch and can set off another request; that
    // one goes unanswered rather than taking over this one's replies.
    if (awaitingRequest !== 0) return { replies: [], named: new Map() };
    awaitingRequest = id;
    awaitingReply = reply;
    replies = [];
    named = new Map();
    namingEvents = 0;
    try {
      target.dispatchEvent(new CustomEvent(type, { detail, composed: true }));
    } catch {
      // A node that refuses the event has nothing more to say about itself.
    } finally {
      awaitingRequest = 0;
      awaitingReply = null;
    }
    const received = { replies, named };
    replies = [];
    named = new Map();
    return received;
  }

  function parseReply(text: string, id: number): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return isPlainObject(parsed) && parsed.id === id ? parsed : null;
  }

  /**
   * Ask the extractors in the main world about `node`, and keep every
   * framework's answer: one describes the element, and the rest may add
   * evidence around it. A pick lets each framework name the element the pick
   * stands for; the one whose answer is adopted decides it.
   */
  function extract(node: Element, phase: ExtractionPhase, pick = false): Extraction {
    nextRequest += 1;
    const id = nextRequest;
    const request: ExtractRequest = pick ? { id, phase, pick: true } : { id, phase };
    const received = exchange(node, extractEvent, JSON.stringify(request), id, "extracted");
    for (const text of received.replies) {
      const parsed = parseReply(text, id);
      if (parsed === null || !Array.isArray(parsed.contributions)) continue;
      const empty = new Set<ElementPickerFramework>();
      if (Array.isArray(parsed.empty)) {
        for (const name of parsed.empty.slice(0, FRAMEWORKS.size)) {
          if (typeof name === "string" && FRAMEWORKS.has(name)) {
            empty.add(name as ElementPickerFramework);
          }
        }
      }
      const contributions: Extracted[] = [];
      for (const entry of parsed.contributions.slice(0, FRAMEWORKS.size)) {
        if (!isPlainObject(entry) || typeof entry.framework !== "string") continue;
        if (!FRAMEWORKS.has(entry.framework) || !isPlainObject(entry.data)) continue;
        let target: Element | null = null;
        if (pick && entry.target !== undefined) {
          target = adopt(entry.target, received.named);
          // It describes an element this side cannot be shown, not the hit.
          if (target === null) continue;
        }
        adoptRoots(entry.data.componentChain, received.named);
        contributions.push({
          framework: entry.framework as ElementPickerFramework,
          data: entry.data as ExtractorContribution,
          target: target === node ? null : target,
        });
      }
      return { contributions, empty };
    }
    return NO_ANSWER;
  }

  /**
   * What a capability no reader offered comes to. Unavailable only once
   * nothing could still supply it: the host has finished looking at the page,
   * and every framework it, this element's markup or a reply named — other
   * than the one describing the element — has a reader that looked at the
   * element described and found nothing, or described it and was outranked. A
   * reader still loading, missing from this build, broken, or silent has not
   * looked; one that sent evidence alone, or an answer offering nothing, has
   * not said what it could; and one asked about the hit has not looked at the
   * element a pick moved to. Each leaves the answer open rather than becoming
   * a claim about the page.
   */
  function absence(
    detections: FrameworkDetection[],
    extraction: Extraction,
    primary: Extracted | null
  ): Capability {
    if (availability.detection !== "settled") return UNKNOWN;
    const speaker = primary?.framework ?? null;
    const described = primary?.target ?? null;
    const frameworks = new Set<ElementPickerFramework>(
      Object.keys(availability.extractors) as ElementPickerFramework[]
    );
    for (const entry of detections) frameworks.add(entry.framework);
    // A reader that answered, even with nothing, is a framework on the page.
    for (const contribution of extraction.contributions) frameworks.add(contribution.framework);
    for (const framework of extraction.empty) frameworks.add(framework);
    if (frameworks.size === 0) return { state: "unavailable", reason: "no-framework" };
    for (const framework of frameworks) {
      if (framework === speaker) continue;
      if (availability.extractors[framework] !== "installed") return UNKNOWN;
      // `empty` is about the node asked, which a pick that moved is not.
      const foundNothing = described === null && extraction.empty.has(framework);
      const outranked = extraction.contributions.some(
        (entry) =>
          entry.framework === framework && entry.target === described && describes(entry.data)
      );
      if (!foundNothing && !outranked) return UNKNOWN;
    }
    return NOT_EXPOSED;
  }

  /**
   * Elements one framework finds by a query in its own terms, from `anchor`
   * or from the whole document. Null when no extractor for it answered.
   */
  function locate(
    framework: string,
    query: unknown,
    anchor: Element | null
  ): { elements: Element[]; data: Record<string, unknown>; truncated: boolean } | null {
    nextRequest += 1;
    const id = nextRequest;
    const request: LocateRequest = { id, framework, query };
    let detail: string;
    try {
      detail = JSON.stringify(request);
    } catch {
      return null;
    }
    if (detail.length > MAX_LOCATE_REQUEST_CHARS) return null;
    const received = exchange(anchor ?? document, locateEvent, detail, id, "located");
    for (const text of received.replies) {
      const parsed = parseReply(text, id);
      if (parsed === null) continue;
      const tokens: unknown[] = Array.isArray(parsed.elements) ? parsed.elements : [];
      const elements: Element[] = [];
      // As many as a component's roots, and no more: past that the list is not whole.
      let omitted = parsed.truncated === true || tokens.length > LIMITS.roots;
      for (const token of tokens.slice(0, LIMITS.roots)) {
        const node = adopt(token, received.named);
        if (node === null) omitted = true;
        else if (!elements.includes(node)) elements.push(node);
      }
      return {
        elements,
        data: isPlainObject(parsed.data) ? parsed.data : {},
        truncated: omitted,
      };
    }
    return null;
  }

  function fieldsFor(
    node: Element,
    detections: FrameworkDetection[],
    extraction: Extraction,
    primary: Extracted | null
  ): ObservationFields {
    const absent = absence(detections, extraction, primary);
    const fields: ObservationFields = {
      elementId: idOf(node),
      tagName: clamp(node.localName || "element", LIMITS.tagName),
      label: describe(node),
      bounds: boundsOf(node),
      detections,
      componentChain: { nearestId: null, components: [], truncated: false },
      sourceCandidates: [],
      capabilities: everyCapability(absent),
      frameworkEvidence: [],
    };
    // One framework describes the element, whole: merging two frameworks'
    // chains is a resolver's call to make with both in view, not the page's.
    // Evidence is what the others may still add around it.
    // Each field is taken only in the shape the wire needs, so one malformed
    // field costs that field rather than the whole observation. Deeper rules —
    // ids that resolve, edges without cycles — stay the host's to enforce.
    if (primary !== null) {
      const { data } = primary;
      // An answer that does not say what it can offer leaves that open: what it
      // did name must not sit beside a claim that names are unavailable.
      fields.capabilities = everyCapability(UNKNOWN);
      if (isChainShape(data.componentChain)) {
        fields.componentChain = data.componentChain;
      }
      if (isObjectArray(data.sourceCandidates)) {
        fields.sourceCandidates = data.sourceCandidates.slice(0, LIMITS.sourceCandidates);
      }
      if (isCapabilitiesShape(data.capabilities)) {
        const offered = data.capabilities;
        // A reader speaks for its own framework: what it says is unavailable
        // stays open while another framework's reader could still supply it.
        fields.capabilities = absent.state === "unknown" ? reopenUnavailable(offered) : offered;
      }
    }
    // The element described: the adopted pick's, else the node asked about.
    const described = primary?.target ?? null;
    for (const contribution of primary === null
      ? extraction.contributions
      : [primary, ...extraction.contributions.filter((entry) => entry !== primary)]) {
      // A framework whose pick stands for another element saw a different one.
      if (contribution.target !== described) continue;
      const evidence: unknown = contribution.data.frameworkEvidence;
      if (!Array.isArray(evidence)) continue;
      for (const entry of evidence) {
        if (fields.frameworkEvidence.length >= LIMITS.frameworkEvidence) break;
        // A framework that does not describe the element adds context in the
        // flat generic form only, so it cannot cost the one that does its observation.
        if (contribution === primary ? isEvidenceShape(entry) : isGenericEvidenceShape(entry)) {
          fields.frameworkEvidence.push(entry);
        }
      }
    }
    return fields;
  }

  function nearestName(chain: ComponentChain): string | null {
    const nearest = chain.components.find((record) => record.componentId === chain.nearestId);
    // Page data in the declared shape, unchecked below the record.
    const name: unknown = nearest?.name?.value;
    return typeof name === "string" && name.length > 0 ? clamp(name, LIMITS.componentName) : null;
  }

  // Hover never walks ancestry: it is paid for on every element the pointer crosses.
  function hoverOf(node: Element): HoverObservation {
    const extraction = extract(node, "hover");
    const observation: HoverObservation = {
      phase: "hover",
      ...fieldsFor(node, [], extraction, primaryOf(extraction.contributions)),
    };
    hoverName = nearestName(observation.componentChain);
    return observation;
  }

  /**
   * The roots enclosing the element, each named by its host. Read whatever the
   * host is: a custom element's tag is what the page registered, and says
   * nothing about which library, if any, defined it.
   */
  function shadowHostsOf(
    node: Element
  ): Pick<ElementContext, "shadowHosts" | "shadowHostsTruncated"> {
    const hosts: NonNullable<ElementContext["shadowHosts"]> = [];
    for (
      let root = node.getRootNode();
      root instanceof ShadowRoot;
      root = root.host.getRootNode()
    ) {
      if (hosts.length >= LIMITS.shadowHosts) {
        return { shadowHosts: hosts, shadowHostsTruncated: true };
      }
      const shadowHost = root.host;
      hosts.push({
        elementId: idOf(shadowHost),
        tagName: clamp(shadowHost.localName || "element", LIMITS.tagName),
        label: describe(shadowHost),
      });
    }
    return { shadowHosts: hosts };
  }

  /** Selection only: the context costs a computed-style read and a markup walk. */
  function selectionOf(node: Element, fields: ObservationFields): SelectionObservation {
    const observation: SelectionObservation = { phase: "selection", ...fields };
    const context = elementContextOf(node);
    if (context !== null) observation.context = { ...context, ...shadowHostsOf(node) };
    return observation;
  }

  /**
   * Fit the selection into one envelope: whole if it fits, else with every
   * framework's ancestry shortened and each chain cut to the records the
   * selection names. The prelude would otherwise swap an oversized event for a
   * capacity issue while this side went on believing it had been sent. What was
   * cut is the caller's to report, with the event it explains.
   */
  function fitSelection(
    event: SelectionEvent
  ): { event: SelectionEvent; cut: string | null } | null {
    if (byteLength(event) <= LIMITS.eventBytes) return { event, cut: null };
    const scoped = event.scope.kind === "component" ? event.scope.componentId : null;
    const shortened = {
      ...event,
      observations: event.observations.map((observation) => ({
        ...observation,
        componentChain: shortenChain(observation.componentChain, scoped),
        // Page data in the declared shape, unchecked below the entry.
        frameworkEvidence: observation.frameworkEvidence.map((entry) =>
          entry.kind === "svelte" && Array.isArray(entry.ancestry)
            ? { ...entry, ancestry: entry.ancestry.slice(0, SHORTENED_ANCESTRY) }
            : entry
        ),
      })),
    };
    if (byteLength(shortened) <= LIMITS.eventBytes) {
      return { event: shortened, cut: "ancestry shortened to fit the selection into one envelope" };
    }
    // Each element's markup and styles are bounded on their own, not across a
    // component's every root; the description goes before the selection does.
    const bare = {
      ...shortened,
      observations: shortened.observations.map(
        ({ context: _context, ...observation }) => observation
      ),
    };
    if (byteLength(bare) > LIMITS.eventBytes) return null;
    return {
      event: bare,
      cut: "ancestry shortened and element markup and styles left out to fit the selection into one envelope",
    };
  }

  /** Keeps the nearest and scoped records, and drops edges to anything it let go. */
  function shortenChain(chain: ComponentChain, scoped: string | null): ComponentChain {
    const kept = chain.components.filter(
      (record) => record.componentId === chain.nearestId || record.componentId === scoped
    );
    if (kept.length === chain.components.length) return chain;
    const ids = new Set(kept.map((record) => record.componentId));
    return {
      nearestId: chain.nearestId,
      truncated: true,
      components: kept.map((record) => {
        const copy = { ...record };
        if (typeof copy.renderParentId === "string" && !ids.has(copy.renderParentId)) {
          delete copy.renderParentId;
        }
        if (typeof copy.ownerId === "string" && !ids.has(copy.ownerId)) delete copy.ownerId;
        return copy;
      }),
    };
  }

  /**
   * Describe and send the selection. A pick is asked again, so the element it
   * stands for is the one its framework names now — adopted only once the
   * description is sent. `capacity` when it would not fit one envelope and
   * `failed` when it could not be described at all, with nothing sent.
   */
  function emitSelection(
    cause: "user" | "document" | "reselect",
    onlyIfChanged = false
  ): {
    sent: boolean;
    failure?: "capacity" | "failed";
    detections: FrameworkDetection[];
  } {
    if (emitting) return { sent: false, failure: "failed", detections: [] };
    emitting = true;
    try {
      return describeSelection(cause, onlyIfChanged);
    } catch {
      return { sent: false, failure: "failed", detections: [] };
    } finally {
      emitting = false;
    }
  }

  /** With `onlyIfChanged`, a selection that says what it last said is not sent again. */
  function describeSelection(
    cause: "user" | "document" | "reselect",
    onlyIfChanged: boolean
  ): {
    sent: boolean;
    failure?: "capacity" | "failed";
    detections: FrameworkDetection[];
  } {
    const observations: SelectionObservation[] = [];
    const targets: Element[] = [];
    const chains: Array<{ framework: string; chain: ComponentChain } | null> = [];
    let detections: FrameworkDetection[] = [];
    for (const entry of selection) {
      const extraction = entry.picked
        ? extract(entry.hit, "selection", true)
        : extract(entry.target, "selection");
      const primary = primaryOf(extraction.contributions);
      const target = entry.picked ? (primary?.target ?? entry.hit) : entry.target;
      targets.push(target);
      const entryDetections = ancestryDetections(target);
      const fields = fieldsFor(target, entryDetections, extraction, primary);
      if (observations.length === 0) detections = entryDetections;
      // A pick that lands where another entry already is says nothing new.
      if (observations.some((observation) => observation.elementId === fields.elementId)) continue;
      observations.push(selectionOf(target, fields));
      chains.push(
        primary === null ? null : { framework: primary.framework, chain: fields.componentChain }
      );
    }
    // Widening steps out from the chain the selection is scoped in, or the
    // primary element's when it is one element.
    let chain = chains[0] ?? null;
    let reportedScope: SelectionScope = { kind: "element" };
    const scoped = scope;
    if (scoped.kind === "component") {
      const componentId = scoped.componentId;
      const rootIds = observations.map((observation) => observation.elementId);
      observations.forEach((observation, index) => {
        for (const record of observation.componentChain.components) {
          if (record.componentId !== componentId) continue;
          record.rootElementIds = rootIds.slice(0, LIMITS.roots);
          record.rootsComplete = scoped.rootsComplete && rootIds.length <= LIMITS.roots;
          if (reportedScope.kind === "element") chain = chains[index] ?? null;
          reportedScope = { kind: "component", componentId };
        }
      });
    }
    const fitted = fitSelection({
      type: "selectionChanged",
      observations,
      cause,
      scope: reportedScope,
    });
    if (fitted === null) return { sent: false, failure: "capacity", detections };
    const { event, cut } = fitted;
    // What the host would be told, after the fit: a change only to what it cuts is no change.
    const text = serialize({ observations: event.observations, scope: event.scope });
    if (onlyIfChanged && text !== null && text === lastSelection) {
      return { sent: false, detections };
    }
    // The picker went away while page code ran inside one of the exchanges.
    if (disposed) return { sent: false, failure: "failed", detections };
    selection.forEach((entry, index) => {
      const target = targets[index];
      if (target !== undefined) entry.target = target;
    });
    // A component no observation names any more is not a selection the host
    // was told about: what it was told is element scope.
    if (reportedScope.kind === "element") scope = ELEMENT_SCOPE;
    selectedChain = chain;
    lastSelection = text;
    if (cut !== null) host.post({ type: "runtimeIssue", code: "capacity", detail: cut });
    host.post(event);
    return { sent: true, detections };
  }

  /**
   * Report frameworks the selected element's own markup names, once each per
   * document. This is how an island that hydrated after the host's probes is
   * still found: the user pointed at it.
   */
  function reportDetections(detections: FrameworkDetection[]): void {
    const fresh = detections.filter((entry) => !reported.has(entry.framework));
    if (fresh.length === 0) return;
    for (const entry of fresh) reported.add(entry.framework);
    host.post({ type: "frameworksDetected", detections: fresh });
  }

  /**
   * Replace the selection, or keep the old one when the new one cannot be
   * sent whole: the host must never be left looking at a different selection
   * from the one outlined here.
   */
  function commit(
    entries: SelectionEntry[],
    next: ScopeState,
    cause: "user" | "reselect"
  ): boolean {
    if (emitting || disposed) return false;
    const previous = { selection, scope, selectedChain };
    selection = entries;
    scope = next;
    const result = emitSelection(cause);
    if (!result.sent) {
      selection = previous.selection;
      scope = previous.scope;
      selectedChain = previous.selectedChain;
      if (result.failure === "capacity") {
        host.post({
          type: "runtimeIssue",
          code: "capacity",
          detail: "selection left unchanged: the observation did not fit one envelope",
        });
      }
      return false;
    }
    if (cause === "user") reportDetections(result.detections);
    schedule();
    return true;
  }

  function select(node: Element | null, cause: "user" | "reselect", picked = false): void {
    commit(node === null ? [] : [{ hit: node, target: node, picked }], ELEMENT_SCOPE, cause);
  }

  /**
   * The selection lost a node to the document — a re-render, an HMR patch.
   * What is left is described as it is; nothing is kept alive for the rest.
   */
  function dropDetached(): void {
    if (emitting) return;
    const live = selection.filter((entry) => entry.target.isConnected && entry.hit.isConnected);
    if (live.length === selection.length) return;
    selection = live;
    if (live.length === 0) scope = ELEMENT_SCOPE;
    // What is left of a component is no longer every root it rendered.
    else if (scope.kind === "component") scope = { ...scope, rootsComplete: false };
    if (!emitSelection("document").sent) {
      selection = [];
      scope = ELEMENT_SCOPE;
      emitSelection("document");
    }
  }

  /**
   * Alt+ArrowUp: widen to the next component out that the page can name and
   * place, as that invocation's rendered roots — not every copy a line drew.
   */
  function widen(): void {
    const anchor = primary();
    if (anchor === null || selectedChain === null) return;
    const { framework, chain } = selectedChain;
    const scoped = scope.kind === "component" ? scope.componentId : null;
    const current = chain.components.findIndex((record) => record.componentId === scoped);
    for (let at = current + 1; at < chain.components.length; at += 1) {
      const record = chain.components[at];
      if (record === undefined || record.name === null || record.sourceCandidates.length === 0) {
        continue;
      }
      const found = locate(framework, { kind: "roots", componentId: record.componentId }, anchor);
      if (found === null || found.elements.length === 0) continue;
      commit(
        found.elements.map((root) => ({ hit: root, target: root, picked: false })),
        {
          kind: "component",
          componentId: record.componentId,
          framework,
          rootsComplete: found.data.complete === true && !found.truncated,
        },
        "user"
      );
      return;
    }
  }

  function setHover(node: Element | null): void {
    if (node === hovered) return;
    hovered = node;
    postHover();
  }

  /** With `onlyIfChanged`, a hover that says what it last said is not sent again. */
  function postHover(onlyIfChanged = false): void {
    if (hovered === null) hoverName = null;
    const observation = hovered === null ? null : hoverOf(hovered);
    const text = serialize(observation);
    if (onlyIfChanged && text !== null && text === lastHover) return;
    lastHover = text;
    host.post({ type: "hoverChanged", observation });
  }

  function hitFromEvent(event: Event): Element | null {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const first = path.length > 0 ? path[0] : event.target;
    return first instanceof Element ? first : null;
  }

  function isOverlay(node: Element | null): boolean {
    if (node === null || overlayHost === null) return false;
    return node === overlayHost || overlayHost.contains(node);
  }

  function suppress(event: Event): void {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  function schedule(): void {
    if (disposed || frame !== 0) return;
    frame = requestAnimationFrame(onFrame);
  }

  function onFrame(): void {
    frame = 0;
    if (disposed) return;
    if (pendingHit !== undefined) {
      const hit = pendingHit;
      pendingHit = undefined;
      setHover(hit === null || isOverlay(hit) ? null : hit);
    }
    // A re-render can replace nodes outright; a detached one has no geometry
    // worth drawing and must not be kept alive by the picker.
    dropDetached();
    if (hovered !== null && !hovered.isConnected) setHover(null);
    paint();
  }

  function ensureOverlay(): void {
    if (overlayBlocked || (overlayHost !== null && overlayHost.isConnected)) return;
    const parent = document.documentElement;
    if (parent === null) return;
    const hostElement = document.createElement(overlayTag);
    hostElement.setAttribute("aria-hidden", "true");
    // Inline and !important, so no page rule can move it; zero-sized and fixed,
    // so it cannot add a scrollbar or shift a line of the page. Appended to the
    // root element rather than <body>, whose transform would offset it.
    for (const [property, value] of [
      ["position", "fixed"],
      ["top", "0"],
      ["left", "0"],
      ["width", "0"],
      ["height", "0"],
      ["margin", "0"],
      ["padding", "0"],
      ["border", "0"],
      ["display", "block"],
      ["visibility", "visible"],
      ["opacity", "1"],
      ["pointer-events", "none"],
      ["z-index", "2147483647"],
    ] as const) {
      hostElement.style.setProperty(property, value, "important");
    }
    let root: ShadowRoot;
    try {
      // Closed: the page can see an element was added, never what is inside it.
      root = hostElement.attachShadow({ mode: "closed" });
    } catch {
      overlayBlocked = true;
      host.post({
        type: "runtimeIssue",
        code: "overlay-blocked",
        detail: "the page refused a shadow root for the overlay",
      });
      return;
    }
    const layer = document.createElement("div");
    root.appendChild(layer);
    // A fixed probe of known size reads back whatever transform an ancestor
    // imposes on fixed children — `html { transform }`, zoom, scale — which
    // client rects already include and the overlay would otherwise apply twice.
    const probe = document.createElement("div");
    style(probe, [
      ["position", "fixed"],
      ["top", "0"],
      ["left", "0"],
      ["width", PROBE_SIZE + "px"],
      ["height", PROBE_SIZE + "px"],
      ["visibility", "hidden"],
      ["pointer-events", "none"],
    ]);
    root.appendChild(probe);
    parent.appendChild(hostElement);
    overlayHost = hostElement;
    overlayRoot = root;
    overlayLayer = layer;
    overlayProbe = probe;
  }

  /** Viewport → overlay coordinates. */
  function readTransform(): { x: number; y: number; sx: number; sy: number } {
    const rect = overlayProbe?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0, sx: 1, sy: 1 };
    const sx = rect.width > 0 ? rect.width / PROBE_SIZE : 1;
    const sy = rect.height > 0 ? rect.height / PROBE_SIZE : 1;
    return { x: rect.left, y: rect.top, sx, sy };
  }

  function removeOverlay(): void {
    overlayHost?.remove();
    overlayHost = null;
    overlayRoot = null;
    overlayLayer = null;
    overlayProbe = null;
  }

  /**
   * Styled through the CSSOM rather than a stylesheet or a style attribute:
   * neither `style-src` nor `style-src-attr` reaches it, so a strict CSP costs
   * the overlay nothing.
   */
  function style(node: HTMLElement, declarations: ReadonlyArray<readonly [string, string]>): void {
    for (const [property, value] of declarations) node.style.setProperty(property, value);
  }

  type Transform = ReturnType<typeof readTransform>;

  function drawBox(
    layer: HTMLElement,
    node: Element,
    kind: "hover" | "selected",
    transform: Transform
  ): void {
    const rect = node.getBoundingClientRect();
    const box = document.createElement("div");
    style(box, [
      ["position", "fixed"],
      ["left", (rect.left - transform.x) / transform.sx + "px"],
      ["top", (rect.top - transform.y) / transform.sy + "px"],
      ["width", Math.max(0, rect.width) / transform.sx + "px"],
      ["height", Math.max(0, rect.height) / transform.sy + "px"],
      ["box-sizing", "border-box"],
      ["pointer-events", "none"],
      ["border", kind === "selected" ? "2px solid #3884ff" : "1px solid rgba(56, 132, 255, 0.9)"],
      ["background", kind === "selected" ? "rgba(56, 132, 255, 0.16)" : "rgba(56, 132, 255, 0.08)"],
    ]);
    layer.appendChild(box);
  }

  /**
   * Above the element, else below it, else just inside its top edge — an
   * element as tall as the viewport has no outside to put a label in — and
   * kept inside the viewport horizontally, measured once it has a width.
   */
  function drawLabel(layer: HTMLElement, node: Element, transform: Transform): void {
    const rect = node.getBoundingClientRect();
    const label = document.createElement("div");
    // The component its framework named, then the element: a selection can be
    // widened to the component, so the label says which one that would be.
    if (hoverName !== null) {
      const name = document.createElement("span");
      name.textContent = hoverName;
      style(name, [["font-weight", "600"]]);
      label.appendChild(name);
      label.appendChild(document.createTextNode(" " + describe(node)));
    } else {
      label.textContent = describe(node);
    }
    style(label, [
      ["position", "fixed"],
      ["left", "0px"],
      ["top", "0px"],
      ["max-width", "320px"],
      ["overflow", "hidden"],
      ["text-overflow", "ellipsis"],
      ["white-space", "nowrap"],
      ["padding", "2px 6px"],
      ["border-radius", "4px"],
      ["background", "rgba(20, 22, 28, 0.92)"],
      ["color", "#f4f6fb"],
      ["font", "500 11px/16px system-ui, -apple-system, sans-serif"],
      ["pointer-events", "none"],
    ]);
    layer.appendChild(label);
    // Measured as rendered, so a scaled root's larger label is placed by its
    // real size; the fallback is for a document with no layout to measure.
    const measured = label.getBoundingClientRect();
    const width = measured.width;
    const height = measured.height > 0 ? measured.height : LABEL_HEIGHT;
    let top = rect.top - height - 2;
    if (top < 0) top = rect.bottom + 2;
    if (top + height > innerHeight) top = Math.max(0, rect.top) + 2;
    top = Math.max(0, Math.min(top, innerHeight - height));
    const left = Math.max(0, Math.min(rect.left, innerWidth - width));
    style(label, [
      ["left", (left - transform.x) / transform.sx + "px"],
      ["top", (top - transform.y) / transform.sy + "px"],
    ]);
  }

  function paint(): void {
    if (disposed) return;
    if (mode !== "select") {
      if (overlayLayer !== null) overlayLayer.textContent = "";
      return;
    }
    ensureOverlay();
    const layer = overlayLayer;
    if (layer === null) return;
    layer.textContent = "";
    const transform = readTransform();
    for (const entry of selection) drawBox(layer, entry.target, "selected", transform);
    if (hovered !== null) {
      if (!selection.some((entry) => entry.target === hovered)) {
        drawBox(layer, hovered, "hover", transform);
      }
      drawLabel(layer, hovered, transform);
    }
    trackOutlined();
  }

  function keyTargetsPageControl(event: Event): boolean {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const entry of path) {
      if (!(entry instanceof Element)) continue;
      const tag = entry.localName;
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (entry instanceof HTMLElement && entry.isContentEditable) return true;
      const role = entry.getAttribute("role");
      if (role !== null && CONTROL_ROLES.has(role)) return true;
    }
    return false;
  }

  /**
   * The rendered tree, as a browser inspector walks it: a host's children are
   * its open shadow root's, a slot's are the elements assigned to it — its
   * fallback content only when nothing is — and a slotted element's parent is
   * its slot. A closed root is out of reach and its slots report nothing, so
   * its host walks into its light-DOM children, as a page script would see it.
   */
  function childrenOf(node: Element): Element[] {
    if (node instanceof HTMLSlotElement && node.assignedNodes().length > 0) {
      return node.assignedElements().filter((child) => !isOverlay(child));
    }
    const root = node.shadowRoot;
    return Array.from((root ?? node).children).filter((child) => !isOverlay(child));
  }

  function renderedParent(node: Element): Element | null {
    return node.assignedSlot ?? parentAcrossShadow(node);
  }

  function siblingsOf(node: Element): Element[] {
    const parent = renderedParent(node);
    return parent === null ? [] : childrenOf(parent);
  }

  /** Arrows walk the rendered tree the way a browser inspector does; Escape lets go. */
  function onKeyDown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    // Keys during composition belong to the IME, never to the picker.
    if (keyboard.isComposing === true || keyboard.keyCode === 229) return;
    if (keyboard.key === "Escape") {
      // Swallowed only when there was a selection to clear; otherwise the host
      // still owns Escape for leaving the picker.
      if (selection.length === 0) return;
      suppress(event);
      select(null, "user");
      return;
    }
    const current = primary();
    if (current === null || !keyboard.key.startsWith("Arrow")) return;
    if (keyboard.ctrlKey || keyboard.metaKey || keyboard.shiftKey) return;
    const widening = keyboard.altKey && keyboard.key === "ArrowUp";
    if (keyboard.altKey && !widening) return;
    if (keyTargetsPageControl(event)) return;
    if (widening) {
      suppress(event);
      widen();
      return;
    }
    let next: Element | null | undefined;
    if (keyboard.key === "ArrowUp") {
      next = renderedParent(current);
    } else if (keyboard.key === "ArrowDown") {
      next = childrenOf(current)[0];
    } else if (keyboard.key === "ArrowLeft" || keyboard.key === "ArrowRight") {
      const siblings = siblingsOf(current);
      const index = siblings.indexOf(current);
      if (index < 0) return;
      next = siblings[index + (keyboard.key === "ArrowRight" ? 1 : -1)];
    } else {
      return;
    }
    suppress(event);
    if (next !== null && next !== undefined) select(next, "user");
  }

  function onPointerMove(event: Event): void {
    pendingHit = hitFromEvent(event);
    schedule();
  }

  function onPointerLeave(event: Event): void {
    // Leaving the page, not moving within it: the root's own leave, or an `out`
    // with nowhere it went to — all a page embedded in a host window is told
    // when the pointer crosses into the host.
    const root = event.target === document || event.target === document.documentElement;
    const nowhere = event.type.endsWith("out") && (event as MouseEvent).relatedTarget === null;
    if (!root && !nowhere) return;
    pendingHit = null;
    schedule();
  }

  function onSelectClick(event: Event): void {
    suppress(event);
    const hit = hitFromEvent(event);
    if (hit === null || isOverlay(hit)) return;
    select(hit, "user", true);
  }

  /**
   * On `window` in the capture phase, the earliest point a script installed
   * into a loaded document can reach: ahead of every document, root and
   * element listener a page or its router adds. A listener the page itself
   * put on `window` in the capture phase before the picker arrived still runs
   * first; only a document-start registration could precede it, and the core
   * picker deliberately installs into documents, not ahead of them.
   */
  function attachSelectListeners(): void {
    if (selectTeardown.length > 0) return;
    const capture: AddEventListenerOptions = { capture: true };
    for (const type of ACTIVATING_EVENTS) {
      listen(window, type, type === "click" ? onSelectClick : suppress, capture, selectTeardown);
    }
    listen(window, "keydown", onKeyDown, capture, selectTeardown);
    const passiveCapture: AddEventListenerOptions = { capture: true, passive: true };
    listen(window, "pointermove", onPointerMove, passiveCapture, selectTeardown);
    for (const type of ["pointerleave", "mouseleave", "pointerout", "mouseout"]) {
      listen(document, type, onPointerLeave, passiveCapture, selectTeardown);
    }
    listen(window, "scroll", schedule, passiveCapture, selectTeardown);
    listen(window, "resize", schedule, { passive: true }, selectTeardown);
    // An image or font arriving, or a transition ending, moves an element
    // without resizing it or touching the DOM. None of these bubble; all of
    // them pass `window` in the capture phase.
    for (const type of ["load", "transitionend", "animationend"]) {
      listen(window, type, schedule, passiveCapture, selectTeardown);
    }
    // Layout and structure move with no event at all — an HMR patch, a class
    // flip. One frame absorbs any number of records, and neither observer
    // sees the overlay, which lives in a shadow root.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.documentElement ?? document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    selectTeardown.push(() => mutations.disconnect());
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(schedule);
      resizes = observer;
      selectTeardown.push(() => {
        observer.disconnect();
        resizes = null;
        tracked = [];
      });
    }
  }

  /**
   * Re-observing makes the observer report again, so only when the outlined
   * set changed. The root is always watched: the page growing above an
   * element moves it.
   */
  function trackOutlined(): void {
    if (resizes === null) return;
    const next = [
      document.documentElement,
      ...selection.map((entry) => entry.target),
      hovered,
    ].filter((node): node is Element => node !== null);
    if (next.length === tracked.length && next.every((node, index) => node === tracked[index])) {
      return;
    }
    tracked = next;
    resizes.disconnect();
    for (const node of next) resizes.observe(node);
  }

  function detachSelectListeners(): void {
    while (selectTeardown.length > 0) selectTeardown.pop()?.();
  }

  function setMode(next: PickerMode): void {
    if (disposed || next === mode) return;
    mode = next;
    if (next === "select") {
      attachSelectListeners();
      schedule();
      return;
    }
    // Browse leaves nothing behind: no listeners, no observers, no overlay.
    detachSelectListeners();
    pendingHit = undefined;
    setHover(null);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    removeOverlay();
  }

  function clearSelection(): void {
    if (disposed) return;
    selection = [];
    scope = ELEMENT_SCOPE;
    selectedChain = null;
    lastSelection = null;
    schedule();
  }

  function clearHover(): void {
    if (disposed) return;
    pendingHit = undefined;
    setHover(null);
    schedule();
  }

  /**
   * The selection and the hover were described before this account arrived;
   * each is described again, and reported only if that changed what it says.
   * A pick asked again may stand for another element now, which is outlined
   * only once the host has been told.
   */
  function setAvailability(next: PickerAvailability): void {
    if (disposed) return;
    availability = next;
    // Gone already, or taken away by a page listener on the extract request
    // just now: in browse mode no frame would ever notice.
    dropDetached();
    if (selection.length > 0) {
      emitSelection("reselect", true);
      dropDetached();
    }
    if (hovered !== null && hovered.isConnected) postHover(true);
    if (mode === "select") schedule();
  }

  function heldElement(id: unknown): Element | null {
    if (typeof id !== "string") return null;
    const node = held.get(id)?.deref();
    return usable(node) ? node : null;
  }

  /**
   * The element the host names by the id it was told, while that is still the
   * same node; else whatever the framework's locator finds — exactly the copy
   * it names, never the first in its place. A locator that asks for a widened
   * component gets that invocation's roots back, the way Alt+ArrowUp would.
   */
  function reselect(request: unknown): boolean {
    if (disposed || mode !== "select" || !isPlainObject(request)) return false;
    const framework =
      typeof request.framework === "string" && FRAMEWORKS.has(request.framework)
        ? request.framework
        : null;
    let target = heldElement(request.elementId);
    let componentId: unknown;
    if (framework !== null && request.locator !== undefined) {
      const found = locate(framework, { kind: "reselect", locator: request.locator }, target);
      const first = found?.elements[0];
      if (first !== undefined) {
        target = first;
        componentId = found?.data.componentId;
      }
    }
    if (target === null) return false;
    let entries: SelectionEntry[] = [{ hit: target, target, picked: false }];
    let next: ScopeState = ELEMENT_SCOPE;
    if (framework !== null && typeof componentId === "string") {
      const roots = locate(framework, { kind: "roots", componentId }, target);
      if (roots !== null && roots.elements.length > 0) {
        entries = roots.elements.map((root) => ({ hit: root, target: root, picked: false }));
        next = {
          kind: "component",
          componentId,
          framework,
          rootsComplete: roots.data.complete === true && !roots.truncated,
        };
      }
    }
    if (!commit(entries, next, "reselect")) return false;
    // A crumb asks to be shown; a host selecting again after a hot update
    // must not pull the page back to something the user scrolled away from.
    const first = selection[0]?.target;
    if (
      request.reveal === true &&
      first !== undefined &&
      typeof first.scrollIntoView === "function"
    ) {
      first.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    return true;
  }

  function onNotice(event: Event): void {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== "string" || detail.length > 256) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(detail);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const { framework, notice } = parsed;
    if (typeof framework !== "string" || !FRAMEWORKS.has(framework)) return;
    if (!(EXTRACTOR_NOTICES as readonly unknown[]).includes(notice)) return;
    const key = framework + " " + String(notice);
    if (noticed.has(key)) return;
    noticed.add(key);
    host.post(NOTICE_ISSUES[notice as ExtractorNotice](framework as ElementPickerFramework));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    detachSelectListeners();
    while (teardown.length > 0) teardown.pop()?.();
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    removeOverlay();
    hovered = null;
    hoverName = null;
    selection = [];
    selectedChain = null;
    held.clear();
    pendingHit = undefined;
    // Whatever was installed in the main world for this bootstrap answers to it
    // and to nothing else, so it goes too.
    try {
      document.dispatchEvent(new CustomEvent(disposeEvent));
    } catch {
      // A document that refuses the event has already lost the registry with it.
    }
  }

  function emitDocumentReady(): void {
    const scale =
      typeof devicePixelRatio === "number" && devicePixelRatio > 0
        ? Math.min(devicePixelRatio, 64)
        : 1;
    host.post({
      type: "documentReady",
      url: clamp(location.href, LIMITS.url),
      viewport: {
        width: Math.max(1, Math.round(finite(innerWidth))),
        height: Math.max(1, Math.round(finite(innerHeight))),
        deviceScaleFactor: scale,
      },
    });
  }

  // Activation is all-or-nothing: suppressing listeners with no handle to
  // remove them would swallow the page's clicks for good.
  try {
    listen(
      document,
      handshakeEvent,
      (event) => {
        if (event.cancelable) event.preventDefault();
      },
      {},
      teardown
    );
    // Capture: the event is dispatched on the element itself and does not bubble.
    listen(
      document,
      elementEvent,
      (event) => {
        if (awaitingRequest === 0) return;
        // The reply names at most this many; past it the rest are noise.
        namingEvents += 1;
        if (namingEvents > MAX_ELEMENT_REFS * 2) return;
        const detail = (event as CustomEvent).detail;
        if (typeof detail !== "string" || detail.length > 64) return;
        let message: unknown;
        try {
          message = JSON.parse(detail);
        } catch {
          return;
        }
        if (!isPlainObject(message) || message.id !== awaitingRequest) return;
        const ref = message.ref;
        if (typeof ref !== "number" || !Number.isSafeInteger(ref)) return;
        if (ref < 0 || ref >= MAX_ELEMENT_REFS) return;
        const token = elementRefToken(ref);
        const target = hitFromEvent(event);
        if (target === null) return;
        // Page code can dispatch on this channel too: a token two nodes claim names neither.
        const claimed = named.get(token);
        if (claimed === undefined) named.set(token, target);
        else if (claimed !== target) named.set(token, null);
      },
      { capture: true },
      teardown
    );
    listen(
      document,
      extractedEvent,
      (event) => {
        if (awaitingReply !== "extracted" || replies.length >= MAX_REPLIES) return;
        const detail = (event as CustomEvent).detail;
        if (typeof detail === "string" && detail.length <= MAX_BRIDGE_MESSAGE_CHARS) {
          replies.push(detail);
        }
      },
      {},
      teardown
    );
    listen(
      document,
      locatedEvent,
      (event) => {
        if (awaitingReply !== "located" || replies.length >= MAX_REPLIES) return;
        const detail = (event as CustomEvent).detail;
        if (typeof detail === "string" && detail.length <= MAX_LOCATED_REPLY_CHARS) {
          replies.push(detail);
        }
      },
      {},
      teardown
    );
    listen(document, noticeEvent, onNotice, {}, teardown);
    if (document.readyState === "loading") {
      listen(document, "DOMContentLoaded", emitDocumentReady, { once: true }, teardown);
    } else {
      emitDocumentReady();
    }
    if (mode === "select") attachSelectListeners();
  } catch (err) {
    dispose();
    throw err;
  }

  return {
    setMode,
    clearSelection,
    clearHover,
    setAvailability,
    reselect,
    dispose,
    getOverlayRoot: () => overlayRoot,
  };
}
