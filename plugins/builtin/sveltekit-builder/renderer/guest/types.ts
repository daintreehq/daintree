/// <reference lib="dom" />
/**
 * Types shared by the guest runtime and its serialiser.
 *
 * Everything here is erased at compile time. The runtime factory is serialised
 * with `Function.prototype.toString()` and evaluated inside the user's page, so
 * a value import in `runtime.ts` would produce a free identifier the page
 * cannot resolve.
 */

export type GuestMode = "browse" | "select";

/** Host-supplied, embedded into the injected source as a literal. */
export interface GuestBootstrapConfig {
  protocolVersion: number;
  sessionId: string;
  documentEpoch: number;
  mode: GuestMode;
  /** Global the host installed its binding function under (CDP `addBinding`). */
  bindingName: string;
  /** Global the runtime publishes its handle under, for host-driven control. */
  handleName: string;
}

/**
 * How observations leave the page.
 *
 * In production the host prelude supplies `post` and addresses the envelope:
 * session id and epoch are baked in per install and the prelude counts the
 * sequence. That keeps an honest runtime from drifting out of step with the
 * host; it does not stop a hostile page, which shares the main world and can
 * call the binding itself. Without a transport the
 * runtime builds its own envelope and calls the binding directly — the
 * standalone shape, used where no prelude is present.
 */
export interface GuestTransport {
  post(event: unknown): void;
}

/**
 * What the host drives after injection. Everything is synchronous: the host
 * calls these over `Runtime.evaluate`, and a promise would cost a round trip.
 */
/** A compiled source location, as `__svelte_meta.loc` carries it. */
export interface GuestSourceLoc {
  file: string;
  line: number;
  column: number;
}

export interface GuestRuntimeHandle {
  setMode(mode: GuestMode): void;
  getMode(): GuestMode;
  /**
   * Select the element compiled from `loc`, as a click on it would: the
   * overlay moves and a `selectionChanged` observation goes out, so the host
   * re-resolves it with fresh proof. Returns false — and changes nothing —
   * when no such element is in the document. The host uses this to keep a
   * selection through its own write and the reload that follows.
   */
  reselect(loc: GuestSourceLoc): boolean;
  /** Repaint the overlay now, e.g. after a host-side zoom or fit change. */
  refresh(): void;
  /**
   * The overlay's shadow root, or null while nothing is drawn. The root is
   * closed, so this handle is the only way in — for the host and for tests.
   */
  getOverlayRoot(): ShadowRoot | null;
  dispose(): void;
}
