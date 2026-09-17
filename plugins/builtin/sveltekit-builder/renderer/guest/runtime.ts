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
      reselect: () => false,
      clearSelection: () => {},
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
  /** Stamped elements the capability probe looks at before it answers. */
  const METADATA_PROBE_SAMPLE = 64;
  /**
   * How long a finished document has to stay without dev metadata before the
   * guest says so. SvelteKit hydrates after `load`: its entry is a chain of
   * dev-server module fetches, so `readyState === "complete"` arrives while the
   * server-rendered markup still has no `__svelte_meta`.
   */
  const AUDIT_SETTLE_MS = 2_500;
  /** A page that is visibly served by Vite gets longer to hydrate on a cold start. */
  const AUDIT_DEV_SETTLE_MS = 15_000;
  /** Parent links walked per observation, however few of them are usable. */
  const MAX_ANCESTRY_LINKS = 512;
  /** Levels a structural path may run, and siblings a level may be counted over. */
  const MAX_STRUCTURE_DEPTH = 64;
  const MAX_STRUCTURE_SIBLINGS = 5_000;
  /** Occurrence entries kept before dead ones are swept. */
  const MAX_OCCURRENCE_ENTRIES = 2_000;
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
  let auditTimer: ReturnType<typeof setTimeout> | null = null;
  let auditStartedAt = 0;
  /** Reported once per document, the first time stamped elements are seen. */
  let metadataProbed = false;
  /** Stamped elements exist, readable or not — the absence verdict is then wrong. */
  let stampsSeen = false;
  /** The page as last reported in `documentReady`; empty until the first report. */
  let reportedPage = "";
  let hovered: Element | null = null;
  let hoveredMapping: boolean | null = null;
  let lastHit: Element | null = null;
  /**
   * Both ends are kept: the target is what is outlined and re-resolved, the hit
   * is the node the pointer actually landed on, which is the only thing that
   * can tell the host the region was `{@html}` or canvas rather than markup.
   */
  let selection: Array<{ target: Element; hit: Element }> = [];
  /** Whether the selection is one element or a whole component's rendered roots. */
  let selectionScope: "element" | "component" = "element";
  /** The component invocation a component selection stands for, for stepping outward. */
  let selectedFrame: object | null = null;
  let trackedTargets: Element[] = [];
  let overlayHost: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let overlayLayer: HTMLElement | null = null;
  let overlayProbe: HTMLElement | null = null;
  let paintHandle = 0;
  let trackTargets: ((nodes: Element[]) => void) | null = null;
  let occurrenceCounter = resumed.occurrence;

  const occurrenceIds = new WeakMap<Element, string>();
  /**
   * The other direction, for the host to ask for an element by the id it was
   * reported under. A location cannot always do that: on a hydrated page the
   * element's true location is stamped on a neighbour. Weak, so a replaced
   * node is not kept alive by the map; a replaced node is not the same
   * element and is not returned.
   */
  const elementsByOccurrence = new Map<string, WeakRef<Element>>();
  const locCounts = new Map<string, { count: number; partial: boolean }>();
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

  /**
   * The component invocation that rendered a node: the first `component` frame
   * on its Svelte parent chain. Svelte builds one frame object per invocation,
   * so identity — not file and line — tells two cards drawn by one line apart.
   */
  function componentFrames(node: Element): object[] {
    const frames: object[] = [];
    // An unstamped element placed by shape belongs to its nearest stamped
    // ancestor's template, and so to its invocations.
    const meta = readMeta(node) ?? readMeta(nearestMapped(node) ?? node);
    let current: unknown = meta === null ? null : meta.parent;
    const seen = new Set<object>();
    let visited = 0;
    while (current !== null && typeof current === "object" && visited < MAX_ANCESTRY_LINKS) {
      if (seen.has(current)) break;
      seen.add(current);
      visited += 1;
      const raw = current as SvelteMetaFrame;
      if (raw.type === "component") frames.push(current);
      current = raw.parent;
    }
    return frames;
  }

  function componentName(frame: object | null): string | null {
    if (frame === null) return null;
    const raw = frame as SvelteMetaFrame;
    const tag = nonEmptyString(raw.componentTag, MAX_COMPONENT_TAG);
    if (tag !== null) return tag;
    return null;
  }

  function validFile(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_FILE ? value : null;
  }

  /**
   * Where a selected invocation is used and what it is called. Where the
   * component is written is deliberately not read off the chain: a snippet
   * passed in, a wrapper with no element of its own or a dropped frame all make
   * the chain name a plausible wrong file. Main reads that from source.
   */
  function componentIdentity(
    frame: object
  ): { file: string; line: number; column: number; name: string } | null {
    const raw = frame as SvelteMetaFrame;
    const file = validFile(raw.file);
    const line = positiveInt(raw.line);
    const column = nonNegativeInt(raw.column);
    const name = componentName(frame);
    if (file === null || line === null || column === null || name === null) return null;
    return { file, line, column, name };
  }

  /** The outermost connected elements a component invocation rendered. */
  function componentRoots(frame: object, start: Element): Element[] {
    const belongs = (node: Element): boolean =>
      readLoc(node) !== null && componentFrames(node).includes(frame);
    let root: Element = start;
    let parent = parentOf(root);
    while (parent !== null && belongs(parent)) {
      root = parent;
      parent = parentOf(root);
    }
    const container = parentOf(root);
    if (container === null) return [root];
    const roots: Element[] = [];
    for (const child of Array.from(container.children)) {
      if (child === root || belongs(child)) roots.push(child);
      if (roots.length >= MAX_NODES) break;
    }
    return roots.length > 0 ? roots : [root];
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
  function sameLocOf(loc: SourceLoc | null): { sameLocCount: number; sameLocCountPartial?: true } {
    if (loc === null) return { sameLocCount: 1 };
    const { count, partial } = countSameLoc(loc);
    return partial ? { sameLocCount: count, sameLocCountPartial: true } : { sameLocCount: count };
  }

  function countSameLoc(loc: SourceLoc): { count: number; partial: boolean } {
    const key = locKey(loc);
    const cached = locCounts.get(key);
    if (cached !== undefined) return cached;
    let count = 0;
    const all = document.getElementsByTagName("*");
    // Bounded like every other sweep. Past the bound the count is a floor, and
    // says so: one copy counted is not proof the markup is unique.
    const limit = Math.min(all.length, AUDIT_SCAN_LIMIT);
    for (let index = 0; index < limit; index += 1) {
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
    const result = {
      count: Math.min(Math.max(count, 1), MAX_SAME_LOC),
      partial: all.length > AUDIT_SCAN_LIMIT,
    };
    locCounts.set(key, result);
    return result;
  }

  function occurrenceId(node: Element): string {
    const existing = occurrenceIds.get(node);
    if (existing !== undefined) return existing;
    occurrenceCounter += 1;
    resumed.occurrence = occurrenceCounter;
    const id = "occ-" + occurrenceCounter;
    occurrenceIds.set(node, id);
    if (typeof WeakRef === "function") {
      // The refs let go of replaced nodes; the entries would not.
      if (elementsByOccurrence.size >= MAX_OCCURRENCE_ENTRIES) {
        for (const [key, ref] of elementsByOccurrence) {
          const held = ref.deref();
          if (held === undefined || !held.isConnected) elementsByOccurrence.delete(key);
        }
      }
      elementsByOccurrence.set(id, new WeakRef(node));
    }
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

  function isUnmapped(hit: Element, ignoringStamp = false): boolean {
    if (hit.getRootNode() !== hit.ownerDocument) return true;
    if (hit.tagName === "CANVAS" || hit.closest("canvas") !== null) return true;
    if (isCrossOriginFrame(hit)) return true;
    if (hidesItsOwnContent(hit)) return true;
    return !ignoringStamp && readLoc(hit) === null;
  }

  /**
   * Where a node sits in its template, by shape rather than by the location
   * stamped on it. Svelte assigns `loc` by walking a template's rendered
   * siblings, and on a hydrated page that walk also meets the root a child
   * component rendered just before — so from there on every element carries
   * its neighbour's location, and the last ones carry none. The frame
   * (`__svelte_meta.parent`, one object per block or invocation) and each
   * element's index among the siblings that share it are not assigned that
   * way, and the host can walk the source by them.
   *
   * Siblings of another frame — a child component's root, a block's
   * contents — are not this template's elements and are not counted. An
   * unstamped element is counted as the template's own only where the
   * hydration walk leaves them: a trailing run after stamped siblings of the
   * frame, or anywhere under a parent that is itself unstamped; a stamped
   * sibling after an unstamped one means the unstamped one is not the
   * template's, and nothing is reported.
   */
  /**
   * What lies between `frame` and `ancestor` on the parent chain: nothing but
   * blocks, a component frame, or a `{@render}` — or no `ancestor` at all.
   * A rendered snippet is the one region Svelte's server output does not
   * bracket, so the template around it walks straight through the snippet's
   * elements while stamping its own: everything after such a region may carry
   * the wrong location and the wrong frame, and nothing at that level can be
   * placed by shape.
   */
  function framesBetween(
    frame: unknown,
    ancestor: unknown
  ): "blocks" | "component" | "render" | "none" {
    let current: unknown = frame;
    let rendered = false;
    let component = false;
    for (let hops = 0; hops < MAX_ANCESTRY_LINKS; hops += 1) {
      if (current === ancestor) return rendered ? "render" : component ? "component" : "blocks";
      if (current === null || current === undefined || typeof current !== "object") return "none";
      const raw = current as SvelteMetaFrame;
      // The sibling's own frame counts when it is a rendered snippet's: that
      // element was rendered inline here, and the walk went through it. Its
      // own component frame does not: a child component's root is expected.
      if (raw.type === "render" || raw.type === "snippet") rendered = true;
      else if (hops > 0 && raw.type === "component") component = true;
      current = raw.parent;
    }
    return "none";
  }

  function structureOf(target: Element): GuestNodeObservation["structure"] | undefined {
    // A page can put a throwing getter on `__svelte_meta`; the shape is an
    // extra, and a click must not die for it.
    try {
      return structurePath(target);
    } catch {
      return undefined;
    }
  }

  function structurePath(target: Element): GuestNodeObservation["structure"] | undefined {
    // `<svelte:head>` renders into the head, where the template's order says nothing.
    const head = target.ownerDocument.head;
    if (head !== null && head.contains(target)) return undefined;
    // The nearest stamped element: the target itself, or the ancestor an
    // unstamped target takes its template and frame from.
    const anchor = nearestMapped(target);
    if (anchor === null) return undefined;
    const anchorLoc = readLoc(anchor);
    const meta = readMeta(anchor);
    if (anchorLoc === null || meta === null) return undefined;
    if (anchorLoc.file.length > MAX_FILE) return undefined;
    const frame = meta.parent ?? null;
    const frameOf = (
      node: Element
    ): { stamped: boolean; same: boolean; foreign: boolean; rendered: boolean } => {
      const other = readMeta(node);
      if (other === null) return { stamped: false, same: false, foreign: false, rendered: false };
      const theirs = other.parent ?? null;
      const between = theirs === frame ? "blocks" : framesBetween(theirs, frame);
      return {
        stamped: true,
        same: theirs === frame,
        foreign: between !== "blocks" && between !== "render",
        rendered: between === "render",
      };
    };
    const path: Array<{ tag: string; index: number }> = [];
    let node: Element = target;
    let reachedRoot = false;
    for (let depth = 0; depth < MAX_STRUCTURE_DEPTH; depth += 1) {
      const parent = parentOf(node);
      const own = frameOf(node);
      const parentStamped = parent !== null && frameOf(parent).stamped;
      // Walked by sibling links, not indexed: a live collection is rebuilt
      // per index in some DOMs, and a wide parent made that quadratic.
      // Walked by sibling links, not indexed: a live collection is rebuilt
      // per index in some DOMs, and a wide parent made that quadratic.
      // Comments are walked too, for an unstamped node: the server output
      // brackets every block in `<!--[-->` … `<!--]-->`, and the hydration
      // walk skips what is inside, so an unstamped node found inside a region
      // is a block's dropped element, not this template's, and unstamped
      // content inside a region before it is not counted. A stamped node
      // needs none of this: its frame says which block it belongs to, and
      // its own template's roots may well sit inside an enclosing template's
      // region (a `{@render children()}`).
      let child: ChildNode | null = parent === null ? node : parent.firstChild;
      let index = 0;
      let found = false;
      let scanned = 0;
      let unstampedBefore = false;
      let region = 0;
      // A stamped sibling under a frame that is not the anchor's nor inside
      // it: the anchor is an enclosing component's element, and an unstamped
      // node beside such siblings is one of THEIR template's dropped roots,
      // not the anchor's. Nothing here can say which, so nothing is said.
      const foreignBeside = (kin: { stamped: boolean; foreign: boolean }): boolean =>
        !own.stamped && parentStamped && kin.stamped && kin.foreign;
      while (child !== null) {
        if (child === node) {
          if (region > 0) return undefined;
          found = true;
          break;
        }
        if (++scanned > MAX_STRUCTURE_SIBLINGS) return undefined;
        if (child.nodeType === 8 && !own.stamped) {
          const data = (child as Comment).data;
          if (data.charAt(0) === "[") region += 1;
          else if (data.charAt(0) === "]" && region > 0) region -= 1;
        } else if (child.nodeType === 1 && region === 0) {
          const sibling = child as Element;
          const kin = frameOf(sibling);
          if (foreignBeside(kin)) return undefined;
          // A snippet rendered inline before this node: the template's walk
          // went through it, and this node's stamp and frame may be its own
          // template's or the snippet's. Not placeable either way.
          if (kin.rendered) return undefined;
          if (kin.same) {
            // A stamped sibling after an unstamped one: the unstamped one was
            // never the template's, and the count is off by it.
            if (unstampedBefore) return undefined;
            index += 1;
          } else if (!kin.stamped) {
            // Under a stamped parent the template's unstamped elements are the
            // tail of the run; a stamped node preceded by one is not placeable.
            if (parentStamped && own.stamped) return undefined;
            unstampedBefore = true;
            index += 1;
          }
        }
        child = child.nextSibling;
      }
      if (!found) return undefined;
      // An unstamped node is the template's only at the tail of the stamped
      // run: a stamped sibling of the frame after it says otherwise.
      if (!own.stamped && parentStamped) {
        let after: ChildNode | null = node.nextSibling;
        let inner = 0;
        while (after !== null) {
          if (++scanned > MAX_STRUCTURE_SIBLINGS) return undefined;
          if (after.nodeType === 8) {
            const data = (after as Comment).data;
            if (data.charAt(0) === "[") inner += 1;
            else if (data.charAt(0) === "]" && inner > 0) inner -= 1;
          } else if (after.nodeType === 1 && inner === 0) {
            const kin = frameOf(after as Element);
            if (kin.same || foreignBeside(kin)) return undefined;
          }
          after = after.nextSibling;
        }
      }
      path.unshift({ tag: clamp(node.tagName.toLowerCase(), MAX_TAG), index });
      if (parent === null) {
        reachedRoot = true;
        break;
      }
      const above = frameOf(parent);
      if (above.stamped) {
        if (!above.same) {
          // The template's roots sit in a container of an enclosing template:
          // its frame is above the anchor's. A container whose frame is not —
          // a descendant component's element — holds markup that only
          // inherited the anchor's stamp, such as raw HTML the walk went into.
          const container = (readMeta(parent)?.parent ?? null) as unknown;
          if (framesBetween(frame, container) === "none") return undefined;
          reachedRoot = true;
          break;
        }
        node = parent;
        continue;
      }
      // An unstamped parent below the anchor lost its stamp with the anchor's
      // subtree; one above it is beyond the template.
      if (parent !== anchor && anchor.contains(parent)) {
        node = parent;
        continue;
      }
      reachedRoot = true;
      break;
    }
    // Out of depth is not a path: a suffix of one names the wrong element.
    if (!reachedRoot) return undefined;
    return { file: anchorLoc.file, path };
  }

  /**
   * The element a hit stands for: itself when it is stamped, or unstamped
   * but placeable by shape; otherwise the nearest stamped ancestor, as before.
   * One answer for observing, selecting and hovering, so the outline, the
   * report and a Cmd-click all mean the same node.
   */
  function targetOf(hit: Element): {
    target: Element;
    placeable: GuestNodeObservation["structure"] | undefined;
  } {
    const placeable =
      readLoc(hit) === null && !isUnmapped(hit, true) ? structureOf(hit) : undefined;
    return { target: placeable !== undefined ? hit : (nearestMapped(hit) ?? hit), placeable };
  }

  function observe(hit: Element): GuestNodeObservation {
    const { target, placeable } = targetOf(hit);
    const loc = readLoc(target);
    const structure = placeable ?? (loc === null ? undefined : structureOf(target));
    // The frames are the template's, which an unstamped element inherits.
    const ancestry = readAncestry(nearestMapped(target) ?? target);
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
      ...sameLocOf(loc),
      locIndex: loc === null ? 0 : indexAmongSameLoc(target, loc),
      ...(structure === undefined ? {} : { structure }),
      label: describe(target),
      bounds: boundsOf(target),
      // An unstamped hit the shape placed is markup, not a visual-only region.
      unmapped: placeable !== undefined ? isUnmapped(hit, true) : isUnmapped(hit),
    };
  }

  const ACCENT = "56, 152, 236";
  const ACCENT_LIGHT = "125, 190, 255";

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

  function drawLabel(
    layer: HTMLElement,
    node: Element,
    transform: Transform,
    text: { name: string; detail: string }
  ): void {
    const rect = node.getBoundingClientRect();
    const label = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = text.name;
    style(name, [
      ["color", "rgb(" + ACCENT_LIGHT + ")"],
      ["font-weight", "600"],
    ]);
    const detail = document.createElement("span");
    detail.textContent = text.detail;
    style(detail, [
      ["color", "rgba(255, 255, 255, 0.72)"],
      ["margin-left", "6px"],
    ]);
    label.appendChild(name);
    label.appendChild(detail);
    // Above the element when there is room, inside its top edge when not, and
    // never off the left or right of the viewport.
    const above = rect.top >= 24;
    const top = above ? finite(rect.top) - 4 : Math.max(0, finite(rect.top)) + 4;
    const left = Math.min(Math.max(0, finite(rect.left)), Math.max(0, innerWidth - 320));
    style(label, [
      ["position", "fixed"],
      ["pointer-events", "none"],
      ["transform", above ? "translateY(-100%)" : "none"],
      ["left", (left - transform.originX) / transform.scale + "px"],
      ["top", (top - transform.originY) / transform.scale + "px"],
      ["font", "500 11px/18px -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif"],
      ["color", "#fff"],
      ["background", "rgba(24, 24, 27, 0.94)"],
      ["box-shadow", "0 4px 16px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.08)"],
      ["padding", "1px 7px"],
      ["border-radius", "5px"],
      ["white-space", "nowrap"],
      ["max-width", "320px"],
      ["overflow", "hidden"],
      ["text-overflow", "ellipsis"],
    ]);
    layer.appendChild(label);
  }

  function labelFor(node: Element): { name: string; detail: string } {
    const rect = node.getBoundingClientRect();
    const size = Math.round(rect.width) + " × " + Math.round(rect.height);
    const component = componentName(componentFrames(node)[0] ?? null);
    const tag = describe(node);
    return component === null
      ? { name: tag, detail: size }
      : { name: component, detail: tag + "  " + size };
  }

  /** Margin and padding bands, tinted the way browser inspectors draw them. */
  function drawBoxModel(layer: HTMLElement, node: Element, transform: Transform): void {
    if (typeof getComputedStyle !== "function") return;
    const computed = getComputedStyle(node);
    const px = (value: string): number => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    };
    const rect = node.getBoundingClientRect();
    const band = (left: number, top: number, width: number, height: number, color: string) => {
      if (width <= 0 || height <= 0) return;
      const box = document.createElement("div");
      style(box, [
        ["position", "fixed"],
        ["pointer-events", "none"],
        ["left", (left - transform.originX) / transform.scale + "px"],
        ["top", (top - transform.originY) / transform.scale + "px"],
        ["width", width / transform.scale + "px"],
        ["height", height / transform.scale + "px"],
        ["background", color],
      ]);
      layer.appendChild(box);
    };
    const margin = {
      top: px(computed.marginTop),
      right: px(computed.marginRight),
      bottom: px(computed.marginBottom),
      left: px(computed.marginLeft),
    };
    const padding = {
      top: px(computed.paddingTop) + px(computed.borderTopWidth),
      right: px(computed.paddingRight) + px(computed.borderRightWidth),
      bottom: px(computed.paddingBottom) + px(computed.borderBottomWidth),
      left: px(computed.paddingLeft) + px(computed.borderLeftWidth),
    };
    const MARGIN = "rgba(246, 178, 107, 0.28)";
    const PADDING = "rgba(147, 196, 125, 0.28)";
    band(
      rect.left - margin.left,
      rect.top - margin.top,
      rect.width + margin.left + margin.right,
      margin.top,
      MARGIN
    );
    band(
      rect.left - margin.left,
      rect.bottom,
      rect.width + margin.left + margin.right,
      margin.bottom,
      MARGIN
    );
    band(rect.left - margin.left, rect.top, margin.left, rect.height, MARGIN);
    band(rect.right, rect.top, margin.right, rect.height, MARGIN);
    band(rect.left, rect.top, rect.width, padding.top, PADDING);
    band(rect.left, rect.bottom - padding.bottom, rect.width, padding.bottom, PADDING);
    band(
      rect.left,
      rect.top + padding.top,
      padding.left,
      rect.height - padding.top - padding.bottom,
      PADDING
    );
    band(
      rect.right - padding.right,
      rect.top + padding.top,
      padding.right,
      rect.height - padding.top - padding.bottom,
      PADDING
    );
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
      emitSelection("document");
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
      drawBoxModel(layer, hovered, transform);
      drawElement(layer, hovered, "hover", transform);
      drawLabel(layer, hovered, transform, labelFor(hovered));
    }
    for (const entry of selection) drawElement(layer, entry.target, "selected", transform);
    const primary = selection[0];
    if (primary !== undefined) {
      const label = labelFor(primary.target);
      const component = componentName(selectedFrame);
      drawLabel(
        layer,
        primary.target,
        transform,
        selectionScope === "component" && component !== null
          ? {
              name: component,
              detail: selection.length > 1 ? selection.length + " elements" : label.detail,
            }
          : label
      );
    }
    if (trackTargets !== null) {
      const tracked = selection.map((entry) => entry.target);
      if (hovered !== null) tracked.push(hovered);
      // Re-observing makes the observer report again, which schedules another
      // paint: only do it when the set of targets actually changed, or an idle
      // page repaints every frame.
      const changed =
        tracked.length !== trackedTargets.length ||
        tracked.some((node, index) => node !== trackedTargets[index]);
      if (changed) {
        trackedTargets = tracked;
        trackTargets(tracked);
      }
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
  function emitSelection(cause: "user" | "document" | "reselect"): boolean {
    // A page that hydrated after every audit look still answers the handshake
    // before its first selection is described.
    probeMetadata();
    // A client-side navigation or a resize leaves the document in place, so no
    // `documentReady` follows it. The host resolves and describes a selection
    // against the page it last heard about; bring that up to date first.
    if (pageMoved()) emitDocumentReady();
    const nodes = selection.map((entry) => observe(entry.hit));
    const primary = selection[0];
    const identity =
      selectionScope === "component" && selectedFrame !== null && primary !== undefined
        ? componentIdentity(selectedFrame)
        : null;
    const scopeField =
      identity !== null && nodes.length > 0
        ? { scope: "component" as const, component: identity }
        : {};
    if (send({ type: "selectionChanged", nodes, cause, ...scopeField })) return true;
    const trimmed = nodes.map((node) => ({ ...node, ancestry: node.ancestry.slice(0, 4) }));
    if (send({ type: "selectionChanged", nodes: trimmed, cause, ...scopeField })) {
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
    const target = hit === null || isOverlay(hit) ? null : targetOf(hit).target;
    const mapping =
      hit === null || target === null
        ? null
        : isUnmapped(hit, target === hit && readLoc(hit) === null);
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
    const { target } = targetOf(hit);
    const mouse = event as MouseEvent;
    const additive = mouse.metaKey === true || mouse.ctrlKey === true;
    const previous = selection;
    const previousScope = selectionScope;
    const previousFrame = selectedFrame;
    selectionScope = "element";
    selectedFrame = null;
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
    if (!emitSelection("user")) {
      selection = previous;
      selectionScope = previousScope;
      selectedFrame = previousFrame;
      issue("internal", "selection left unchanged: the observation did not fit one envelope");
    }
    schedulePaint();
  }

  function mappedChildren(node: Element): Element[] {
    const found: Element[] = [];
    const walk = (parent: Element, depth: number): void => {
      for (const child of Array.from(parent.children)) {
        if (found.length >= MAX_NODES || isOverlay(child)) return;
        if (readLoc(child) !== null) found.push(child);
        else if (depth < 8) walk(child, depth + 1);
      }
    };
    walk(node, 0);
    return found;
  }

  function selectOnly(
    target: Element,
    scopeNext: "element" | "component",
    frame: object | null,
    cause: "user" | "reselect" = "user"
  ): void {
    const previous = selection;
    const previousScope = selectionScope;
    const previousFrame = selectedFrame;
    selectionScope = scopeNext;
    selectedFrame = frame;
    selection =
      scopeNext === "component" && frame !== null
        ? componentRoots(frame, target).map((root) => ({ target: root, hit: root }))
        : [{ target, hit: target }];
    if (!emitSelection(cause)) {
      selection = previous;
      selectionScope = previousScope;
      selectedFrame = previousFrame;
    }
    const first = selection[0];
    if (first !== undefined && typeof first.target.scrollIntoView === "function") {
      first.target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    schedulePaint();
  }

  /**
   * The element compiled from `loc`, found by the same identity a click would
   * report — not by a cached node, which a reload has replaced. Bounded by the
   * audit scan limit for the same reason the dev-build sweep is.
   */
  function elementAt(loc: SourceLoc, index: number): Element | null {
    const key = locKey(loc);
    const root = document.body ?? document.documentElement;
    if (root === null) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    let scanned = 0;
    let seen = 0;
    while (node !== null && scanned++ < AUDIT_SCAN_LIMIT) {
      if (node instanceof Element && !isOverlay(node)) {
        const found = readLoc(node);
        if (found !== null && locKey(found) === key) {
          if (seen === index) return node;
          seen += 1;
        }
      }
      node = walker.nextNode();
    }
    return null;
  }

  /**
   * Which of the elements sharing this node's `loc` it is, in document order.
   * Repeated markup — a card per plan — draws several elements from one
   * location, and "the fourth card" is what the user selected, not "a card".
   */
  function indexAmongSameLoc(target: Element, loc: SourceLoc): number | undefined {
    const key = locKey(loc);
    const all = document.getElementsByTagName("*");
    const limit = Math.min(all.length, AUDIT_SCAN_LIMIT);
    let index = 0;
    for (let cursor = 0; cursor < limit; cursor += 1) {
      const element = all[cursor];
      if (element === undefined) continue;
      if (element === target) return index;
      const other = readLoc(element);
      if (other !== null && locKey(other) === key) index += 1;
    }
    // Past the sweep: no occurrence is claimed, so no reselect can land on the
    // first copy in its place. The host treats a missing index as unknown.
    return undefined;
  }

  /**
   * The occurrence is exactly the one the host names — never the first as a
   * stand-in. Repeated markup shares a file, a tag and a revision, so the host
   * could not tell the substitution from the real thing; a missing occurrence
   * is a failure, and the stale notice is the honest answer.
   */
  function reselect(
    loc: SourceLoc,
    index?: number,
    component?: SourceLoc | null,
    occurrence?: string | null
  ): boolean {
    if (disposed || mode !== "select") return false;
    const wanted = typeof index === "number" && index >= 0 ? Math.floor(index) : 0;
    // The element the host is asking about, by the id it was reported under,
    // while it is still the same node in the document; else by location and
    // occurrence, as after a reload has replaced it.
    const held =
      typeof occurrence === "string"
        ? (elementsByOccurrence.get(occurrence)?.deref() ?? null)
        : null;
    const target =
      held !== null && held.isConnected && !isOverlay(held) ? held : elementAt(loc, wanted);
    if (target === null) return false;
    // A component the user widened to stays the selection: the overlay keeps
    // naming it, and Option/Alt+Up keeps stepping outward from it rather than
    // starting again at the innermost component.
    const frame =
      component === null || component === undefined
        ? null
        : (componentFrames(target).find((candidate) => {
            const identity = componentIdentity(candidate);
            return (
              identity !== null &&
              identity.file === component.file &&
              identity.line === component.line &&
              identity.column === component.column
            );
          }) ?? null);
    selectOnly(target, frame === null ? "element" : "component", frame, "reselect");
    return true;
  }

  function clearSelection(): void {
    if (disposed) return;
    selection = [];
    selectionScope = "element";
    selectedFrame = null;
    schedulePaint();
  }

  const CONTROL_ROLES = new Set([
    "textbox",
    "searchbox",
    "combobox",
    "slider",
    "spinbutton",
    "listbox",
    "menu",
    "menubar",
    "grid",
    "tablist",
    "tree",
    "radiogroup",
  ]);

  /** Arrow keys that belong to something on the page: a field, an editor, a widget. */
  function keyTargetsPageControl(event: Event): boolean {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const entry of path) {
      if (!(entry instanceof Element)) continue;
      const tag = entry.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (entry instanceof HTMLElement && entry.isContentEditable) return true;
      const role = entry.getAttribute("role");
      if (role !== null && CONTROL_ROLES.has(role)) return true;
    }
    return false;
  }

  /**
   * Keyboard traversal, the Web Inspector way: arrows walk the rendered tree,
   * and Option/Alt+Up widens to the component that drew the selection — then to
   * the component around that.
   */
  function onKeyDown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    // Keys during composition belong to the IME, never to the inspector.
    if (keyboard.isComposing === true || keyboard.keyCode === 229) return;
    const primary = selection[0];
    if (keyboard.key === "Escape") {
      if (selection.length === 0) return;
      // Only swallow Escape when it had something of ours to clear; otherwise
      // the host still owns it for leaving Select mode.
      suppress(event);
      selection = [];
      selectionScope = "element";
      selectedFrame = null;
      emitSelection("user");
      schedulePaint();
      return;
    }
    if (primary === undefined) return;
    if (!keyboard.key.startsWith("Arrow") || keyTargetsPageControl(event)) return;
    const onlyAlt = keyboard.altKey && !keyboard.ctrlKey && !keyboard.metaKey && !keyboard.shiftKey;
    const plain = !keyboard.altKey && !keyboard.ctrlKey && !keyboard.metaKey && !keyboard.shiftKey;
    if (!plain && !(onlyAlt && keyboard.key === "ArrowUp")) return;
    const current = primary.target;
    if (keyboard.key === "ArrowUp" && keyboard.altKey) {
      suppress(event);
      const frames = componentFrames(current);
      const index = selectedFrame === null ? -1 : frames.indexOf(selectedFrame);
      // Step out to the next component the page can actually name and place;
      // one with a malformed frame of its own is passed over, not selected blind.
      for (let at = selectionScope === "component" ? index + 1 : 0; at < frames.length; at += 1) {
        const next = frames[at];
        if (next !== undefined && componentIdentity(next) !== null) {
          selectOnly(current, "component", next);
          break;
        }
      }
      return;
    }
    if (keyboard.key === "ArrowUp") {
      suppress(event);
      const parent = nearestMapped(parentOf(current));
      if (parent !== null) selectOnly(parent, "element", null);
      return;
    }
    if (keyboard.key === "ArrowDown") {
      suppress(event);
      const child = mappedChildren(current)[0];
      if (child !== undefined) selectOnly(child, "element", null);
      return;
    }
    if (keyboard.key === "ArrowLeft" || keyboard.key === "ArrowRight") {
      const parent = parentOf(current);
      if (parent === null) return;
      suppress(event);
      const siblings = mappedChildren(nearestMapped(parent) ?? parent);
      const index = siblings.indexOf(current);
      const next = siblings[index + (keyboard.key === "ArrowRight" ? 1 : -1)];
      if (next !== undefined) selectOnly(next, "element", null);
    }
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
        trackedTargets = [];
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

  /**
   * What the metadata on this page actually supports. `__svelte_meta` is a
   * private detail of Svelte's dev runtime, and a major is not a promise about
   * its shape: a version that stamps elements but names no parent chain, or
   * stamps a chain the reader cannot follow, must narrow what the host offers
   * rather than be taken for the version this runtime was written against.
   *
   * Probed over the stamped elements found, not the first one alone: the root
   * of a page has no component above it, so one element cannot speak for the
   * chain. Reported once per document, the first time a stamp is seen.
   */
  function probeMetadata(): void {
    if (metadataProbed || disposed) return;
    // The host records capabilities against the document it has been told is
    // ready; an answer sent before `documentReady` would be dropped, and the
    // one-shot would be spent.
    if (reportedPage === "") return;
    const all = document.getElementsByTagName("*");
    const limit = Math.min(all.length, AUDIT_SCAN_LIMIT);
    let stamped = 0;
    let locations = false;
    let ancestry = false;
    for (let index = 0; index < limit && stamped < METADATA_PROBE_SAMPLE; index += 1) {
      const element = all[index];
      if (element === undefined || readMeta(element) === null) continue;
      stamped += 1;
      if (readLoc(element) !== null) locations = true;
      if (readAncestry(element).frames.length > 0) ancestry = true;
      if (locations && ancestry) break;
    }
    if (stamped === 0) return;
    stampsSeen = true;
    metadataProbed = true;
    send({ type: "metadataProbed", locations, ancestry });
  }

  const DEV_SERVER_PATHS = [
    "/@vite/client",
    "/@fs/",
    "/.svelte-kit/generated/",
    "/node_modules/.vite/",
  ];

  function namesDevServerPath(value: string | null | undefined): boolean {
    return typeof value === "string" && DEV_SERVER_PATHS.some((part) => value.includes(part));
  }

  /**
   * SvelteKit's dev page has no `<script src="/@vite/client">`: its inline
   * start script imports the client runtime through `/@fs/` and the generated
   * app, and Vite's client arrives as one of those imports. The module fetches
   * are the dependable evidence, with the markup as a fallback.
   */
  function looksLikeDevServer(): boolean {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (
      scope.__vite_plugin_react_preamble_installed__ !== undefined ||
      scope.__vite__ !== undefined
    )
      return true;
    try {
      const entries =
        typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
          ? performance.getEntriesByType("resource")
          : [];
      for (let index = 0; index < entries.length && index < AUDIT_SCAN_LIMIT; index += 1) {
        if (namesDevServerPath(entries[index]?.name)) return true;
      }
    } catch {
      // Resource timing is evidence, not a requirement.
    }
    const scripts = document.getElementsByTagName("script");
    for (let index = 0; index < scripts.length && index < 200; index += 1) {
      const script = scripts[index];
      if (script === undefined) continue;
      if (namesDevServerPath(script.getAttribute("src"))) return true;
      if (script.src === "" && namesDevServerPath((script.textContent ?? "").slice(0, 4096)))
        return true;
    }
    return false;
  }

  function clearAuditTimer(): void {
    if (auditTimer !== null) {
      clearTimeout(auditTimer);
      auditTimer = null;
    }
  }

  /**
   * Without `__svelte_meta` there is nothing to inspect. Saying so is the whole
   * point: a silent dead inspector reads as a bug in Daintree. Saying it while
   * the page is still hydrating is worse — a warning that contradicts the
   * working selection under it — so the verdict waits for the page to settle.
   */
  function auditMapping(): void {
    if (disposed) return;
    // Capability discovery outlives the missing-mapping verdict: a page that
    // hydrates after the deadline still gets its handshake on the next look.
    probeMetadata();
    if (auditDone) return;
    const scan = scanForSvelteMeta();
    if (scan.found) {
      auditDone = true;
      clearAuditTimer();
      return;
    }
    // A page that has not finished loading, or a document too big to sweep,
    // is not evidence of a production build. Stay silent and look again.
    if (!scan.complete || document.readyState !== "complete") return;
    if (auditTimer !== null) return;
    if (auditStartedAt === 0) auditStartedAt = Date.now();
    auditTimer = setTimeout(confirmMissingMapping, AUDIT_SETTLE_MS);
  }

  function confirmMissingMapping(): void {
    auditTimer = null;
    if (auditDone || disposed) return;
    probeMetadata();
    const scan = scanForSvelteMeta();
    if (scan.found) {
      auditDone = true;
      return;
    }
    if (!scan.complete || document.readyState !== "complete") return;
    const dev = looksLikeDevServer();
    if (dev && Date.now() - auditStartedAt < AUDIT_DEV_SETTLE_MS) {
      auditTimer = setTimeout(confirmMissingMapping, AUDIT_SETTLE_MS);
      return;
    }
    auditDone = true;
    // Stamps that exist but cannot be read were already reported as such; an
    // absence verdict on top would contradict it.
    if (stampsSeen) return;
    if (dev) {
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

  function currentPage() {
    const scale =
      typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    return {
      url: clamp(location.href, MAX_URL),
      viewport: {
        width: Math.max(1, Math.round(innerWidth)),
        height: Math.max(1, Math.round(innerHeight)),
        deviceScaleFactor: scale,
      },
    };
  }

  function pageMoved(): boolean {
    return reportedPage !== "" && reportedPage !== JSON.stringify(currentPage());
  }

  function emitDocumentReady(): void {
    const page = currentPage();
    reportedPage = JSON.stringify(page);
    send({
      type: "documentReady",
      // The host owns route identity; the guest reports only what it can see.
      routeId: null,
      ...page,
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
    clearAuditTimer();
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
    reselect,
    clearSelection,
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
    // The verdict waits for a complete document; a page whose last resource
    // lands after DOMContentLoaded would otherwise never be judged.
    if (document.readyState !== "complete") {
      listen(window, "load", () => auditMapping(), { once: true }, teardown);
    }
    if (mode === "select") attachSelectListeners();
  } catch (error) {
    issue("internal", "guest activation failed: " + String(error));
    dispose();
  }

  return handle;
}
