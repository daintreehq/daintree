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
  FrameworkDetection,
  HoverObservation,
  SelectionObservation,
} from "../../../../shared/elementPicker/observation.js";
import type { ElementPickerEvent } from "../../../../shared/elementPicker/protocol.js";
import {
  MAX_BRIDGE_MESSAGE_CHARS,
  MAX_ELEMENT_REFS,
  channelEvent,
  elementRefToken,
  type ExtractRequest,
  type ExtractionPhase,
} from "../guestChannel.js";
import { DetectionSet, detectAncestry, parentAcrossShadow } from "./detectors.js";
import type { ExtractorContribution, PickerMode } from "./types.js";

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
  /** Describe the selection again, for a host that just gave the page a new extractor. */
  refresh(): void;
  dispose(): void;
  /** The overlay's closed shadow root, which nothing outside the picker can otherwise reach. */
  getOverlayRoot(): ShadowRoot | null;
}

type ObservationFields = Omit<HoverObservation, "phase">;

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_RECT_PX, Math.min(MAX_RECT_PX, value));
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

function isCapabilitiesShape(value: unknown): value is ObservationFields["capabilities"] {
  return (
    isPlainObject(value) &&
    CAPABILITY_KEYS.every((key) => {
      const entry = value[key];
      return isPlainObject(entry) && CAPABILITY_STATES.has(entry.state);
    })
  );
}

