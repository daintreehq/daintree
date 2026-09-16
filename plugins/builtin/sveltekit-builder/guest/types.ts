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
 * What the host drives after injection. Everything is synchronous: the host
 * calls these over `Runtime.evaluate`, and a promise would cost a round trip.
 */
export interface GuestRuntimeHandle {
  setMode(mode: GuestMode): void;
  getMode(): GuestMode;
  /** Repaint the overlay now, e.g. after a host-side zoom or fit change. */
  refresh(): void;
  /**
   * The overlay's shadow root, or null while nothing is drawn. The root is
   * closed, so this handle is the only way in — for the host and for tests.
   */
  getOverlayRoot(): ShadowRoot | null;
  dispose(): void;
}
