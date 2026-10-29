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
/**
 * A plugin provider's id, `{publisher}.{plugin}.{provider}`. Shape only, restated
 * from `PLUGIN_PROVIDER_ID_PATTERN` for the same reason as the limits above:
 * the host holds every id to the registry, this only keeps the page's
 * strings from being treated as anything but ids.
 */
const PLUGIN_PROVIDER_ID =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isFramework(value: string): boolean {
  return FRAMEWORKS.has(value) || (value.length <= 160 && PLUGIN_PROVIDER_ID.test(value));
}
/** Entries read from one reply: the core frameworks plus room for the providers a mixed page can hold. */
const MAX_REPLY_ENTRIES = FRAMEWORKS.size + 16;
/** Replies kept per request; the first one whose id matches wins. */
const MAX_REPLIES = 4;
/** Reverse id lookups kept before dead ones are swept and the oldest let go. */
const MAX_HELD_IDS = 2_000;
/** What an over-ceiling selection keeps of each framework's ancestry. */
const SHORTENED_ANCESTRY = 4;
const PROBE_SIZE = 100;
/** 16px line plus padding; the label is one line. */
const LABEL_HEIGHT = 20;

/**
 * The overlay's colours, fixed rather than themed: it draws inside a page
 * whose palette nobody chose for it. No single colour survives every page, so
 * a selection's stroke carries a dark keyline and a white halo outside it,
 * one of the three always contrasting with whatever is underneath.
 * Hover is neutral and dashed, its dashes alternating dark and light so they
 * read as dashes on any page; a selection is the one coloured, solid thing —
 * blue for an element, violet for a component, as design tools draw them.
 */
const INK = {
  hover: "rgba(17, 24, 39, 0.9)",
  element: "#2563eb",
  component: "#7c3aed",
  halo: "rgba(255, 255, 255, 0.95)",
  keyline: "rgba(10, 14, 22, 0.45)",
  chip: "#1b1e25",
  chipEdge: "rgba(255, 255, 255, 0.16)",
  chipText: "#f4f6fb",
  chipMuted: "#aeb6c6",
} as const;
/** Screen pixels kept between a label and the viewport edge. */
const VIEWPORT_INSET = 4;
/** Screen pixels a component's group outline stands off its roots. */
const GROUP_PADDING = 6;
const LABEL_MAX_WIDTH = 360;
const WIDEN_KEY = /Mac|iPhone|iPad/.test(
  typeof navigator === "object" ? navigator.platform || navigator.userAgent : ""
)
  ? "⌥↑"
  : "Alt ↑";

/** A rectangle in viewport coordinates. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FrameLook {
  /** Stroke width in screen pixels. */
  width: number;
  color: string;
  dashed: boolean;
  /** A dark ring between the stroke and its white halo, for the selection strokes. */
  keyline: boolean;
}

const HOVER_FRAME: FrameLook = { width: 1, color: INK.hover, dashed: true, keyline: false };
/** A selection; painted blue for an element and violet for a component. */
const ELEMENT_FRAME: FrameLook = { width: 2, color: INK.element, dashed: false, keyline: true };
/** A selection held in Browse: shown rather than offered, so thinner, never fainter. */
const BROWSE_FRAME: FrameLook = { width: 1, color: INK.element, dashed: false, keyline: true };
/** Each root of a component selected as a group: marked, and quieter than the group. */
const ROOT_FRAME: FrameLook = { width: 1, color: INK.component, dashed: false, keyline: false };

/** A run of chip text. Context gives way before the name; a kind or key never does. */
interface ChipPart {
  text: string;
  role: "name" | "context" | "kind" | "key";
}

type ChipSide = "above" | "below" | "inside";

interface ChipSpot {
  side: ChipSide;
  left: number;
  top: number;
  fits: boolean;
}

