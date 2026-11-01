/**
 * Daintree Decisions, as kept in settings (#15998): one global switch on the
 * owner's machine, and the non-secret record of which relay this machine talks
 * to and who it is there. Claim secrets, keys and tokens never live here; the
 * identity itself is sealed by the OS keychain.
 *
 * A field added later gets a default in the sanitiser and an owner in the
 * settings catalog, and needs no migration: a value missing on disk reads as
 * its default.
 */
export interface DecisionsSettings {
  /** Off until the person turns it on. While off, nothing of Decisions loads. */
  enabled: boolean;
  /** The relay's origin, `https://…` (plain `http` only on loopback); null until one is entered. */
  relayOrigin: string | null;
  /** The relay installation this machine belongs to; null until it claims or restores one. */
  installationId: string | null;
  /**
   * This machine's device on that relay, as the owner's desktop. An enrolled
   * Remote Host keeps its own identity in its own keychain store, never here.
   */
  deviceId: string | null;
  /**
   * This machine's Decisions host id. Daintree's own "local" is only unique
   * per machine, so questions name their host by this instead.
   */
  hostId: string | null;
  /**
   * Whether a question with no trusted workflow gate may accept a proxy
   * answer (the client library's `proxyAllowlisted`). Off unless the person
   * turns it on.
   */
  proxyAllowlisted: boolean;
}

/**
 * Decisions as main last observed it. `off` until the setting is on;
 * `not-connected` while on with no relay connection; `connecting` and
 * `connected` follow the relay socket (#16008); `revoked` once the relay has
 * refused this device for good, after which nothing reconnects.
 */
export type DecisionsState = "off" | "not-connected" | "connecting" | "connected" | "revoked";

export interface DecisionsStatus {
  state: DecisionsState;
}

export type DecisionsStatusEvent = { type: "status-changed"; status: DecisionsStatus };
