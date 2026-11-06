/// <reference lib="dom" />
/**
 * The main-world side of the bridge, bundled into every extractor asset. The
 * first extractor installed for a bootstrap creates the registry; later ones
 * join it. One listener answers the bootstrap's `extract` requests for every
 * installed framework, so a page with Astro islands of React and Svelte asks
 * both from the same request.
 *
 * Requests are answered synchronously, inside the bootstrap's own
 * `dispatchEvent`, so there is no correlation window for a reply to arrive
 * late into a different request. The reply is still checked by id and by size
 * on the other side: page code shares this world and can send its own. A
 * reply that names elements — a component's roots, a pick's element, what a
 * locate found — names each by a token and dispatches an `element` event on
 * it, the only way a node crosses between worlds.
 */

import {
  EXTRACTOR_NOTICES,
  EXTRACTOR_REGISTRY_GLOBAL,
  MAX_BRIDGE_MESSAGE_CHARS,
  MAX_ELEMENT_REFS,
  MAX_LOCATED_REPLY_CHARS,
  MAX_LOCATE_REQUEST_CHARS,
  channelEvent,
  elementRefToken,
  type ElementRefMessage,
  type ExtractReply,
  type ExtractRequest,
  type ExtractionPhase,
  type ExtractorNotice,
  type LocateRequest,
  type LocatedReply,
} from "../guestChannel.js";
import type { ExtractorContribution } from "./types.js";

/**
 * How a reply names an element, in `rootElementIds` or anywhere else an
 * answer refers to one: element ids are the bootstrap's, minted in a world
 * this one cannot see, so the reply carries a token and the element follows
 * it across as an event's target.
 */
export interface ElementRefs {
  /**
   * The token for `node`, the same one each time it is asked for. Null for a
   * node the bootstrap could not be told about — detached, in another
   * document, behind a closed shadow root — or once the reply names as many
   * elements as it may.
   */
  ref(node: Element): string | null;
}

/**
 * One framework's reader. `extract` must be synchronous and bounded: it runs
 * inside a pointer move when the phase is `hover`, so it reads only what labels
 * a highlight there and saves anything costly for `selection`. Null says it
 * looked and found nothing of its framework's; a reader that cannot look
 * throws instead, and gives no answer either way.
 */
export interface ElementPickerExtractor {
  extract(
    element: Element,
    phase: ExtractionPhase,
    refs: ElementRefs
  ): ExtractorContribution | null;
  /**
   * True for a reader that reads nothing on hover. Its null there is a choice,
   * not a look, so the registry leaves it out of a hover's reply altogether
   * rather than report it as having found nothing.
   */
  selectionOnly?: boolean;
  /**
   * A user's pick of `hit`: the element it stands for, described. Only for a
   * framework that selects something other than the node the pointer landed
   * on; without it a pick is `extract(hit, "selection", refs)`. The registry
   * names `target` from the same `refs`.
   */
  pick?(
    hit: Element,
    refs: ElementRefs
  ): { target: Element; data: ExtractorContribution | null } | null;
  /**
   * Elements found by a query in this framework's own terms, from `anchor` or
   * from the whole document. Synchronous and bounded like `extract`; the
   * registry names what it returns.
   */
  locate?(
    query: unknown,
    anchor: Element | null
  ): { elements: Element[]; data?: Record<string, unknown> } | null;
  /** Called once on registration with the way to tell the bootstrap about the page. */
  start?(notify: (notice: ExtractorNotice) => void): void;
  dispose?(): void;
}

/** The half of the host prelude's `api` an extractor asset reads and sets. */
export interface ExtractorHostApi {
  channel: string;
  framework: string;
  installed: boolean;
  /** The markup the dev server served, read back by the host; only an extractor that asks for it gets it. */
  served?: unknown;
}

interface Registry {
  channel: string;
  has(framework: string): boolean;
  register(framework: string, extractor: ElementPickerExtractor): void;
  /** Drops one extractor and runs its cleanup; the rest keep answering. */
  unregister(framework: string): void;
  dispose(): void;
}

function isRegistry(value: unknown): value is Registry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Registry).channel === "string" &&
    typeof (value as Registry).register === "function" &&
    typeof (value as Registry).unregister === "function" &&
    typeof (value as Registry).dispose === "function"
  );
}

