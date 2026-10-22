/**
 * What the core picker's guest pieces agree on: the isolated-world bootstrap,
 * the host's main-world preludes, and the extractors those preludes install.
 *
 * Imported by the host and bundled into the guest assets, so it stays free of
 * DOM and Node references alike.
 *
 * The bootstrap lives in an isolated world the page cannot reach, and the
 * extractors live in the page's main world because framework expandos (React
 * fibers, Vue instances, `__svelte_meta`) are per-world and only readable
 * there. The two share nothing but the DOM, so they talk in DOM events whose
 * names are suffixed onto a channel the host mints per install: two installs
 * in one document cannot answer each other. The channel is not a secret —
 * anything in the page can watch the events go by and send its own — so
 * neither side trusts what crosses it, and the host validates everything that
 * reaches it again.
 */

export const CHANNEL_EVENTS = {
  /**
   * Cancelable, sent by a main-world prelude before it does anything. The
   * bootstrap that owns the channel cancels it, synchronously, which is the
   * prelude's proof that the document it landed in is the one the host
   * installed that bootstrap into — not one a navigation swapped in under the
   * evaluate.
   */
  handshake: "handshake",
  /** Bootstrap → extractors, dispatched on the element being described. */
  extract: "extract",
  /** Extractors → bootstrap, on the document, while the request is still being dispatched. */
  extracted: "extracted",
  /**
   * Extractors → bootstrap, dispatched on each element a reply names, just
   * before `extracted`. An element crosses between worlds only as an event's
   * target, so this is how a component's rendered roots reach the bootstrap,
   * which alone can give them element ids.
   */
  element: "element",
  /** Bootstrap → extractors: the bootstrap is gone, and so is everything installed for it. */
  dispose: "dispose",
  /**
   * Extractor → bootstrap, dispatched ON an element while a request is being
   * answered. JSON cannot carry a node from one world to the other, but an
   * event can: each world's listener sees its own wrapper of the same element.
   */
  point: "point",
  /** Bootstrap → one framework's extractor: find elements by a query only that framework reads. */
  locate: "locate",
  /** Extractor → bootstrap, on the document: the end of a locate, after its points. */
  located: "located",
  /** Extractor → bootstrap, on the document: a fact about the page, from a fixed vocabulary. */
  notice: "notice",
} as const;

export type ChannelEventName = keyof typeof CHANNEL_EVENTS;

export function channelEvent(channel: string, name: ChannelEventName): string {
  return `${channel}:${CHANNEL_EVENTS[name]}`;
}

/** Ceiling on one bridge message, in UTF-16 code units, checked before it is parsed. */
export const MAX_BRIDGE_MESSAGE_CHARS = 128 * 1024;

/**
 * The main-world global an installed extractor registers under. Page code can
 * read and replace it; doing so only silences the page's own picker.
 */
export const EXTRACTOR_REGISTRY_GLOBAL = "__daintreeElementPickerExtractors";

/** The isolated-world global the bootstrap publishes its controls on. */
export const BOOTSTRAP_GLOBAL = "__daintreeElementPicker";

/** What an extractor-install prelude evaluates to; anything else is a failure. */
export const EXTRACTOR_INSTALL_STATUS = {
  installed: "installed",
  /** No bootstrap of this install answered: the document changed under the evaluate. */
  absent: "absent",
  threw: "threw",
  unregistered: "unregistered",
} as const;

export type ExtractionPhase = "hover" | "selection";

export interface ExtractRequest {
  id: number;
  phase: ExtractionPhase;
  /**
   * A user's pick rather than a description: the extractor may answer for the
   * element the pick stands for, and point at it, when that is not the node the
   * pointer landed on.
   */
  pick?: true;
}

export interface ExtractReply {
  id: number;
  contributions: Array<{ framework: string; data: unknown }>;
}

/** Distinct elements one reply may name; a reference past it is never made. */
export const MAX_ELEMENT_REFS = 256;

/**
 * What a reply's `rootElementIds` hold until the bootstrap swaps each for the
 * element id of the node its `element` event arrived on.
 */
export function elementRefToken(ref: number): string {
  return `ref-${ref}`;
}

export interface ElementRefMessage {
  /** The request the reply answers. */
  id: number;
  ref: number;
}

/** Ceiling on a locate request's detail; a locator names a file, which can be long. */
export const MAX_LOCATE_REQUEST_CHARS = 4096;
/** Ceiling on a locate's terminal reply: a few ids and flags, never a description. */
export const MAX_LOCATED_REPLY_CHARS = 1024;
/** Elements one request may point at: the most roots a component selection holds. */
export const MAX_POINTED_ELEMENTS = 32;

export interface LocateRequest {
  id: number;
  framework: string;
  /** The framework's own query, opaque to the bootstrap. */
  query: unknown;
}

export interface LocatedReply {
  id: number;
  data: Record<string, unknown> | null;
  /** Some of what the extractor found was not pointed at: past the ceiling, or not in the document. */
  truncated: boolean;
}

/**
 * What an extractor can tell the bootstrap about the page unprompted. Codes,
 * not text: the bootstrap words the issue itself, so the page never writes a
 * notice the host shows.
 */
export const EXTRACTOR_NOTICES = [
  "not-dev-build",
  "metadata-unavailable",
  "ancestry-truncated",
] as const;
export type ExtractorNotice = (typeof EXTRACTOR_NOTICES)[number];
