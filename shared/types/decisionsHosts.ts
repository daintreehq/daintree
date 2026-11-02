/**
 * Remote Hosts as Decisions devices (#16021), as the owner's computer last
 * observed each one. Every enrolled Host is its own `desktop-host` device on
 * the relay, holding its own keys; this computer issues its certificate and
 * grant over the Host's authenticated link.
 */

/**
 * Why an enrollment didn't finish, as observed:
 *
 * - `no-keychain`: the Host has no keychain that could seal its keys (a Linux
 *   Host with no keyring, a locked or refused keychain). Nothing was sent to
 *   the relay.
 * - `host-keys-unreadable`: the Host has a Decisions key file it couldn't read.
 * - `host-refused`: the Host refused the enrollment (`detail` says why).
 * - `relay-unreachable` / `relay-refused`: the relay didn't answer, or refused
 *   this computer's signed request.
 * - `owner-keys`: this computer's own Decisions keys couldn't be opened.
 * - `relay-full`: the relay already holds as many devices as it allows.
 * - `relay-rejected`: the relay or the enrollment itself refused the Host's
 *   request (`detail` says why).
 * - `disconnected`: the Host's link closed before the enrollment finished.
 * - `outcome-unknown`: the link dropped while the Host was saving its
 *   identity, so it may hold it; its next connection says.
 * - `unexpected-answer`: the Host answered in a shape this Daintree doesn't read.
 * - `records-unavailable`: this computer's Decisions store couldn't be read
 *   or written, so nothing was enrolled.
 */
export type DecisionsHostFailureReason =
  | "no-keychain"
  | "host-keys-unreadable"
  | "host-refused"
  | "relay-unreachable"
  | "relay-refused"
  | "owner-keys"
  | "relay-full"
  | "relay-rejected"
  | "disconnected"
  | "outcome-unknown"
  | "unexpected-answer"
  | "records-unavailable";

export interface DecisionsHostFailure {
  reason: DecisionsHostFailureReason;
  /** The Host's or the library's own words, bounded; absent when the reason says it all. */
  detail?: string;
  /** When it failed (epoch ms). */
  at: number;
}

/**
 * One Host's enrollment, as observed:
 *
 * - `unchecked`: connected, but not asked yet (Decisions isn't connected).
 * - `checking` / `enrolling`: being asked, or being enrolled, now.
 * - `enrolled`: the Host holds an identity the relay lists as active.
 * - `not-enrolled`: the Host holds no identity, and automatic enrollment is
 *   off (or was refused for it).
 * - `revoked`: its device was revoked. It is never enrolled automatically
 *   again; Enroll does it.
 * - `stale`: the Host holds an identity from this relay that the relay
 *   doesn't list.
 * - `own-setup`: the Host has its own Decisions setup as an owner, which is
 *   never replaced from here.
 * - `other-setup`: the Host is enrolled with another relay or owner, which
 *   is never replaced from here.
 * - `needs-update`: the Host's Daintree doesn't know enrollment.
 * - `failed`: the last attempt didn't finish (`failure`); it is tried again
 *   on the Host's next connection.
 */
export type DecisionsHostEnrollment =
  | { state: "unchecked" }
  | { state: "checking" }
  | { state: "enrolling" }
  | { state: "enrolled"; deviceId: string }
  | { state: "not-enrolled" }
  | { state: "revoked" }
  | { state: "stale" }
  | { state: "own-setup" }
  | { state: "other-setup" }
  | { state: "needs-update" }
  | { state: "failed"; failure: DecisionsHostFailure };

export interface DecisionsHost {
  /** The Host's id in this computer's host list. */
  hostId: string;
  /** Its name in the host list. */
  name: string;
  /** Its link is up now. Enroll needs it. */
  connected: boolean;
  enrollment: DecisionsHostEnrollment;
  /** Enroll would do something now: connected, and not enrolled or busy. */
  canEnroll: boolean;
}

/**
 * The Hosts Settings shows: every connected one, and every one this computer
 * has enrolled or seen revoked. `not-set-up`: no relay identity of an owner here.
 */
export type DecisionsHostsResult =
  | { result: "listed"; autoEnroll: boolean; hosts: DecisionsHost[] }
  | { result: "not-set-up" };

export interface EnrollDecisionsHostPayload {
  hostId: string;
}

/** Enroll on one Host: what became of it, or why it couldn't start. */
export type DecisionsHostEnrollResult =
  | { result: "done"; host: DecisionsHost }
  | { result: "not-connected" }
  | { result: "not-set-up" };