function parseJson(detail: unknown, max: number): Record<string, unknown> | null {
  if (typeof detail !== "string" || detail.length > max) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function parseRequest(detail: unknown): ExtractRequest | null {
  const request = parseJson(detail, 256) as Partial<ExtractRequest> | null;
  if (request === null) return null;
  if (!Number.isSafeInteger(request.id)) return null;
  if (request.phase !== "hover" && request.phase !== "selection") return null;
  if (request.pick === true && request.phase === "selection") {
    return { id: request.id as number, phase: request.phase, pick: true };
  }
  return { id: request.id as number, phase: request.phase };
}

/** Bounds the walk out through shadow hosts; real nesting is a handful deep. */
const MAX_SHADOW_DEPTH = 32;

/**
 * Whether an event dispatched on `node` reaches the bootstrap's document
 * listener with `node` itself first on its path. A closed shadow root
 * retargets the path to its host, which would name the wrong element.
 */
function reachesDocument(node: Element): boolean {
  if (!node.isConnected) return false;
  let root = node.getRootNode();
  for (let depth = 0; depth < MAX_SHADOW_DEPTH && root instanceof ShadowRoot; depth += 1) {
    if (root.mode !== "open") return false;
    root = root.host.getRootNode();
  }
  return root === document;
}

interface RefTable extends ElementRefs {
  nodes: Element[];
}

function createRefTable(): RefTable {
  const tokens = new Map<Element, string | null>();
  const nodes: Element[] = [];
  return {
    nodes,
    ref(node) {
      if (!(node instanceof Element)) return null;
      const known = tokens.get(node);
      if (known !== undefined) return known;
      if (nodes.length >= MAX_ELEMENT_REFS) return null;
      let token: string | null = null;
      try {
        if (reachesDocument(node)) {
          token = elementRefToken(nodes.length);
          nodes.push(node);
        }
      } catch {
        // A node whose root cannot be read cannot be named either.
      }
      tokens.set(node, token);
      return token;
    },
  };
}

function parseLocate(detail: unknown): LocateRequest | null {
  const request = parseJson(detail, MAX_LOCATE_REQUEST_CHARS) as Partial<LocateRequest> | null;
  if (request === null) return null;
  if (!Number.isSafeInteger(request.id) || typeof request.framework !== "string") return null;
  return { id: request.id as number, framework: request.framework, query: request.query };
}

function targetOf(event: Event): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const target = path.length > 0 ? path[0] : event.target;
  return target instanceof Element ? target : null;
}

