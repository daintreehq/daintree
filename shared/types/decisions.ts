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
  /**
   * When the person agreed to what Decisions sends and where (epoch ms), the
   * first time they turned it on; null until then. The switch asks first
   * while it is null.
   */
  consentedAt: number | null;
  /**
   * When the relay revoked this computer's identity (epoch ms), as observed:
   * a 4401 close, a refused socket ticket, or the ledger's own revocation of
   * this device. Null until then. Once set, Decisions never connects with
   * that identity again; disconnecting clears it with the relay's ids.
   */
  revokedAt: number | null;
}

/**
 * Decisions as main last observed it (#16008 follows the relay socket):
 *
 * - `off`: the setting is off.
 * - `not-connected`: on, with no relay set up, or one that can't be used
 *   (`problem` says why).
 * - `connecting`: an attempt is under way: a socket ticket, then the socket,
 *   until the relay's first frame.
 * - `connected`: the relay's first frame arrived on an open socket.
 * - `reconnecting`: the last attempt or socket closed; the next attempt is
 *   at `nextAttemptAt`.
 * - `replaced`: the relay closed this socket for a newer one with the same
 *   identity (4409), most likely another Daintree using these keys. Daintree
 *   waits longer before trying again (`nextAttemptAt`), so the two don't take
 *   turns knocking each other off.
 * - `revoked`: the relay revoked this computer; nothing reconnects.
 */
export type DecisionsState =
  | "off"
  | "not-connected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "replaced"
  | "revoked";

/**
 * Why a relay that is set up isn't being connected to, while `not-connected`:
 *
 * - `keys`: this computer's Decisions keys couldn't be read (a locked or
 *   refused keychain, a missing or damaged file), or they belong to another
 *   relay or device than the one recorded.
 * - `storage`: the local Decisions database couldn't be opened or stopped
 *   accepting writes, so nothing received could be kept.
 * - `other-relay`: the local database holds what another relay identity
 *   sent, and its positions in that relay's ledger can't be reused here.
 */
export type DecisionsConnectionProblem = "keys" | "storage" | "other-relay";

export interface DecisionsStatus {
  state: DecisionsState;
  /** While `reconnecting` or `replaced`: when the next attempt starts (epoch ms). */
  nextAttemptAt?: number;
  /** While `not-connected` with a relay set up: why nothing connects. */
  problem?: DecisionsConnectionProblem;
  /** The relay this computer claimed or restored, as an origin; absent until it has one. */
  relayOrigin?: string;
  /** When the person agreed to what Decisions sends; absent until they have. */
  consentedAt?: number;
  /**
   * This computer's Decisions key file exists. Read only while on, from the
   * file's presence alone, so it never asks the keychain. With no relay set
   * up, it is the keys of a setup that didn't finish.
   */
  keysStored?: true;
  /**
   * Increases with each change main pushes on `decisions:status-changed`, so
   * a read that lands after a newer push can't roll it back. Absent from an
   * answer main gave without Decisions loaded, which only an off switch does.
   */
  revision?: number;
}

/**
 * Turning Decisions on or off from Settings. `consent` is the person agreeing,
 * in the consent dialog, to what leaves the machine; turning it on is refused
 * without it until they have agreed once.
 */
export interface SetDecisionsEnabledPayload {
  enabled: boolean;
  consent?: boolean;
}

export type DecisionsStatusEvent = { type: "status-changed"; status: DecisionsStatus };

/** A protocol range and relay release, as one side of the compatibility check reports them. */
export interface DecisionsRelayVersions {
  protocolMin: number;
  protocolMax: number;
  workerVersion: string;
}

/**
 * The relay's versions beside Daintree's own: the protocol range it speaks and
 * the relay release its Decisions libraries came with. `diverges` is whether
 * any of the three differ, compatible or not. Daintree never updates a relay;
 * it only says so.
 */
export interface DecisionsRelayCompatibility {
  relay: DecisionsRelayVersions;
  daintree: DecisionsRelayVersions;
  diverges: boolean;
}