export function createPicker(host: PickerHost): PickerHandle {
  let mode: PickerMode = host.mode;
  let disposed = false;
  let hovered: Element | null = null;
  let selected: Element | null = null;
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
  let nextId = 0;
  let nextRequest = 0;
  let awaitingRequest = 0;
  let replies: string[] = [];
  /**
   * The elements the pending request's reply names, by the token it names
   * them with; null where two events claimed one token for different nodes.
   */
  let named = new Map<string, Element | null>();
  let namingEvents = 0;
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
    }
    return id;
  }

  function describe(node: Element): string {
    let label = node.localName;
    const id = node.getAttribute("id");
    if (id !== null && id.length > 0) label += "#" + id;
    const classAttr = node.getAttribute("class");
    if (classAttr !== null) {
      const classes = classAttr.split(/\s+/).filter((entry) => entry.length > 0);
      for (const entry of classes.slice(0, 2)) label += "." + entry;
    }
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
   * Swap a reply's element tokens for element ids, in place. Anything else in
   * `rootElementIds` is dropped: a main-world reader cannot know an element
   * id, so a string that is not one of this request's tokens names nothing. A
   * record that lost a root that way no longer lists them all.
   */
  function adoptRoots(chain: unknown, nodes: ReadonlyMap<string, Element | null>): void {
    if (!isPlainObject(chain) || !Array.isArray(chain.components)) return;
    for (const record of chain.components.slice(0, LIMITS.components)) {
      if (!isPlainObject(record) || !Array.isArray(record.rootElementIds)) continue;
      const tokens: unknown[] = record.rootElementIds;
      const ids: string[] = [];
      let lost = tokens.length > LIMITS.roots;
      for (const token of tokens.slice(0, LIMITS.roots)) {
        const node = typeof token === "string" ? nodes.get(token) : undefined;
        // Rechecked: a page listener can move a node while the reply is dispatched.
        if (
          node === undefined ||
          node === null ||
          node.ownerDocument !== document ||
          !node.isConnected ||
          isOverlay(node)
        ) {
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
   * Ask the extractors in the main world about `node`. The request is
   * dispatched on the node itself, so the other world's listener gets its own
   * wrapper for the same element without anything being written into the page
   * to name it. Replies arrive inside the dispatch; none at all means no
   * extractor is installed, which is the common case and costs one event.
   */
  function extract(node: Element, phase: ExtractionPhase): ExtractorContribution | null {
    // Page code runs inside the dispatch and can set off another description;
    // that one goes without, rather than taking over this request's replies.
    if (awaitingRequest !== 0) return null;
    nextRequest += 1;
    const id = nextRequest;
    const request: ExtractRequest = { id, phase };
    awaitingRequest = id;
    replies = [];
    named = new Map();
    namingEvents = 0;
    try {
      node.dispatchEvent(
        new CustomEvent(extractEvent, { detail: JSON.stringify(request), composed: true })
      );
    } catch {
      // A node that refuses the event has nothing more to say about itself.
    } finally {
      awaitingRequest = 0;
    }
    const received = replies;
    const nodes = named;
    replies = [];
    named = new Map();
    for (const text of received) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isPlainObject(parsed) || parsed.id !== id || !Array.isArray(parsed.contributions)) {
        continue;
      }
      for (const entry of parsed.contributions.slice(0, FRAMEWORKS.size)) {
        if (!isPlainObject(entry) || typeof entry.framework !== "string") continue;
        if (!FRAMEWORKS.has(entry.framework) || !isPlainObject(entry.data)) continue;
        adoptRoots(entry.data.componentChain, nodes);
        return entry.data as ExtractorContribution;
      }
      return null;
    }
    return null;
  }

  function describeFor(
    node: Element,
    phase: ExtractionPhase,
    detections: FrameworkDetection[]
  ): ObservationFields {
    const fields: ObservationFields = {
      elementId: idOf(node),
      tagName: clamp(node.localName || "element", LIMITS.tagName),
      label: describe(node),
      bounds: boundsOf(node),
      detections,
      componentChain: { nearestId: null, components: [], truncated: false },
      sourceCandidates: [],
      // Not established, rather than unavailable: with no extractor installed
      // the picker has not looked, and the host may yet install one.
      capabilities: {
        names: { state: "unknown" },
        chain: { state: "unknown" },
        componentSelection: { state: "unknown" },
        file: { state: "unknown" },
        line: { state: "unknown" },
        exactRange: { state: "unknown" },
      },
      frameworkEvidence: [],
    };
    // One framework describes the element, whole: merging two frameworks'
    // chains is a resolver's call to make with both in view, not the page's.
    const contribution = extract(node, phase);
    if (contribution === null) return fields;
    // Each field is taken only in the shape the wire needs, so one malformed
    // field costs that field rather than the whole observation. Deeper rules —
    // ids that resolve, edges without cycles — stay the host's to enforce.
    if (isChainShape(contribution.componentChain)) {
      fields.componentChain = contribution.componentChain;
    }
    if (isObjectArray(contribution.sourceCandidates)) {
      fields.sourceCandidates = contribution.sourceCandidates.slice(0, LIMITS.sourceCandidates);
    }
    if (isObjectArray(contribution.frameworkEvidence)) {
      fields.frameworkEvidence = contribution.frameworkEvidence.slice(0, LIMITS.frameworkEvidence);
    }
    if (isCapabilitiesShape(contribution.capabilities)) {
      fields.capabilities = contribution.capabilities;
    }
    return fields;
  }

  // Hover never walks ancestry: it is paid for on every element the pointer crosses.
  function hoverOf(node: Element): HoverObservation {
    return { phase: "hover", ...describeFor(node, "hover", []) };
  }

  function selectionOf(node: Element, detections: FrameworkDetection[]): SelectionObservation {
    return { phase: "selection", ...describeFor(node, "selection", detections) };
  }

  function emitSelection(cause: "user" | "document" | "reselect"): FrameworkDetection[] {
    const detections = selected === null ? [] : ancestryDetections(selected);
    host.post({
      type: "selectionChanged",
      observations: selected === null ? [] : [selectionOf(selected, detections)],
      cause,
      scope: { kind: "element" },
    });
    return detections;
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

  function select(node: Element | null, cause: "user" | "document" | "reselect"): void {
    selected = node;
    const detections = emitSelection(cause);
    if (cause === "user") reportDetections(detections);
    schedule();
  }

  function setHover(node: Element | null): void {
    if (node === hovered) return;
    hovered = node;
    host.post({ type: "hoverChanged", observation: node === null ? null : hoverOf(node) });
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
    if (selected !== null && !selected.isConnected) select(null, "document");
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
    label.textContent = describe(node);
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
    if (selected !== null) drawBox(layer, selected, "selected", transform);
    if (hovered !== null) {
      if (hovered !== selected) drawBox(layer, hovered, "hover", transform);
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
   * The rendered tree: a host's children are its open shadow root's, and a
   * node's siblings are its actual parent node's — which for the top of a
   * shadow tree is the root, not the host.
   */
  function childrenOf(node: Element): Element[] {
    const root = node.shadowRoot;
    return Array.from((root ?? node).children).filter((child) => !isOverlay(child));
  }

  function siblingsOf(node: Element): Element[] {
    const parent = node.parentNode;
    if (!(parent instanceof Element) && !(parent instanceof ShadowRoot)) return [];
    return Array.from(parent.children).filter((child) => !isOverlay(child));
  }

  /** Arrows walk the rendered tree the way a browser inspector does; Escape lets go. */
  function onKeyDown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    // Keys during composition belong to the IME, never to the picker.
    if (keyboard.isComposing === true || keyboard.keyCode === 229) return;
    if (keyboard.key === "Escape") {
      // Swallowed only when there was a selection to clear; otherwise the host
      // still owns Escape for leaving the picker.
      if (selected === null) return;
      suppress(event);
      select(null, "user");
      return;
    }
    const current = selected;
    if (current === null || !keyboard.key.startsWith("Arrow")) return;
    if (keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey || keyboard.shiftKey) return;
    if (keyTargetsPageControl(event)) return;
    let next: Element | null | undefined;
    if (keyboard.key === "ArrowUp") {
      next = parentAcrossShadow(current);
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
    select(hit, "user");
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
    const next = [document.documentElement, selected, hovered].filter(
      (node): node is Element => node !== null
    );
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
    selected = null;
    schedule();
  }

  function clearHover(): void {
    if (disposed) return;
    pendingHit = undefined;
    setHover(null);
    schedule();
  }

  function refresh(): void {
    if (disposed || selected === null) return;
    emitSelection("reselect");
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
    selected = null;
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
        if (awaitingRequest === 0 || replies.length >= MAX_REPLIES) return;
        const detail = (event as CustomEvent).detail;
        if (typeof detail === "string" && detail.length <= MAX_BRIDGE_MESSAGE_CHARS) {
          replies.push(detail);
        }
      },
      {},
      teardown
    );
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
    refresh,
    dispose,
    getOverlayRoot: () => overlayRoot,
  };
}