function createRegistry(channel: string): Registry {
  const extractors = new Map<string, ElementPickerExtractor>();
  const extractEvent = channelEvent(channel, "extract");
  const extractedEvent = channelEvent(channel, "extracted");
  const elementEvent = channelEvent(channel, "element");
  const disposeEvent = channelEvent(channel, "dispose");
  const locateEvent = channelEvent(channel, "locate");
  const locatedEvent = channelEvent(channel, "located");
  const noticeEvent = channelEvent(channel, "notice");
  let disposed = false;

  /**
   * Send each element a reply names across, just before the reply itself.
   * Composed, so a node inside an open shadow root still reaches the
   * bootstrap's document listener; not bubbling, because that listener
   * captures and nothing else in the page needs to see it.
   */
  function sendElements(nodes: readonly Element[], id: number): void {
    nodes.forEach((node, ref) => {
      const message: ElementRefMessage = { id, ref };
      try {
        // Again: a listener on an earlier one can move this node behind a closed root.
        if (!reachesDocument(node)) return;
        node.dispatchEvent(
          new CustomEvent(elementEvent, { detail: JSON.stringify(message), composed: true })
        );
      } catch {
        // That element goes unnamed; the bootstrap counts it as lost.
      }
    });
  }

  function pickOf(
    extractor: ElementPickerExtractor,
    hit: Element,
    refs: ElementRefs
  ): { target: Element; data: ExtractorContribution | null } {
    if (typeof extractor.pick !== "function") {
      return { target: hit, data: extractor.extract(hit, "selection", refs) };
    }
    const picked = extractor.pick(hit, refs);
    return picked ?? { target: hit, data: null };
  }

  const onExtract = (event: Event): void => {
    const request = parseRequest((event as CustomEvent).detail);
    if (request === null) return;
    const target = targetOf(event);
    if (target === null) return;
    const empty: string[] = [];
    const reply: ExtractReply = { id: request.id, contributions: [], empty };
    // One table for the whole reply: the bootstrap adopts one contribution,
    // and whichever it is, its tokens are this request's.
    const refs = createRefTable();
    for (const [framework, extractor] of extractors) {
      if (request.phase === "hover" && extractor.selectionOnly === true) continue;
      let data: ExtractorContribution | null;
      // Each contribution names its own pick: the bootstrap reads the one it adopts.
      let token: string | null = null;
      try {
        if (request.pick === true) {
          const picked = pickOf(extractor, target, refs);
          if (picked.target !== target) token = refs.ref(picked.target);
          // An element the bootstrap cannot be shown is not one it can select,
          // so the description is of the hit after all, or of nothing if that throws.
          data =
            picked.target === target || token !== null
              ? picked.data
              : extractor.extract(target, "selection", refs);
        } else {
          data = extractor.extract(target, request.phase, refs);
        }
      } catch {
        // One framework's reader failing must not cost the others their answer,
        // and is no answer of its own.
        continue;
      }
      if (data === null || data === undefined) {
        empty.push(framework);
        continue;
      }
      reply.contributions.push(
        token === null ? { framework, data } : { framework, data, target: token }
      );
    }
    let text: string;
    let named = refs.nodes;
    try {
      text = JSON.stringify(reply);
    } catch {
      text = JSON.stringify({ id: request.id, contributions: [] });
      named = [];
    }
    // Over the ceiling the bootstrap would only discard it; say nothing instead.
    if (text.length > MAX_BRIDGE_MESSAGE_CHARS) {
      text = JSON.stringify({ id: request.id, contributions: [] });
      named = [];
    }
    sendElements(named, request.id);
    document.dispatchEvent(new CustomEvent(extractedEvent, { detail: text }));
  };

  const onLocate = (event: Event): void => {
    const request = parseLocate((event as CustomEvent).detail);
    if (request === null) return;
    const extractor = extractors.get(request.framework);
    if (extractor === undefined || typeof extractor.locate !== "function") return;
    // Dispatched on the document for a query with no anchor of its own.
    const anchor = targetOf(event);
    let found: { elements: Element[]; data?: Record<string, unknown> } | null;
    try {
      found = extractor.locate(request.query, anchor);
    } catch {
      return;
    }
    if (found === null || !Array.isArray(found.elements)) return;
    const refs = createRefTable();
    const elements: string[] = [];
    // An element that cannot be named makes whatever list it was part of incomplete.
    let truncated = false;
    for (const element of found.elements) {
      const token = refs.ref(element);
      if (token === null) truncated = true;
      else if (!elements.includes(token)) elements.push(token);
    }
    const reply: LocatedReply = { id: request.id, elements, data: found.data ?? null, truncated };
    // The tokens always fit the ceiling; only the extractor's data can overflow it.
    const bare = (): string => JSON.stringify({ ...reply, data: null });
    let text: string;
    try {
      text = JSON.stringify(reply);
    } catch {
      text = bare();
    }
    if (text.length > MAX_LOCATED_REPLY_CHARS) text = bare();
    sendElements(refs.nodes, request.id);
    document.dispatchEvent(new CustomEvent(locatedEvent, { detail: text }));
  };

  const notifier =
    (framework: string) =>
    (notice: ExtractorNotice): void => {
      if (disposed || !(EXTRACTOR_NOTICES as readonly string[]).includes(notice)) return;
      try {
        document.dispatchEvent(
          new CustomEvent(noticeEvent, { detail: JSON.stringify({ framework, notice }) })
        );
      } catch {
        // A notice is news, not state: one that cannot be sent is simply not heard.
      }
    };

  const registry: Registry = {
    channel,
    has: (framework) => extractors.has(framework),
    register(framework, extractor) {
      extractors.get(framework)?.dispose?.();
      extractors.set(framework, extractor);
      try {
        extractor.start?.(notifier(framework));
      } catch {
        // An extractor whose page watch failed to start still answers requests.
      }
    },
    unregister(framework) {
      const extractor = extractors.get(framework);
      if (extractor === undefined) return;
      extractors.delete(framework);
      try {
        extractor.dispose?.();
      } catch {
        // The registration is gone whether or not its cleanup ran.
      }
    },
    dispose() {
      disposed = true;
      document.removeEventListener(extractEvent, onExtract, true);
      document.removeEventListener(locateEvent, onLocate, true);
      document.removeEventListener(disposeEvent, onDispose);
      for (const extractor of extractors.values()) {
        try {
          extractor.dispose?.();
        } catch {
          // Teardown continues past a reader that cannot clean up after itself.
        }
      }
      extractors.clear();
      const scope = globalThis as Record<string, unknown>;
      if (scope[EXTRACTOR_REGISTRY_GLOBAL] === registry) delete scope[EXTRACTOR_REGISTRY_GLOBAL];
    },
  };

  const onDispose = (): void => registry.dispose();

  document.addEventListener(extractEvent, onExtract, true);
  document.addEventListener(locateEvent, onLocate, true);
  document.addEventListener(disposeEvent, onDispose);
  return registry;
}

/**
 * Register `extractor` for the framework the host is installing. A registry
 * left in the page by an earlier bootstrap — one a navigation-free reinstall
 * replaced — answers a channel nobody uses any more, so it goes first.
 */
export function installExtractor(host: ExtractorHostApi, extractor: ElementPickerExtractor): void {
  const scope = globalThis as Record<string, unknown>;
  let registry = scope[EXTRACTOR_REGISTRY_GLOBAL];
  if (!isRegistry(registry) || registry.channel !== host.channel) {
    if (isRegistry(registry)) {
      try {
        registry.dispose();
      } catch {
        // A stale registry that cannot dispose still gets replaced.
      }
    }
    registry = createRegistry(host.channel);
    scope[EXTRACTOR_REGISTRY_GLOBAL] = registry;
  }
  (registry as Registry).register(host.framework, extractor);
  host.installed = (registry as Registry).has(host.framework);
}
