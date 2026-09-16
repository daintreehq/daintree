/// <reference lib="dom" />
import type { GuestEvent, GuestNodeObservation } from "../../shared/protocol.js";
import type {
  GuestBootstrapConfig,
  GuestMode,
  GuestRuntimeHandle,
  GuestTransport,
} from "./types.js";

/** Shape Svelte's dev compiler attaches; every field is treated as untrusted. */
interface SvelteMetaFrame {
  type?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  componentTag?: unknown;
  parent?: unknown;
}

interface SvelteMeta {
  loc?: unknown;
  parent?: unknown;
}

type AncestryFrame = GuestNodeObservation["ancestry"][number];
type SourceLoc = NonNullable<GuestNodeObservation["loc"]>;

/**
 * The whole guest runtime, as one self-contained function.
 *
 * It is serialised by `buildGuestRuntimeBody` (or `buildStandaloneGuestSource`) and evaluated in the page's
 * main world, so it may close over nothing: every helper, constant and type
 * guard lives in this body. That is the reason for the size — splitting it into
 * module-scope helpers would compile fine and break the moment it is injected.
 */
export function createSiteBuilderGuest(
  config: GuestBootstrapConfig,
  transport?: GuestTransport
): GuestRuntimeHandle {
  // The host injects on every new document, which includes every subframe. A
  // child frame would emit its own sequence under the same session id, and the
  // protocol has no way to say which frame spoke — so only the top one runs.
  if (window.top !== window.self) {
    return {
      setMode: () => {},
      getMode: () => config.mode,
      refresh: () => {},
      dispose: () => {},
      getOverlayRoot: () => null,
    };
  }

  const MAX_NODES = 32;
  const MAX_ANCESTRY = 64;
  const MAX_BOUNDS = 32;
  const MAX_LABEL = 200;
  const MAX_FILE = 1024;
  const MAX_TYPE = 32;
  const MAX_TAG = 64;
  const MAX_COMPONENT_TAG = 128;
  const MAX_URL = 2048;
  const MAX_DETAIL = 512;
  const MAX_SAME_LOC = 100_000;
  const MAX_MESSAGE_BYTES = 256 * 1024;
  /** Bounds the "is this a dev build" sweep on a huge document. */
  const AUDIT_SCAN_LIMIT = 20_000;
  /** Parent links walked per observation, however few of them are usable. */
  const MAX_ANCESTRY_LINKS = 512;
  /** Side of the transform probe, in the page's own fixed-position pixels. */
  const PROBE_SIZE = 100;

  const scope = globalThis as unknown as Record<string, unknown>;
  /**
   * Sequence and occurrence ids are document-scoped, and the host validates the
   * sequence against the epoch — so a re-injection into the *same* document has
   * to carry on counting rather than replay numbers the host already saw.
   */
  const stateKey = config.handleName + ".state";
  const carried = scope[stateKey] as
    { documentEpoch: number; sequence: number; occurrence: number } | undefined;
  const resumed =
    carried !== undefined && carried.documentEpoch === config.documentEpoch
      ? carried
      : { documentEpoch: config.documentEpoch, sequence: 0, occurrence: 0 };
  scope[stateKey] = resumed;

  let mode: GuestMode = config.mode;
  let sequence = resumed.sequence;
  let disposed = false;
  let auditDone = false;
  let hovered: Element | null = null;
  let hoveredMapping: boolean | null = null;
  let lastHit: Element | null = null;
  /**
   * Both ends are kept: the target is what is outlined and re-resolved, the hit
   * is the node the pointer actually landed on, which is the only thing that
   * can tell the host the region was `{@html}` or canvas rather than markup.
   */
  let selection: Array<{ target: Element; hit: Element }> = [];
  let overlayHost: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let overlayLayer: HTMLElement | null = null;
  let overlayProbe: HTMLElement | null = null;
  let paintHandle = 0;
  let trackTargets: ((nodes: Element[]) => void) | null = null;
  let occurrenceCounter = resumed.occurrence;

  const occurrenceIds = new WeakMap<Element, string>();
  const locCounts = new Map<string, number>();
  const teardown: Array<() => void> = [];
  const selectTeardown: Array<() => void> = [];

  const suffix = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  /** A custom-element name, so a page rule like `body > div` cannot match us. */
  const overlayTagName = "daintree-site-overlay-" + suffix;

  function clamp(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }

  // Safe-integer, not just integer: the host's schema rejects 2**53 and a
  // whole observation would be dropped for one bad number.
  function positiveInt(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function nonNegativeInt(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function finite(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }

  function nonEmptyString(value: unknown, max: number): string | null {
    return typeof value === "string" && value.length > 0 ? clamp(value, max) : null;
  }

  function readMeta(node: Element): SvelteMeta | null {
    const meta = (node as unknown as { __svelte_meta?: unknown }).__svelte_meta;
    return meta !== null && typeof meta === "object" ? (meta as SvelteMeta) : null;
  }

  function readLoc(node: Element): SourceLoc | null {
    const meta = readMeta(node);
    if (meta === null || meta.loc === null || typeof meta.loc !== "object") return null;
    const raw = meta.loc as SvelteMetaFrame;
    // A source path is identity, not display text: a clamped one would name a
    // different file. Report it whole or not at all.
    const file = typeof raw.file === "string" && raw.file.length > 0 ? raw.file : null;
    const line = positiveInt(raw.line);
    const column = nonNegativeInt(raw.column);
    if (file === null || line === null || column === null) return null;
    return { file, line, column };
  }

  function locKey(loc: SourceLoc): string {
    return loc.file + ":" + loc.line + ":" + loc.column;
  }

  /** Walks out of shadow roots too, so a slotted node still names an owner. */
  function parentOf(node: Element): Element | null {
    if (node.parentElement !== null) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function nearestMapped(start: Element | null): Element | null {
    let node: Element | null = start;
    while (node !== null) {
      if (readLoc(node) !== null) return node;
      node = parentOf(node);
    }
    return null;
  }

  function byteLength(text: string): number {
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
  }

  function send(event: GuestEvent): boolean {
    if (disposed) return false;
    // Measured as the full envelope even when the host builds it, because the
    // host drops an oversized envelope whole — the size the page can control is
    // the event, but the ceiling applies to what finally crosses the binding.
    // Behind a transport the prelude numbers the envelope independently, so the
    // widest sequence it could write is reserved: measuring with the local
    // counter let a selection pass this check and still be dropped by the host
    // one byte over, with no issue reported and the guest believing it was sent.
    const payload = JSON.stringify({
      protocolVersion: config.protocolVersion,
      sessionId: config.sessionId,
      documentEpoch: config.documentEpoch,
      sequence: transport ? Number.MAX_SAFE_INTEGER : sequence,
      event,
    });
    if (byteLength(payload) > MAX_MESSAGE_BYTES) {
      if (event.type !== "runtimeIssue") {
        issue("internal", "dropped an oversized " + event.type + " envelope");
      }
      return false;
    }
    if (transport) {
      // The prelude numbers the envelope; a local count here would drift from it.
      transport.post(event);
      return true;
    }
    const sink = scope[config.bindingName];
    if (typeof sink !== "function") return false;
    sequence += 1;
    resumed.sequence = sequence;
    (sink as (message: string) => void)(payload);
    return true;
  }

  function issue(
    code: "no-svelte-meta" | "not-dev-build" | "overlay-blocked" | "internal",
    detail: string
  ): void {
    send({ type: "runtimeIssue", code, detail: clamp(detail, MAX_DETAIL) });
  }

  function readAncestry(node: Element): { frames: AncestryFrame[]; truncated: boolean } {
    const frames: AncestryFrame[] = [];
    const seen = new Set<object>();
    const meta = readMeta(node);
    let current: unknown = meta === null ? null : meta.parent;
    let truncated = false;
    // Links walked, not frames kept: a chain of malformed entries would
    // otherwise cost an unbounded walk for an empty result.
    let visited = 0;
    while (current !== null && typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
      visited += 1;
      if (frames.length >= MAX_ANCESTRY || visited > MAX_ANCESTRY_LINKS) {
        truncated = true;
        break;
      }
      const raw = current as SvelteMetaFrame;
      const type = nonEmptyString(raw.type, MAX_TYPE);
      const file =
        typeof raw.file === "string" && raw.file.length > 0 && raw.file.length <= MAX_FILE
          ? raw.file
          : null;
      const line = positiveInt(raw.line);
      const column = nonNegativeInt(raw.column);
      if (type !== null && file !== null && line !== null && column !== null) {
        const componentTag = nonEmptyString(raw.componentTag, MAX_COMPONENT_TAG);
        frames.push(
          componentTag === null
            ? { type, file, line, column }
            : { type, file, line, column, componentTag }
        );
      }
      current = raw.parent;
    }
    return { frames, truncated };
  }

  /**
   * How many live elements share this markup. Without it the inspector would
   * offer "this element only" for a line that renders every card on the page.
   */
  function countSameLoc(loc: SourceLoc): number {
    const key = locKey(loc);
    const cached = locCounts.get(key);
    if (cached !== undefined) return cached;
    let count = 0;
    const all = document.getElementsByTagName("*");
    for (let index = 0; index < all.length; index += 1) {
      const element = all[index];
      if (element === undefined) continue;
      const other = readLoc(element);
      if (
        other !== null &&
        other.file === loc.file &&
        other.line === loc.line &&
        other.column === loc.column
      ) {
        count += 1;
      }
    }
    const bounded = Math.min(Math.max(count, 1), MAX_SAME_LOC);
    locCounts.set(key, bounded);
    return bounded;
  }

  function occurrenceId(node: Element): string {
    const existing = occurrenceIds.get(node);
    if (existing !== undefined) return existing;
    occurrenceCounter += 1;
    resumed.occurrence = occurrenceCounter;
    const id = "occ-" + occurrenceCounter;
    occurrenceIds.set(node, id);
    return id;
  }

  function describe(node: Element): string {
    let label = node.tagName.toLowerCase();
    const id = node.getAttribute("id");
    if (id !== null && id.length > 0) label += "#" + id;
    const classAttr = node.getAttribute("class");
    if (classAttr !== null) {
      const classes = classAttr.split(/\s+/).filter((entry) => entry.length > 0);
      for (const entry of classes.slice(0, 2)) label += "." + entry;
    }
    return clamp(label, MAX_LABEL);
  }

  function boundsOf(node: Element): GuestNodeObservation["bounds"] {
    const rects = node.getClientRects();
    const out: GuestNodeObservation["bounds"] = [];
    for (let index = 0; index < rects.length && out.length < MAX_BOUNDS; index += 1) {
      const rect = rects[index];
      if (rect === undefined) continue;
      out.push({
        x: rect.left,
        y: rect.top,
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      });
    }
    if (out.length === 0) {
      const rect = node.getBoundingClientRect();
      out.push({
        x: rect.left,
        y: rect.top,
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      });
    }
    return out;
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
   * Visual-only regions. The common case is the first one: Svelte's dev build
   * marks every element it compiled, so an element with no mark of its own came
   * from `{@html}`, a third-party widget, or the host page's own scripting.
   */
  /**
   * A closed shadow root retargets the event to its host, so the real hit is
   * unreachable — an upgraded custom element with no open root is reported as
   * visual-only rather than as its own markup, which would be a lie about what
   * the click landed on.
   */
  function hidesItsOwnContent(node: Element): boolean {
    if (node.shadowRoot !== null) return false;
    const name = node.tagName.toLowerCase();
    return name.indexOf("-") !== -1 && customElements.get(name) !== undefined;
  }

  function isUnmapped(hit: Element): boolean {
    if (hit.getRootNode() !== hit.ownerDocument) return true;
    if (hit.tagName === "CANVAS" || hit.closest("canvas") !== null) return true;
    if (isCrossOriginFrame(hit)) return true;
    if (hidesItsOwnContent(hit)) return true;
    return readLoc(hit) === null;
  }

  function observe(hit: Element): GuestNodeObservation {
    const target = nearestMapped(hit) ?? hit;
    const loc = readLoc(target);
    const ancestry = readAncestry(target);
    if (ancestry.truncated) {
      issue(
        "internal",
        "ancestry truncated to " + MAX_ANCESTRY + " frames for " + describe(target)
      );
    }
    return {
      runtimeOccurrenceId: occurrenceId(target),
      loc,
      ancestry: ancestry.frames,
      tagName: clamp(target.tagName.toLowerCase(), MAX_TAG),
      sameLocCount: loc === null ? 1 : countSameLoc(loc),
      label: describe(target),
      bounds: boundsOf(target),
      unmapped: isUnmapped(hit),
    };
  }

  const ACCENT = "56, 152, 236";

  function ensureOverlay(): void {
    if (overlayHost !== null && overlayHost.isConnected) return;
    const parent = document.body ?? document.documentElement;
    if (parent === null) return;
    const host = document.createElement(overlayTagName);
    host.setAttribute("aria-hidden", "true");
    // Inline + !important so no page rule can move it, and zero-sized fixed so
    // it cannot contribute a scrollbar or shift a single line of the page.
    const fixed: Array<[string, string]> = [
      ["position", "fixed"],
      ["top", "0"],
      ["left", "0"],
      ["width", "0"],
      ["height", "0"],
      ["margin", "0"],
      ["padding", "0"],
      ["border", "0"],
      ["opacity", "1"],
      ["visibility", "visible"],
      ["display", "block"],
      ["pointer-events", "none"],
      ["z-index", "2147483647"],
    ];
    for (const [property, value] of fixed) host.style.setProperty(property, value, "important");
    let root: ShadowRoot;
    try {
      // Closed: the page can still see that an element was added, but it
      // cannot read or rewrite what is inside it through `host.shadowRoot`.
      root = host.attachShadow({ mode: "closed" });
    } catch {
      issue("overlay-blocked", "the page refused a shadow root for the overlay");
      return;
    }
    const layer = document.createElement("div");
    root.appendChild(layer);
    // A fixed 100x100 probe reads back the transform the page's own <body>
    // imposes on our fixed children — scale included, which subtracting an
    // origin cannot correct.
    const probe = document.createElement("div");
    style(probe, [
      ["position", "fixed"],
      ["top", "0"],
      ["left", "0"],
      ["width", PROBE_SIZE + "px"],
      ["height", PROBE_SIZE + "px"],
      ["pointer-events", "none"],
      ["visibility", "hidden"],
    ]);
    root.appendChild(probe);
    parent.appendChild(host);
    overlayHost = host;
    overlayRoot = root;
    overlayLayer = layer;
    overlayProbe = probe;
  }

  function style(node: HTMLElement, declarations: Array<[string, string]>): void {
    // Set through the CSSOM rather than a stylesheet or a style attribute:
    // neither `style-src` nor `style-src-attr` can take this away, so a strict
    // CSP costs the overlay its looks at worst, never its position.
    for (const [property, value] of declarations) node.style.setProperty(property, value);
  }

  function clearOverlay(): void {
    if (overlayLayer !== null) overlayLayer.textContent = "";
  }

  function removeOverlay(): void {
    if (overlayHost !== null) overlayHost.remove();
    overlayHost = null;
    overlayRoot = null;
    overlayLayer = null;
    overlayProbe = null;
  }

  interface Transform {
    originX: number;
    originY: number;
    scale: number;
  }

  /** How the page's containing block moves and scales our fixed children. */
  function readTransform(host: HTMLElement, probe: HTMLElement | null): Transform {
    const origin = host.getBoundingClientRect();
    let scale = 1;
    if (probe !== null) {
      const measured = probe.getBoundingClientRect();
      if (measured.width > 0) scale = measured.width / PROBE_SIZE;
    }
    return {
      originX: finite(origin.left),
      originY: finite(origin.top),
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    };
  }

  function drawBox(layer: HTMLElement, rect: DOMRect, kind: string, transform: Transform): void {
    // Clamped to the viewport: a box the page has scrolled away could otherwise
    // extend the transformed body's scrollable overflow and add a scrollbar.
    const left = Math.max(0, finite(rect.left));
    const top = Math.max(0, finite(rect.top));
    const right = Math.min(innerWidth, finite(rect.right));
    const bottom = Math.min(innerHeight, finite(rect.bottom));
    if (right <= left || bottom <= top) return;
    const box = document.createElement("div");
    const outline = kind === "selected" ? "2px" : "1px";
    const alpha = kind === "selected" ? "0.14" : "0.08";
    style(box, [
      ["position", "fixed"],
      ["box-sizing", "border-box"],
      ["pointer-events", "none"],
      ["left", (left - transform.originX) / transform.scale + "px"],
      ["top", (top - transform.originY) / transform.scale + "px"],
      ["width", (right - left) / transform.scale + "px"],
      ["height", (bottom - top) / transform.scale + "px"],
      ["outline", outline + " solid rgba(" + ACCENT + ", 0.9)"],
      ["background", "rgba(" + ACCENT + ", " + alpha + ")"],
    ]);
    layer.appendChild(box);
  }

  function drawElement(
    layer: HTMLElement,
    node: Element,
    kind: string,
    transform: Transform
  ): void {
    const rects = node.getClientRects();
    let drawn = 0;
    for (let index = 0; index < rects.length && drawn < MAX_BOUNDS; index += 1) {
      const rect = rects[index];
      if (rect === undefined) continue;
      drawBox(layer, rect, kind, transform);
      drawn += 1;
    }
    if (drawn === 0) drawBox(layer, node.getBoundingClientRect(), kind, transform);
  }

  function drawLabel(layer: HTMLElement, node: Element, transform: Transform): void {
    const rect = node.getBoundingClientRect();
    const label = document.createElement("div");
    label.textContent = describe(node);
    style(label, [
      ["position", "fixed"],
      ["pointer-events", "none"],
      ["transform", "translateY(-100%)"],
      ["left", (finite(rect.left) - transform.originX) / transform.scale + "px"],
      ["top", (finite(rect.top) - transform.originY) / transform.scale + "px"],
      ["font", "500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace"],
      ["color", "#fff"],
      ["background", "rgba(" + ACCENT + ", 1)"],
      ["padding", "0 4px"],
      ["border-radius", "2px"],
      ["white-space", "nowrap"],
      ["max-width", "60vw"],
      ["overflow", "hidden"],
      ["text-overflow", "ellipsis"],
    ]);
    layer.appendChild(label);
  }

  function paint(): void {
    if (disposed) return;
    if (mode !== "select") {
      clearOverlay();
      return;
    }
    // An HMR update replaces nodes outright; a detached one has no geometry
    // worth drawing and must not be kept alive by the overlay.
    const live = selection.filter((entry) => entry.target.isConnected && entry.hit.isConnected);
    if (live.length !== selection.length) {
      selection = live;
      emitSelection();
    }
    if (hovered !== null && !hovered.isConnected) {
      hovered = null;
      hoveredMapping = null;
    }
    ensureOverlay();
    const layer = overlayLayer;
    const host = overlayHost;
    if (layer === null || host === null) return;
    layer.textContent = "";
    const transform = readTransform(host, overlayProbe);
    if (hovered !== null && selection.every((entry) => entry.target !== hovered)) {
      drawElement(layer, hovered, "hover", transform);
      drawLabel(layer, hovered, transform);
    }
    for (const entry of selection) drawElement(layer, entry.target, "selected", transform);
    if (trackTargets !== null) {
      const tracked = selection.map((entry) => entry.target);
      if (hovered !== null) tracked.push(hovered);
      trackTargets(tracked);
    }
  }

  function schedulePaint(): void {
    if (disposed || paintHandle !== 0) return;
    paintHandle = requestAnimationFrame(() => {
      paintHandle = 0;
      paint();
    });
  }

  /**
   * Per-node caps do not add up to a legal envelope, so the whole selection is
   * budgeted before it is committed: full first, then with ancestry shortened
   * and said so, and if even that will not fit the caller keeps its old
   * selection rather than leaving the host looking at a different one.
   */
  function emitSelection(): boolean {
    const nodes = selection.map((entry) => observe(entry.hit));
    if (send({ type: "selectionChanged", nodes })) return true;
    const trimmed = nodes.map((node) => ({ ...node, ancestry: node.ancestry.slice(0, 4) }));
    if (send({ type: "selectionChanged", nodes: trimmed })) {
      issue("internal", "ancestry shortened to fit the selection into one envelope");
      return true;
    }
    return false;
  }

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

  function hitFromEvent(event: Event): Element | null {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const first = path.length > 0 ? path[0] : event.target;
    if (first instanceof Element) return first;
    return null;
  }

  function isOverlay(node: Element | null): boolean {
    if (node === null || overlayHost === null) return false;
    if (node === overlayHost || overlayHost.contains(node)) return true;
    return overlayRoot !== null && node.getRootNode() === overlayRoot;
  }

  function suppress(event: Event): void {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  function onPointerMove(event: Event): void {
    const hit = hitFromEvent(event);
    if (hit === lastHit) return;
    lastHit = hit;
    const target = hit === null || isOverlay(hit) ? null : (nearestMapped(hit) ?? hit);
    const mapping = hit === null || target === null ? null : isUnmapped(hit);
    // Moving from a container into its own `{@html}` child keeps the outline
    // but changes the answer, so the report is keyed on both.
    if (target === hovered && mapping === hoveredMapping) return;
    hovered = target;
    hoveredMapping = mapping;
    schedulePaint();
    // Reported on change only, never per pointer move: the outline is drawn
    // locally, so pointing at things costs the host nothing.
    send({ type: "hoverChanged", node: hit === null || target === null ? null : observe(hit) });
  }

  function onPointerLeave(event: Event): void {
    if (event.target !== document && event.target !== document.documentElement) return;
    if (hovered === null && lastHit === null) return;
    hovered = null;
    hoveredMapping = null;
    lastHit = null;
    schedulePaint();
    send({ type: "hoverChanged", node: null });
  }

  function onSelectClick(event: Event): void {
    suppress(event);
    const hit = hitFromEvent(event);
    if (hit === null || isOverlay(hit)) return;
    const target = nearestMapped(hit) ?? hit;
    const mouse = event as MouseEvent;
    const additive = mouse.metaKey === true || mouse.ctrlKey === true;
    const previous = selection;
    if (additive) {
      const existing = selection.some((entry) => entry.target === target);
      if (existing) {
        selection = selection.filter((entry) => entry.target !== target);
      } else {
        if (selection.length >= MAX_NODES) {
          issue("internal", "multi-selection capped at " + MAX_NODES + " nodes");
          return;
        }
        selection = selection.concat([{ target, hit }]);
      }
    } else {
      selection = [{ target, hit }];
    }
    if (!emitSelection()) {
      selection = previous;
      issue("internal", "selection left unchanged: the observation did not fit one envelope");
    }
    schedulePaint();
  }

  function onKeyDown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    // Escape during composition belongs to the IME, never to the inspector.
    if (keyboard.isComposing === true || keyboard.keyCode === 229) return;
    if (keyboard.key !== "Escape" || selection.length === 0) return;
    // Only swallow Escape when it had something of ours to clear; otherwise the
    // host still owns it for leaving Select mode.
    suppress(event);
    selection = [];
    emitSelection();
    schedulePaint();
  }

  function onGeometryChange(): void {
    schedulePaint();
  }

  function attachSelectListeners(): void {
    if (selectTeardown.length > 0) return;
    const capture: AddEventListenerOptions = { capture: true };
    // Every activating event, stopped at the earliest point in the page: a
    // click must identify a target without following the link under it.
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
      "dragstart",
    ]) {
      const handler = type === "click" ? onSelectClick : suppress;
      listen(window, type, handler, capture, selectTeardown);
    }
    listen(window, "keydown", onKeyDown, capture, selectTeardown);
    const passiveCapture: AddEventListenerOptions = { capture: true, passive: true };
    listen(window, "pointermove", onPointerMove, passiveCapture, selectTeardown);
    listen(document, "pointerleave", onPointerLeave, passiveCapture, selectTeardown);
    listen(window, "scroll", onGeometryChange, passiveCapture, selectTeardown);
    listen(window, "resize", onGeometryChange, { passive: true }, selectTeardown);

    // Layout can move under us with no event at all — an image finishing, a
    // font swapping, an HMR patch. Both observers are bounded and disconnected
    // with the mode; neither sees our own overlay, which lives in a shadow root.
    const mutations = new MutationObserver((records) => {
      // Only structure changes what a source location renders; a class flip
      // moves geometry and nothing else.
      for (const record of records) {
        if (record.type === "childList") {
          locCounts.clear();
          break;
        }
      }
      auditMapping();
      schedulePaint();
    });
    mutations.observe(document.documentElement ?? document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    selectTeardown.push(() => mutations.disconnect());

    if (typeof ResizeObserver === "function") {
      const resizes = new ResizeObserver(() => schedulePaint());
      const observeRoot = () => {
        if (document.documentElement !== null) resizes.observe(document.documentElement);
      };
      observeRoot();
      // Watching the targets themselves catches what a root-sized observer
      // cannot: an image arriving inside a fixed-height container.
      trackTargets = (nodes) => {
        resizes.disconnect();
        observeRoot();
        for (const node of nodes) resizes.observe(node);
      };
      selectTeardown.push(() => {
        trackTargets = null;
        resizes.disconnect();
      });
    }
  }

  function detachSelectListeners(): void {
    while (selectTeardown.length > 0) {
      const off = selectTeardown.pop();
      if (off !== undefined) off();
    }
  }

  /** `found` and `complete` are separate: an unfinished scan proves nothing. */
  function scanForSvelteMeta(): { found: boolean; complete: boolean } {
    const all = document.getElementsByTagName("*");
    const limit = Math.min(all.length, AUDIT_SCAN_LIMIT);
    for (let index = 0; index < limit; index += 1) {
      const element = all[index];
      if (element !== undefined && readLoc(element) !== null)
        return { found: true, complete: true };
    }
    return { found: false, complete: all.length <= AUDIT_SCAN_LIMIT };
  }

  function looksLikeDevServer(): boolean {
    if (document.querySelector('script[src*="/@vite/client"]') !== null) return true;
    const scope = globalThis as unknown as Record<string, unknown>;
    return (
      scope.__vite_plugin_react_preamble_installed__ !== undefined || scope.__vite__ !== undefined
    );
  }

  /**
   * Without `__svelte_meta` there is nothing to inspect. Saying so is the whole
   * point: a silent dead inspector reads as a bug in Daintree.
   */
  function auditMapping(): void {
    if (auditDone || disposed) return;
    const scan = scanForSvelteMeta();
    if (scan.found) {
      auditDone = true;
      return;
    }
    // A page that has not finished hydrating, or a document too big to sweep,
    // is not evidence of a production build. Stay silent and look again.
    if (!scan.complete || document.readyState !== "complete") return;
    auditDone = true;
    if (looksLikeDevServer()) {
      issue(
        "no-svelte-meta",
        "the dev server is running but no element carries Svelte dev metadata"
      );
    } else {
      issue(
        "not-dev-build",
        "this page has no Svelte dev metadata; it looks like a production build"
      );
    }
  }

  function emitDocumentReady(): void {
    const scale =
      typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    send({
      type: "documentReady",
      // The host owns route identity; the guest reports only what it can see.
      routeId: null,
      url: clamp(location.href, MAX_URL),
      viewport: {
        width: Math.max(1, Math.round(innerWidth)),
        height: Math.max(1, Math.round(innerHeight)),
        deviceScaleFactor: scale,
      },
    });
    auditMapping();
  }

  function setMode(next: GuestMode): void {
    if (disposed || next === mode) return;
    mode = next;
    if (next === "select") {
      // Anything could have changed while we were not watching.
      locCounts.clear();
      selection = selection.filter((entry) => entry.target.isConnected && entry.hit.isConnected);
      attachSelectListeners();
      auditMapping();
      schedulePaint();
      return;
    }
    // Browse leaves nothing behind: no listeners, no observers, no overlay.
    detachSelectListeners();
    hovered = null;
    hoveredMapping = null;
    lastHit = null;
    locCounts.clear();
    if (paintHandle !== 0) {
      cancelAnimationFrame(paintHandle);
      paintHandle = 0;
    }
    removeOverlay();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    detachSelectListeners();
    while (teardown.length > 0) {
      const off = teardown.pop();
      if (off !== undefined) off();
    }
    if (paintHandle !== 0) {
      cancelAnimationFrame(paintHandle);
      paintHandle = 0;
    }
    removeOverlay();
    selection = [];
    hovered = null;
    hoveredMapping = null;
    lastHit = null;
    if (scope[config.handleName] === handle) delete scope[config.handleName];
  }

  const handle: GuestRuntimeHandle = {
    setMode,
    getMode: () => mode,
    getOverlayRoot: () => overlayRoot,
    refresh: () => {
      if (paintHandle !== 0) {
        cancelAnimationFrame(paintHandle);
        paintHandle = 0;
      }
      locCounts.clear();
      paint();
    },
    dispose,
  };

  // Activation is all-or-nothing. A half-installed runtime at document start —
  // suppressing listeners attached, no handle published — would swallow the
  // page's clicks with nothing able to undo it.
  try {
    if (document.readyState === "loading") {
      listen(document, "DOMContentLoaded", () => emitDocumentReady(), { once: true }, teardown);
    } else {
      emitDocumentReady();
    }
    if (mode === "select") attachSelectListeners();
  } catch (error) {
    issue("internal", "guest activation failed: " + String(error));
    dispose();
  }

  return handle;
}
