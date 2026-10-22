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
  /** Bootstrap → extractors: the bootstrap is gone, and so is everything installed for it. */
  dispose: "dispose",
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
}

export interface ExtractReply {
  id: number;
  contributions: Array<{ framework: string; data: unknown }>;
}
