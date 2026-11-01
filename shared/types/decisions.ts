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
 * Exporting this computer's decision history (#16025). The archive is
 * encrypted with the passphrase, which goes no further than the encryption.
 */
export interface ExportDecisionsDataPayload {
  passphrase: string;
}

/** The shortest export passphrase the library's archive encryption accepts. */
export const DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH = 12;

/**
 * What an export observed (#16025). Only `saved` wrote a file.
 *
 * - `saved`: the encrypted archive is at `path`, holding the questions and
 *   audit events counted.
 * - `cancelled`: no file was chosen, or Decisions stopped before one was written.
 * - `no-identity`: this computer holds no complete Decisions identity, so the
 *   stored history, sealed under its keys, can't be opened.
 * - `key-storage`: the keys couldn't be read.
 * - `store-unavailable`: the stored history isn't open (it couldn't be opened
 *   when Decisions started).
 */
export type DecisionsExportResult =
  | { result: "saved"; path: string; questions: number; auditEvents: number }
  | { result: "cancelled" }
  | { result: "no-identity" }
  | { result: "key-storage"; kind: DecisionsKeyStorageFailure; reason: string }
  | { result: "store-unavailable" };

/**
 * Deleting the relay's stored questions, answers and attachments (#16025).
 * `origin` is the relay the person confirmed, so a relay set up since then is
 * never the one deleted from.
 */
export interface DeleteDecisionsRelayDataPayload {
  origin: string;
}

/** Why the relay refused a deletion. Nothing was deleted for any of them. */
export type DecisionsRelayDeleteRefusal =
  /** It doesn't accept this computer as its owner. */
  | "not-recognised"
  | "rate-limited"
  | "rejected";

/**
 * What deleting the relay's data observed (#16025). This computer's history,
 * keys and settings are untouched by every one of them.
 *
 * - `deleted`: the relay answered that its questions, answers and attachments are deleted.
 * - `not-sent`: the request never reached the relay; nothing there changed.
 * - `unconfirmed`: the request may have reached the relay, but no answer
 *   confirmed it (`server-error`: it answered with a failure;
 *   `unexpected-answer`: a success that wasn't the relay's). The relay may
 *   have deleted some or all of it.
 * - `refused`: the relay refused the request.
 * - `changed`: the relay set up here is no longer the one confirmed (`origin`
 *   is the one set up now, null for none); nothing was sent.
 * - `no-identity`: this computer holds no owner identity for the relay, so it can't sign the request.
 * - `key-storage`: the keys couldn't be read.
 */
export type DecisionsRelayDeleteResult =
  | { result: "deleted"; origin: string }
  | { result: "not-sent"; origin: string; reason: DecisionsRelayUnreachableReason }
  | {
      result: "unconfirmed";
      origin: string;
      reason: DecisionsRelayUnreachableReason | "server-error" | "unexpected-answer";
    }
  | { result: "refused"; origin: string; reason: DecisionsRelayDeleteRefusal; status: number }
  | { result: "changed"; origin: string | null }
  | { result: "no-identity"; origin: string }
  | { result: "key-storage"; kind: DecisionsKeyStorageFailure; reason: string };

/**
 * What deleting this computer's Decisions data observed (#16025): its stored
 * history, its keys and its record of the relay. Nothing is sent to the relay.
 *
 * - `deleted`: all three are gone; `status` is Decisions as it is now.
 * - `failed`: nothing was deleted (`disk-pressure`: writes are refused while
 *   disk space is critical; `storage`: the database refused; `keys`: the key
 *   file couldn't be moved).
 * - `incomplete`: the history is deleted, but a last step didn't finish;
 *   Decisions finishes it the next time it starts, and holds no history until then.
 */
export type DecisionsLocalDeleteResult =
  | { result: "deleted"; status: DecisionsStatus }
  | { result: "failed"; reason: "disk-pressure" | "storage" | "keys" }
  | { result: "incomplete"; status: DecisionsStatus };

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
