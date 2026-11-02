/**
 * How Decisions on the owner's computer reaches its Remote Hosts to enroll
 * them (#16021), without either side importing the other: the Remote Hosts
 * client publishes a port through `serviceRefs.ts`, and Decisions, loaded
 * only once it is on, reads it. Types and one bound, so importing this costs
 * nothing.
 */

/** The most a Host's or the library's own words may run to, wherever they are shown. */
export const MAX_HOST_DETAIL_LENGTH = 300;

/** Words bounded to {@link MAX_HOST_DETAIL_LENGTH}; undefined when there are none. */
export function boundedDetail(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > MAX_HOST_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_HOST_DETAIL_LENGTH - 1)}…`
    : trimmed;
}

/** What a Host holds as its Decisions identity, public parts only. */
export type HostIdentityReport =
  | { kind: "none" }
  | {
      kind: "host";
      relayOrigin: string;
      installationId: string;
      deviceId: string;
      /** The owner the Host's certificate chains to. */
      ownerDeviceId: string;
      signingPub: string;
      exchangePub: string;
    }
  /** An owner's identity of its own, a staged setup included. */
  | { kind: "owner" }
  /** A key file the Host couldn't open (`detail` says why). */
  | { kind: "unreadable"; detail?: string };

/**
 * Why a Host refused a step:
 *
 * - `own-setup`: it holds an owner identity of its own.
 * - `enrolled`: it holds a Host identity other than the one named to replace.
 * - `no-keychain`: its keychain can't seal keys now (`detail` says why).
 * - `unreadable`: its key file couldn't be read.
 * - `stale-attempt`: the attempt isn't one it holds for this link.
 * - `rejected`: the enrollment didn't verify against its request.
 * - `unsaved`: it verified, but the identity couldn't be saved.
 */
export type HostEnrollRefusalReason =
  | "own-setup"
  | "enrolled"
  | "no-keychain"
  | "unreadable"
  | "stale-attempt"
  | "rejected"
  | "unsaved";

export interface HostEnrollRefusal {
  step: "refused";
  reason: HostEnrollRefusalReason;
  detail?: string;
}

export type HostRequestResult =
  /** The Host's self-signed request: its device id, label and public keys, nothing private. */
  { step: "requested"; request: string } | HostEnrollRefusal;

export type HostAcceptResult = { step: "accepted"; deviceId: string } | HostEnrollRefusal;

/**
 * A CALL that didn't come back with an answer this Daintree reads:
 *
 * - `needs-update`: the Host doesn't know the method.
 * - `disconnected`: the link closed before the CALL went out.
 * - `outcome-unknown`: it went out and the link closed or timed out first,
 *   so the Host may have acted on it.
 * - `unexpected-answer`: an answer in a shape this side doesn't read.
 * - `failed`: the Host's handler failed (`detail`).
 */
export type HostCallFailure =
  "needs-update" | "disconnected" | "outcome-unknown" | "unexpected-answer" | "failed";

export type HostCallOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: HostCallFailure; detail?: string };

/** One Host link session. A new connection is a new link, never this one again. */
export interface DecisionsHostLink {
  readonly isOpen: boolean;
  onClose(listener: () => void): () => void;
  /** Keeps the Host's connection from idling out until released. */
  hold(): () => void;
  status(): Promise<HostCallOutcome<HostIdentityReport>>;
  request(input: {
    attempt: string;
    label: string;
    replace?: string;
  }): Promise<HostCallOutcome<HostRequestResult>>;
  accept(input: { attempt: string; response: string }): Promise<HostCallOutcome<HostAcceptResult>>;
}

export interface DecisionsHostEntry {
  hostId: string;
  name: string;
}

/** The Remote Hosts client's side of Host enrollment, as Decisions sees it. */
export interface DecisionsHostsPort {
  /** Every Host in this computer's host list. */
  hosts(): DecisionsHostEntry[];
  /** The Host's current link, or null while it has none. Never dials. */
  linkFor(hostId: string): DecisionsHostLink | null;
  /** Every new link as it comes up, before any view calls through it. */
  onLinkOpened(listener: (hostId: string, link: DecisionsHostLink) => void): () => void;
  /** The host list or a Host's connection changed. */
  onHostsChanged(listener: () => void): () => void;
}