/** Which of the relay's two unsigned reads an observation came from. */
export type DecisionsRelayEndpoint = "health" | "info";

/** Why a request to the relay got no answer. Never the request's own error text. */
export type DecisionsRelayUnreachableReason =
  "timeout" | "dns" | "refused" | "certificate" | "network";

/**
 * What main observed checking a relay URL, through its unsigned `/health`
 * then `/api/v1/info` (#16005). Only the normalised origin is ever echoed
 * back, never what was typed, so a token pasted into a URL goes no further.
 *
 * - `invalid-url`: not an `https://` address, or one carrying a user name or
 *   password; nothing was sent.
 * - `unreachable`: no HTTP answer at all.
 * - `http-error`: a server error or rate limit (`status`), as a failing relay would answer.
 * - `not-a-relay`: an answer, but not a Decisions relay's: a redirect elsewhere,
 *   another error status (a 404, say), or a body that isn't the relay's.
 * - `incompatible`: a Decisions relay whose protocol range doesn't overlap Daintree's.
 * - `claim-not-configured`: unclaimed, with no claim secret set on the relay, so it can't be claimed yet.
 * - `unclaimed`: ready to be claimed with its claim secret.
 * - `claimed`: an owner has already claimed it.
 */
export type DecisionsRelayCheck =
  | { result: "invalid-url"; reason: "unparsable" | "not-https" | "credentials" }
  | {
      result: "unreachable";
      origin: string;
      endpoint: DecisionsRelayEndpoint;
      reason: DecisionsRelayUnreachableReason;
    }
  | { result: "http-error"; origin: string; endpoint: DecisionsRelayEndpoint; status: number }
  | {
      result: "not-a-relay";
      origin: string;
      endpoint: DecisionsRelayEndpoint;
      answered: "redirect" | "status" | "body";
      /** The status when it `answered` one. */
      status: number | null;
    }
  | {
      result: "incompatible" | "claim-not-configured" | "unclaimed" | "claimed";
      origin: string;
      compatibility: DecisionsRelayCompatibility;
    };

/**
 * Claiming a fresh relay (#16006). The secret goes to the relay once, from
 * main, and is kept nowhere. `acceptWeakStorage` is the person accepting
 * Linux's fixed-key storage after Daintree said it was all there was.
 */
export interface ClaimDecisionsRelayPayload {
  url: string;
  claimSecret: string;
  acceptWeakStorage?: boolean;
}

/**
 * Restoring an identity from a recovery kit (#16006): the kit file's text
 * and its passphrase, neither kept after the attempt.
 */
export interface RestoreDecisionsIdentityPayload {
  url: string;
  kit: string;
  passphrase: string;
  acceptWeakStorage?: boolean;
}

/** Why the relay refused a claim outright. */
export type DecisionsClaimRefusal =
  "wrong-secret" | "already-claimed" | "not-configured" | "rate-limited" | "rejected";

/** Why a recovery kit wasn't restored. Nothing was saved for any of them. */
export type DecisionsKitRefusal =
  /** Not a Decisions recovery kit, or one whose keys don't work. */
  | "not-a-kit"
  /** The passphrase didn't open it, or the file is damaged. */
  | "wrong-passphrase"
  /** A kit for a different relay than the one checked. */
  | "another-relay"
  /** An enrolled Host's identity, not the owner's. */
  | "not-owner"
  /** Saved from a setup the relay never confirmed. */
  | "unfinished"
  /** The relay doesn't accept this identity: not its owner, or revoked. */
  | "not-recognised";

/** The key store's refusals that stop a setup, as `DecisionsKeyStoreError` names them. */
export type DecisionsKeyStorageFailure =
  | "locked"
  | "unavailable"
  | "timeout"
  | "weak-storage-unconfirmed"
  | "unreadable"
  | "unsupported-format";

