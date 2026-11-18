/**
 * How involved the person wants to be (Decisions protocol section 20):
 * `involve-early`, ask while exploring the options; `recommend`, consult
 * other agents first and bring a recommendation.
 */
export type DecisionsInvolvementMode = "involve-early" | "recommend";

/** Where the person set it: this owner computer, or a phone or tablet. For display only. */
export type DecisionsInvolvementSetOn = "computer" | "phone";

/**
 * Why no preference is in force, as the Decisions library reports it:
 * `not-synced`, this computer never heard from the relay about it;
 * `not-set`, nobody set one; `unsupported`, the relay doesn't serve
 * involvement preferences; `signer-revoked`, the device that set it was
 * removed; `device-revoked`, this computer was removed from the relay.
 */
export type DecisionsInvolvementUnavailableReason =
  "not-synced" | "not-set" | "unsupported" | "signer-revoked" | "device-revoked";

export interface DecisionsInvolvementOverride {
  mode: DecisionsInvolvementMode;
  /** ISO time the temporary mode ends (exclusive). */
  until: string;
}

/**
 * The preference as this computer last verified it, from its local copy:
 * agents' `get_involvement` reads the same copy. A temporary mode's end is
 * worked out when it is read, without a new revision, so `mode` and
 * `overrideActive` are only as current as the read.
 */
export type DecisionsInvolvementPreference =
  | {
      status: "available";
      normalMode: DecisionsInvolvementMode;
      consultCount: number;
      /** As the person set it, kept after it ends; `overrideActive` says whether it is in force. */
      override: DecisionsInvolvementOverride | null;
      /** The mode in force: the temporary one until it ends, then the normal one. */
      mode: DecisionsInvolvementMode;
      overrideActive: boolean;
      /** The revision a save replaces. */
      revision: number;
      setOn: DecisionsInvolvementSetOn;
      /** When the person set it, by the setting device's clock. */
      setAt: string;
      /** When this computer last confirmed it with the relay. */
      lastSyncedAt: string | null;
      /** Not confirmed since the last reconnect, change hint or failed read. */
      stale: boolean;
    }
  | {
      status: "unavailable";
      reason: DecisionsInvolvementUnavailableReason;
      revision: number;
      lastSyncedAt: string | null;
      stale: boolean;
    };

/**
 * The preference, read for Daintree's own view (#17237). `settable` is
 * whether this computer can change it now: it is the owner's and connected
 * to its relay. A Remote Host (`role: "host"`) shows it and never signs one.
 * `off`: Decisions is off here; `not-running`: no relay connection runs.
 */
export type DecisionsInvolvementRead =
  | {
      result: "read";
      preference: DecisionsInvolvementPreference;
      role: "owner" | "host";
      settable: boolean;
    }
  | { result: "off" }
  | { result: "not-running" };

/** A change the person made, replacing the revision they reviewed. */
export interface SetDecisionsInvolvementPayload {
  expectedRevision: number;
  normalMode: DecisionsInvolvementMode;
  consultCount: number;
  override: DecisionsInvolvementOverride | null;
}

/**
 * Where a change stands:
 * - `saved`: the relay took it, and agents' next `get_involvement` reads it;
 * - `conflict`: the relay holds a revision other than the one the person
 *   reviewed (`latestRevision`, when it said); nothing was saved, and the
 *   copy has been read again;
 * - `unsupported`: the relay doesn't take involvement preferences;
 * - `unconfirmed`: its fate is unknown (the relay couldn't be reached, its
 *   reply was unreadable, or something here failed after it was sent), so
 *   it may or may not have been saved; read it again;
 * - `refused`: `not-owner` on a Remote Host, whose key never signs one;
 *   `revoked`, the relay removed this computer; `invalid`, the relay would
 *   refuse it, as `detail` says; `relay`, the relay refused it with `code`.
 */
export type DecisionsInvolvementSaveResult =
  | { result: "saved"; revision: number }
  | { result: "conflict"; latestRevision: number | null }
  | { result: "unsupported" }
  | { result: "unconfirmed" }
  | { result: "refused"; reason: "not-owner" }
  | { result: "refused"; reason: "revoked" }
  | { result: "refused"; reason: "invalid"; detail: string }
  | { result: "refused"; reason: "relay"; code: string }
  | { result: "off" }
  | { result: "not-running" };