function unionOf(boxes: readonly Box[]): Box {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

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
  empty: ReadonlySet<string>;
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
    isFramework(value.framework) &&
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
  /**
   * The component Alt+ArrowUp would select next, by name: undefined until the
   * key hints first ask, null when the page could not find one.
   */
  let widening: string | null | undefined = undefined;
  /** Crosshair over the whole page while Inspect is on. */
  let cursorSheet: CSSStyleSheet | null = null;
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
  const trackTeardown: Array<() => void> = [];
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
        for (const name of parsed.empty.slice(0, MAX_REPLY_ENTRIES)) {
          if (typeof name === "string" && isFramework(name)) {
            empty.add(name as ElementPickerFramework);
          }
        }
      }
      const contributions: Extracted[] = [];
      for (const entry of parsed.contributions.slice(0, MAX_REPLY_ENTRIES)) {
        if (!isPlainObject(entry) || typeof entry.framework !== "string") continue;
        if (!isFramework(entry.framework) || !isPlainObject(entry.data)) continue;
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
    const frameworks = new Set<string>(Object.keys(availability.extractors));
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

  function recordName(record: ComponentChain["components"][number] | undefined): string | null {
    // Page data in the declared shape, unchecked below the record.
    const name: unknown = record?.name?.value;
    return typeof name === "string" && name.length > 0 ? clamp(name, LIMITS.componentName) : null;
  }

  function nearestName(chain: ComponentChain): string | null {
    return recordName(chain.components.find((record) => record.componentId === chain.nearestId));
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
      // Before the selection, so the host reads it against the page it is on.
      if (pageMoved()) emitDocumentReady();
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
    widening = undefined;
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
   * its framework can find the roots of, as that invocation's rendered roots —
   * not every copy a line drew. Whether the page also placed it in source is a
   * separate observation: a Preact app without a jsx-source transform still
   * names its components and still knows what each one rendered.
   */
  function widen(): void {
    const next = nextComponentOut();
    if (next === null) return;
    const { record, found, framework } = next;
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
  }

  function nextComponentOut(): {
    record: ComponentChain["components"][number];
    found: NonNullable<ReturnType<typeof locate>>;
    framework: string;
  } | null {
    const anchor = primary();
    if (anchor === null || selectedChain === null) return null;
    const { framework, chain } = selectedChain;
    const scoped = scope.kind === "component" ? scope.componentId : null;
    const current = chain.components.findIndex((record) => record.componentId === scoped);
    for (let at = current + 1; at < chain.components.length; at += 1) {
      const record = chain.components[at];
      if (record === undefined || record.name === null) continue;
      const found = locate(framework, { kind: "roots", componentId: record.componentId }, anchor);
      if (found === null || found.elements.length === 0) continue;
      return { record, found, framework };
    }
    return null;
  }

  /**
   * What the key hints offer Alt+ArrowUp for, found the way the key would
   * find it, once per selection: a page whose framework cannot list a
   * component's roots is never shown a key that does nothing there.
   */
  function wideningName(): string | null {
    if (widening === undefined) {
      const next = nextComponentOut();
      widening = next === null ? null : recordName(next.record);
    }
    return widening;
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
    // Browse that just lost its last selected node has nothing left to track.
    syncTracking();
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

  function boxOf(node: Element): Box {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  /**
   * `box` grown by `by` on every side, so a stroke sits outside the element
   * and never paints over its edge or its text. An edge already flush with
   * the viewport stays on screen, its stroke drawn inward instead.
   */
  function outset(box: Box, by: number): Box {
    const grown = {
      left: box.left - by,
      top: box.top - by,
      right: box.right + by,
      bottom: box.bottom + by,
    };
    if (box.left >= 0 && grown.left < 0) grown.left = 0;
    if (box.top >= 0 && grown.top < 0) grown.top = 0;
    if (box.right <= innerWidth && grown.right > innerWidth) grown.right = innerWidth;
    if (box.bottom <= innerHeight && grown.bottom > innerHeight) grown.bottom = innerHeight;
    return grown;
  }

  /** Viewport coordinates → the overlay's, which an ancestor's transform may scale. */
  function position(node: HTMLElement, box: Box, transform: Transform): void {
    style(node, [
      ["left", (box.left - transform.x) / transform.sx + "px"],
      ["top", (box.top - transform.y) / transform.sy + "px"],
    ]);
  }

  /**
   * One outline, `pad` screen pixels off `box`, returned as the box its
   * stroke covers. Every length is divided by the page's scale, so a zoomed
   * page gets the same strokes, keyline and halo as any other.
   */
  function drawFrame(
    layer: HTMLElement,
    box: Box,
    look: FrameLook,
    transform: Transform,
    pad = 0
  ): Box {
    const unit = 1 / transform.sx;
    const frame = outset(box, look.width + pad);
    const node = document.createElement("div");
    style(node, [
      ["position", "fixed"],
      ["width", Math.max(0, frame.right - frame.left) / transform.sx + "px"],
      ["height", Math.max(0, frame.bottom - frame.top) / transform.sy + "px"],
      ["box-sizing", "border-box"],
      ["pointer-events", "none"],
      ["border", `${look.width * unit}px solid ${look.color}`],
    ]);
    if (look.dashed) {
      // Light dashes painted over the dark stroke: dashed on a light page and
      // on a dark one, where a halo would have turned the dashes solid white.
      style(node, [
        ["outline", `${look.width * unit}px dashed ${INK.halo}`],
        ["outline-offset", `${-look.width * unit}px`],
      ]);
    } else {
      // The keyline hugs the stroke, so on a light page it reads as the
      // stroke's own edge rather than a second rule; the halo goes outside it.
      const rings = look.keyline
        ? `0 0 0 ${unit}px ${INK.keyline}, 0 0 0 ${2 * unit}px ${INK.halo}`
        : `0 0 0 ${unit}px ${INK.halo}`;
      style(node, [["box-shadow", rings]]);
    }
    position(node, frame, transform);
    layer.appendChild(node);
    return frame;
  }

  /**
   * A one-line chip: a selection's tag in its outline's colour, or a neutral
   * dark one — the hover's label, the key hints, a tag in Browse. Built before
   * it is measured; `placeChip` positions it.
   */
  function createChip(
    layer: HTMLElement,
    parts: readonly ChipPart[],
    tone: "neutral" | "element" | "component",
    transform: Transform,
    /** Two pixels shorter than a tag, so a chip in a tag's row stops at the outline's halo. */
    compact = false
  ): HTMLElement {
    const unit = 1 / transform.sx;
    const tag = tone !== "neutral";
    const chip = document.createElement("div");
    style(chip, [
      ["position", "fixed"],
      ["left", "0px"],
      ["top", "0px"],
      ["display", "flex"],
      ["align-items", "center"],
      ["gap", 5 * unit + "px"],
      ["box-sizing", "border-box"],
      ["max-width", Math.min(LABEL_MAX_WIDTH, innerWidth - 2 * VIEWPORT_INSET) * unit + "px"],
      ["padding", `${(compact ? 1 : 2) * unit}px ${6 * unit}px`],
      ["border-radius", 4 * unit + "px"],
      ["background", tag ? INK[tone] : INK.chip],
      ["color", INK.chipText],
      [
        "box-shadow",
        tag
          ? `0 0 0 ${unit}px ${INK.halo}`
          : `0 0 0 ${unit}px ${INK.chipEdge}, 0 ${unit}px ${3 * unit}px rgba(0, 0, 0, 0.25)`,
      ],
      [
        "font",
        `500 ${11 * unit}px/${16 * unit}px system-ui, -apple-system, "Segoe UI", sans-serif`,
      ],
      ["white-space", "nowrap"],
      ["overflow", "hidden"],
      ["pointer-events", "none"],
    ]);
    // Context gives way whole before the name loses a character; the name is
    // cut only when it alone is wider than the chip. A kind or key never is.
    const yields = parts.some((part) => part.role === "context");
    for (const part of parts) {
      const span = document.createElement("span");
      span.textContent = part.text;
      if (part.role === "key") {
        style(span, [
          ["flex", "none"],
          ["padding", `0 ${3 * unit}px`],
          ["border", `${unit}px solid ${INK.chipMuted}`],
          ["border-radius", 3 * unit + "px"],
          ["font-size", 10 * unit + "px"],
          ["line-height", 13 * unit + "px"],
        ]);
      } else {
        style(span, [
          ["min-width", "0"],
          ["max-width", "100%"],
          ["overflow", "hidden"],
          ["text-overflow", "ellipsis"],
          [
            "flex",
            part.role === "kind" || (part.role === "name" && yields) ? "0 0 auto" : "0 1 auto",
          ],
          ["font-weight", part.role === "name" ? "600" : "400"],
        ]);
        if (!tag && part.role !== "name") style(span, [["color", INK.chipMuted]]);
      }
      chip.appendChild(span);
    }
    layer.appendChild(chip);
    return chip;
  }

  /** Where a chip `width` wide lines up with `frame`: its left edge, or its right where the left would run off. */
  function chipLeft(frame: Box, width: number): number {
    let left = frame.left;
    if (left + width > innerWidth - VIEWPORT_INSET) left = frame.right - width;
    return Math.max(VIEWPORT_INSET, Math.min(left, innerWidth - VIEWPORT_INSET - width));
  }

  /**
   * Candidate places `gap` off `frame`, in the order given: above or below
   * it when that stays `VIEWPORT_INSET` inside the viewport, or just inside
   * its top edge, which always fits — a frame as tall as the viewport has no
   * outside.
   */
  function spotsBeside(
    frame: Box,
    left: number,
    gap: number,
    height: number,
    sides: readonly ChipSide[]
  ): ChipSpot[] {
    const maxTop = innerHeight - VIEWPORT_INSET - height;
    return sides.map((side) => {
      if (side === "above") {
        const top = frame.top - gap - height;
        return { side, left, top, fits: top >= VIEWPORT_INSET };
      }
      if (side === "below") {
        const top = frame.bottom + gap;
        return { side, left, top, fits: top <= maxTop };
      }
      return {
        side,
        left,
        top: Math.max(VIEWPORT_INSET, Math.min(frame.top + gap, maxTop)),
        fits: true,
      };
    });
  }

  /** The first spot that fits and covers none of `avoid`, else the first that fits. */
  function placeChip(
    chip: HTMLElement,
    size: { width: number; height: number },
    spots: readonly ChipSpot[],
    avoid: readonly Box[],
    transform: Transform
  ): { side: ChipSide; box: Box } {
    const boxAt = (spot: ChipSpot): Box => ({
      left: spot.left,
      top: spot.top,
      right: spot.left + size.width,
      bottom: spot.top + size.height,
    });
    const chosen =
      spots.find((spot) => spot.fits && avoid.every((box) => !overlaps(boxAt(spot), box))) ??
      spots.find((spot) => spot.fits) ??
      spots[spots.length - 1];
    if (chosen === undefined)
      return { side: "inside", box: boxAt({ side: "inside", left: 0, top: 0, fits: true }) };
    const box = boxAt(chosen);
    position(chip, box, transform);
    return { side: chosen.side, box };
  }

  /** Measured as rendered, so a scaled root's larger chip is placed by its real size. */
  function sizeOf(chip: HTMLElement): { width: number; height: number } {
    const rect = chip.getBoundingClientRect();
    // The fallback is for a document with no layout to measure.
    return { width: rect.width, height: rect.height > 0 ? rect.height : LABEL_HEIGHT };
  }

  /** The element as the overlay names it: by its id alone when it has one, the drawer's fuller label otherwise. */
  function shortName(node: Element): string {
    const id = node.getAttribute("id");
    return id !== null && id.length > 0
      ? clamp(node.localName + "#" + id, LIMITS.label)
      : describe(node);
  }

  /** What the selection is, in the drawer's words: the element, or "Component" and its name. */
  function selectionParts(first: Element): ChipPart[] {
    if (scope.kind !== "component") return [{ text: shortName(first), role: "name" }];
    const componentId = scope.componentId;
    const record = selectedChain?.chain.components.find(
      (entry) => entry.componentId === componentId
    );
    const parts: ChipPart[] = [
      { text: "Component", role: "kind" },
      { text: recordName(record) ?? shortName(first), role: "name" },
    ];
    if (selection.length > 1) {
      const count = String(selection.length) + (scope.rootsComplete ? "" : "+");
      parts.push({ text: `· ${count} roots`, role: "kind" });
    }
    return parts;
  }

  /**
   * The keys that act on the selection, as the strip names them: the arrow
   * walk always, and Alt+ArrowUp with the component it would select only
   * where the page can find that component's roots.
   */
  function hintParts(): ChipPart[] {
    const parts: ChipPart[] = [
      { text: "↑↓←→", role: "key" },
      { text: "move", role: "kind" },
    ];
    const next = wideningName();
    if (next !== null)
      parts.push({ text: WIDEN_KEY, role: "key" }, { text: next, role: "context" });
    return parts;
  }

  function contains(outer: Box, inner: Box): boolean {
    return (
      inner.left >= outer.left &&
      inner.right <= outer.right &&
      inner.top >= outer.top &&
      inner.bottom <= outer.bottom
    );
  }

  function paint(): void {
    if (disposed) return;
    const browsing = mode !== "select";
    if (browsing && selection.length === 0) {
      if (overlayLayer !== null) overlayLayer.textContent = "";
      return;
    }
    ensureOverlay();
    const layer = overlayLayer;
    if (layer === null) return;
    layer.textContent = "";
    const transform = readTransform();
    const targets = selection.map((entry) => entry.target);
    const component = scope.kind === "component";
    let selected: { frame: Box; tag: HTMLElement; hint: HTMLElement | null } | null = null;
    const first = targets[0];
    if (first !== undefined) {
      const boxes = targets.map(boxOf);
      // Browse shows the selection held rather than offered: a thinner
      // outline and a neutral tag, at full contrast, and no keys.
      const look = browsing ? BROWSE_FRAME : ELEMENT_FRAME;
      const color = component ? INK.component : INK.element;
      let frame: Box;
      if (component && boxes.length > 1) {
        // One component, however many roots: each root marked thin, and the
        // group outlined and tagged once around all of them.
        for (const box of boxes) drawFrame(layer, box, { ...ROOT_FRAME, color }, transform);
        frame = drawFrame(layer, unionOf(boxes), { ...look, color }, transform, GROUP_PADDING);
      } else {
        frame = drawFrame(layer, unionOf(boxes), { ...look, color }, transform);
      }
      const tone = browsing ? "neutral" : component ? "component" : "element";
      const tag = createChip(layer, selectionParts(first), tone, transform);
      // Keys beside the selection while it has the user's attention: the
      // pointer on it or off the page, never next to another element's label.
      const hint =
        !browsing && (hovered === null || targets.includes(hovered))
          ? createChip(layer, hintParts(), "neutral", transform, true)
          : null;
      selected = { frame, tag, hint };
    }
    let hover: { frame: Box; label: HTMLElement } | null = null;
    // The selection's own tag already names a selected element under the pointer.
    if (!browsing && hovered !== null && !targets.includes(hovered)) {
      const frame = drawFrame(layer, boxOf(hovered), HOVER_FRAME, transform);
      const parts: ChipPart[] = [{ text: shortName(hovered), role: "name" }];
      // The component a selection here could be widened to.
      if (hoverName !== null) parts.push({ text: "in " + hoverName, role: "context" });
      hover = { frame, label: createChip(layer, parts, "neutral", transform) };
    }
    // Every chip measured before any is moved, so the layer is laid out once.
    const tagSize = selected === null ? null : sizeOf(selected.tag);
    const hintSize = selected?.hint ? sizeOf(selected.hint) : null;
    const labelSize = hover === null ? null : sizeOf(hover.label);
    const taken: Box[] = [];
    let tagSide: ChipSide = "above";
    if (selected !== null && tagSize !== null) {
      const { tag } = selected;
      // Flush with the outline's outer ring rather than its stroke, so no ring pokes out beside the tag.
      const frame = { ...selected.frame, left: selected.frame.left - 1 };
      const left = chipLeft(frame, tagSize.width);
      const spots = spotsBeside(frame, left, 0, tagSize.height, ["above", "below", "inside"]);
      const placed = placeChip(tag, tagSize, spots, [], transform);
      tagSide = placed.side;
      taken.push(placed.box);
      // Flush on the outline: the corner they share is squared, so it reads as the outline's tab.
      if (placed.side !== "inside" && left === frame.left) {
        const radius = 4 / transform.sx + "px";
        const corners =
          placed.side === "above"
            ? `${radius} ${radius} ${radius} 0`
            : `0 ${radius} ${radius} ${radius}`;
        style(tag, [["border-radius", corners]]);
      }
      if (selected.hint !== null && hintSize !== null) {
        // In the tag's row, so the selection's chips cover one band of the
        // page rather than two; under the outline only when the row is full.
        const beside = placed.box.right + 4;
        const hintSpots: ChipSpot[] = [
          {
            side: placed.side,
            left: beside,
            // Level with the tag's far edge: the tag sits on the stroke, the hints clear of it.
            top: placed.side === "below" ? placed.box.bottom - hintSize.height : placed.box.top,
            fits: beside + hintSize.width <= innerWidth - VIEWPORT_INSET,
          },
          ...spotsBeside(frame, chipLeft(frame, hintSize.width), 3, hintSize.height, [
            "below",
            "above",
            "inside",
          ]),
        ];
        taken.push(placeChip(selected.hint, hintSize, hintSpots, taken, transform).box);
      }
    }
    if (hover !== null && labelSize !== null) {
      const left = chipLeft(hover.frame, labelSize.width);
      const spots = spotsBeside(hover.frame, left, 2, labelSize.height, [
        "above",
        "below",
        "inside",
      ]);
      // Inside a selected component the label would cover what the component
      // shows; outside it, opposite its tag, it covers neither.
      if (selected !== null && contains(selected.frame, hover.frame)) {
        const away: ChipSide = tagSide === "below" ? "above" : "below";
        spots.unshift(...spotsBeside(selected.frame, left, 2, labelSize.height, [away]));
      }
      placeChip(hover.label, labelSize, spots, taken, transform);
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
    showPickCursor(true);
    selectTeardown.push(() => showPickCursor(false));
  }

  /**
   * The page says it is being picked from: links and buttons stop working in
   * Inspect, so they stop looking clickable too. A constructed sheet rather
   * than a <style> or an inline cursor on page elements: `style-src` does not
   * govern it, nothing in the page's DOM changes, and it comes off whole.
   */
  function showPickCursor(on: boolean): void {
    try {
      if (on) {
        if (cursorSheet === null) {
          cursorSheet = new CSSStyleSheet();
          cursorSheet.replaceSync("*, *::before, *::after { cursor: crosshair !important; }");
        }
        if (!document.adoptedStyleSheets.includes(cursorSheet)) {
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursorSheet];
        }
      } else if (cursorSheet !== null) {
        const sheet = cursorSheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (entry) => entry !== sheet
        );
      }
    } catch {
      // A document without constructed sheets keeps its own cursor; the overlay still draws.
    }
  }

  /**
   * What keeps the outlines on their elements, apart from the listeners that
   * pick: Inspect needs it, and so does a selection held in Browse, whose
   * outline would otherwise be left behind by the first scroll.
   */
  function attachTracking(): void {
    if (trackTeardown.length > 0) return;
    const passiveCapture: AddEventListenerOptions = { capture: true, passive: true };
    listen(window, "scroll", schedule, passiveCapture, trackTeardown);
    listen(window, "resize", schedule, { passive: true }, trackTeardown);
    // An image or font arriving, or a transition ending, moves an element
    // without resizing it or touching the DOM. None of these bubble; all of
    // them pass `window` in the capture phase.
    for (const type of ["load", "transitionend", "animationend"]) {
      listen(window, type, schedule, passiveCapture, trackTeardown);
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
    trackTeardown.push(() => mutations.disconnect());
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(schedule);
      resizes = observer;
      trackTeardown.push(() => {
        observer.disconnect();
        resizes = null;
        tracked = [];
      });
    }
  }

  /**
   * Browse with nothing selected leaves nothing behind: no listeners, no
   * observers, no overlay. Anything else has something to draw.
   */
  function syncTracking(): void {
    if (disposed) return;
    if (mode === "select" || selection.length > 0) {
      attachTracking();
      return;
    }
    while (trackTeardown.length > 0) trackTeardown.pop()?.();
    removeOverlay();
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
      syncTracking();
      schedule();
      return;
    }
    // Browse swallows nothing and outlines no hover; a held selection stays
    // drawn, quieter, and keeps only what tracking its outline needs.
    detachSelectListeners();
    pendingHit = undefined;
    setHover(null);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    syncTracking();
    if (selection.length > 0) schedule();
  }

  function clearSelection(): void {
    if (disposed) return;
    selection = [];
    scope = ELEMENT_SCOPE;
    selectedChain = null;
    widening = undefined;
    lastSelection = null;
    syncTracking();
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
    syncTracking();
    if (mode === "select" || selection.length > 0) schedule();
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
   * So does a component id from the selection's own chain — a crumb on any
   * page whose framework can find a component's roots — or nothing at all.
   */
  function reselect(request: unknown): boolean {
    if (disposed || mode !== "select" || !isPlainObject(request)) return false;
    const framework =
      typeof request.framework === "string" && isFramework(request.framework)
        ? request.framework
        : null;
    let target = heldElement(request.elementId);
    let componentId: unknown;
    const aimed = request.componentId !== undefined;
    if (aimed) {
      // Ids are this document's and this chain's: one the selection was not
      // read with names nothing here.
      const named = request.componentId;
      if (
        typeof named !== "string" ||
        framework === null ||
        selectedChain?.framework !== framework ||
        !selectedChain.chain.components.some((record) => record.componentId === named)
      ) {
        return false;
      }
      componentId = named;
    } else if (framework !== null && request.locator !== undefined) {
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
      } else if (aimed) {
        // A crumb that cannot select its component selects nothing else instead.
        return false;
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
    if (typeof framework !== "string" || !isFramework(framework)) return;
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
    while (trackTeardown.length > 0) trackTeardown.pop()?.();
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

  /** What `documentReady` last told the host, so a selection can say when that is out of date. */
  let reportedPage = "";

  function currentPage(): Extract<ElementPickerEvent, { type: "documentReady" }> {
    const scale =
      typeof devicePixelRatio === "number" && devicePixelRatio > 0
        ? Math.min(devicePixelRatio, 64)
        : 1;
    return {
      type: "documentReady",
      url: clamp(location.href, LIMITS.url),
      viewport: {
        width: Math.max(1, Math.round(finite(innerWidth))),
        height: Math.max(1, Math.round(finite(innerHeight))),
        deviceScaleFactor: scale,
      },
    };
  }

  function emitDocumentReady(): void {
    const page = currentPage();
    reportedPage = JSON.stringify(page);
    host.post(page);
  }

  /**
   * A client-side navigation or a resize leaves the document in place, so no
   * new `documentReady` follows it, and the host would describe a selection
   * against the page it last heard about.
   */
  function pageMoved(): boolean {
    return reportedPage !== "" && reportedPage !== JSON.stringify(currentPage());
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
    if (mode === "select") {
      attachSelectListeners();
      attachTracking();
    }
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