/**
 * What a claim or a restore observed (#16006). Only `saved` changed the
 * setting. Otherwise nothing new is left on this computer, except where
 * `kept` says the keys of an unfinished claim stay, because the relay may
 * have accepted it and only those keys could finish it.
 *
 * - `saved`: the identity is sealed and the relay origin and ids are recorded.
 * - `relay`: the relay's unsigned check stopped it first (unreachable, not a
 *   relay, incompatible, or claimed when claiming / unclaimed when restoring).
 * - `refused`: the relay refused the claim.
 * - `unreachable`: no answer from the relay (`server-error`: it answered with
 *   a failure), so it is unknown whether a claim arrived.
 * - `kit-refused`: the recovery kit wasn't restored.
 * - `conflict`: this computer already holds keys for another relay or
 *   identity (`unfinished` when they are an unfinished claim's), or a relay
 *   is already set up; they have to be removed first.
 * - `key-storage`: the keys couldn't be read or sealed.
 */
export type DecisionsConnectResult =
  | { result: "saved"; status: DecisionsStatus }
  | { result: "relay"; check: DecisionsRelayCheck }
  | { result: "refused"; origin: string; reason: DecisionsClaimRefusal; kept: boolean }
  | {
      result: "unreachable";
      origin: string;
      reason: DecisionsRelayUnreachableReason | "server-error";
      kept: boolean;
    }
  | { result: "kit-refused"; origin: string; reason: DecisionsKitRefusal }
  | { result: "conflict"; origin: string | null; unfinished: boolean }
  | {
      result: "key-storage";
      kind: DecisionsKeyStorageFailure;
      reason: string;
      /** The claim's staged keys saved before this failed, and stay, since the relay may have taken it. */
      kept?: true;
    };

/**
 * How far an answer has got on its way into the terminal, as the client
 * library records it per question. Mirrors its `LocalDeliveryStatus`.
 */
export type DecisionDeliveryStatus =
  | "not-sent"
  | "relay-queued"
  | "desktop-received"
  | "pending-host"
  | "needs-attention"
  | "delivery-uncertain"
  | "terminal-delivered";

/** A question the pane asked that has not been answered, cancelled or expired. */
export interface PaneDecisionQuestion {
  questionId: string;
  /** The `N` of the `q-N` the agent was told. */
  alias: number;
  /** `queued` until the relay has the question, then `open`. */
  status: "queued" | "open";
  /** When the pane asked, ISO 8601 as recorded. */
  askedAt: string;
  /** ISO 8601 as recorded; null when the question never expires. */
  expiresAt: string | null;
}

/** Something received for the pane that has not been typed into it yet. */
export interface PaneDecisionWaiting {
  questionId: string;
  alias: number;
  /** An answer (or correction), or only the notice that the question expired unanswered. */
  kind: "answer" | "expired";
  deliveryStatus: Exclude<DecisionDeliveryStatus, "needs-attention" | "delivery-uncertain">;
}

/** A question whose delivery stopped and needs a person to decide what happens next. */
export interface PaneDecisionAttention {
  questionId: string;
  alias: number;
  /** `delivery-uncertain`: the answer may or may not have been typed. */
  deliveryStatus: "needs-attention" | "delivery-uncertain";
  /** The library's code for why (`pane_gone`, `inject_ambiguous`, …); `unspecified` when none was recorded. */
  reason: string;
}

/**
 * One pane's Decisions state as main last observed it, pushed on
 * `terminal:decision-state` to the pane's project views and read on mount
 * with `decisions:get-pane-state`. It names questions by id and alias only:
 * no question, option or answer text ever rides it. Empty lists mean
 * nothing is outstanding for the pane.
 */
export interface PaneDecisionState {
  terminalId: string;
  openQuestions: PaneDecisionQuestion[];
  waitingAnswers: PaneDecisionWaiting[];
  needsAttention: PaneDecisionAttention[];
  /**
   * Increases with every change, so a late snapshot never overwrites a newer
   * push. Never behind the sender's wall clock in ms, so a restarted Host's
   * pushes outrank its previous run's.
   */
  revision: number;
}
