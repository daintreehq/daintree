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
  "off" | "not-connected" | "connecting" | "connected" | "reconnecting" | "replaced" | "revoked";

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

/** How strictly a question needs a person: only a person, or a proxy answer may do. */
export type DecisionsRequirement = "human-required" | "proxy-ok" | "proxy-first";

/**
 * A trusted workflow gate as Daintree registers it (#16013), for Settings to
 * show. Daintree defines every gate; nothing an agent sends can add, change
 * or loosen one, and Settings only reads them.
 */
export interface DecisionsWorkflowGate {
  /** The id a question names in `workflow_gate_id`. */
  id: string;
  /** The least strict a question under it can be; an agent can only ask for stricter. */
  requirement: DecisionsRequirement;
  /** The only answers it accepts. Empty when the gate leaves the options to the agent. */
  choices: { id: string; label: string }[];
  /** Whether an answer may carry free text. */
  allowsText: boolean;
  /**
   * Whether an answer binds to the question's attached images: the question
   * must carry them, and `get_decision` reports whether the person's answer
   * came from a phone that showed exactly those.
   */
  bindsAttachments: boolean;
}

/** The rules questions are asked under on this computer, as main applies them. */
export interface DecisionsPolicy {
  gates: DecisionsWorkflowGate[];
  /** Whether a question without a registered gate may accept a proxy answer, when its agent allows one. */
  proxyAllowlisted: boolean;
  /**
   * How long a question with no origin gate waits when its agent sets no
   * expiry, in ms, or null for no expiry. The client library's own rule,
   * read from it; Daintree has no way to change it yet.
   */
  defaultQuestionExpiryMs: number | null;
  /** The latest expiry such a question's agent can ask for, in ms after asking; null for no limit. */
  maxQuestionExpiryMs: number | null;
  /**
   * Increases with each change main saves, so a read that lands after a
   * newer change can't roll it back.
   */
  revision: number;
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
  "not-recognised" | "rate-limited" | "rejected";

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
 * - `incomplete`: a step didn't finish. With `erased`, the history is
 *   deleted but the keys or the relay record are still to go; with it false,
 *   nothing was deleted, but the keys couldn't be put back where they were;
 *   null when the history couldn't be read to tell which.
 *   Deleting again finishes or undoes it, and so does the next start when
 *   keys were involved. Decisions holds no store until then.
 */
export type DecisionsLocalDeleteResult =
  | { result: "deleted"; status: DecisionsStatus }
  | { result: "failed"; reason: "disk-pressure" | "storage" | "keys" }
  | { result: "incomplete"; erased: boolean | null; status: DecisionsStatus };

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

/** Why a signed request to the relay didn't go through. Nothing changed on the relay for any of them. */
export type DecisionsRelayRequestFailure =
  /** No relay is set up on this computer, or its keys aren't an owner's. */
  | { result: "not-set-up" }
  /** No answer from the relay (`server-error`: it answered with a failure). */
  | {
      result: "unreachable";
      origin: string;
      reason: DecisionsRelayUnreachableReason | "server-error";
    }
  /**
   * The relay refused this computer's request: it no longer accepts this
   * device (`not-recognised`), or it is limiting requests (`rate-limited`).
   */
  | { result: "refused"; origin: string; reason: "not-recognised" | "rate-limited" }
  | { result: "key-storage"; kind: DecisionsKeyStorageFailure; reason: string };

/** A role on the relay, as the device's owner-signed certificate states it. */
export type DecisionsDeviceRole = "owner-desktop" | "desktop-host" | "phone" | "tablet";

/**
 * A device paired with this computer's relay identity, as the relay listed it
 * and its owner-signed certificate verified (#16009). Revoked devices and this
 * computer itself aren't listed.
 */
export interface DecisionsDevice {
  deviceId: string;
  /** The name the device gave itself when it paired, as its certificate signs it. */
  label: string;
  role: DecisionsDeviceRole;
  /** When the relay registered it, ISO 8601. */
  pairedAt: string;
  /** The relay's last authenticated request from it, ISO 8601; null if none since pairing. */
  lastSeenAt: string | null;
  /**
   * The relay holds an enabled push subscription for it. It turns a
   * subscription off when the push service refuses it for good.
   */
  pushEnabled: boolean;
}

export type DecisionsDevicesResult =
  { result: "listed"; devices: DecisionsDevice[] } | DecisionsRelayRequestFailure;

/** A one-time invitation for a phone to pair (#16009). Its secret is in `url`'s fragment. */
export interface DecisionsPairingInvitation {
  pairingId: string;
  /** `https://<relay>/pair#<payload>`: what the QR code holds, and the link shown as text. */
  url: string;
  /** Epoch ms. The relay refuses the invitation after this. */
  expiresAt: number;
}

/**
 * Making an invitation. `full`: the relay holds as many devices as it allows.
 * `busy`: it has too many invitations open; one frees within five minutes.
 */
export type DecisionsPairingStartResult =
  | { result: "started"; invitation: DecisionsPairingInvitation }
  | { result: "full" }
  | { result: "busy" }
  | DecisionsRelayRequestFailure;

/**
 * An invitation as main last read it from the relay.
 *
 * - `waiting`: no phone has answered it yet.
 * - `responded`: a phone answered. `code` is computed here from the keys the
 *   phone sent, never taken from the relay, so the person compares what this
 *   computer would approve with what the phone shows.
 * - `paired`: the phone that answered is now a device on the relay; read
 *   when an approval's answer was lost on the way back.
 * - `expired`: it lapsed with no approval.
 * - `unknown`: this computer didn't make it, or forgot it (Decisions turned
 *   off, the relay was disconnected).
 */
export type DecisionsPairingState =
  | { state: "waiting"; expiresAt: number }
  | {
      state: "responded";
      expiresAt: number;
      /** Six digits, ungrouped. */
      code: string;
      /** The name the phone gave itself. */
      label: string;
      role: "phone" | "tablet";
    }
  | { state: "paired"; label: string }
  | { state: "expired" }
  | { state: "unknown" }
  | DecisionsRelayRequestFailure;

/** Approving the phone that answered an invitation, once the person saw `code` on both screens. */
export interface ApproveDecisionsPairingPayload {
  pairingId: string;
  /** The code the person was shown and compared. Main approves only the keys it was computed from. */
  code: string;
}

/**
 * - `paired`: the relay registered the phone, with a certificate and this
 *   epoch's key sealed to it.
 * - `expired`: the invitation lapsed first.
 * - `changed`: what the relay holds isn't what was shown (another answer, or
 *   already settled), or the relay's own code disagreed with the phone's keys.
 *   Nothing was approved.
 * - `full`: the relay holds as many devices as it allows.
 */
export type DecisionsPairingApproveResult =
  | { result: "paired"; label: string }
  | { result: "expired" }
  | { result: "changed" }
  | { result: "full" }
  | DecisionsRelayRequestFailure;

/** Declining: the relay rejects the invitation, so the phone can't use it. */
export type DecisionsPairingDeclineResult = { result: "declined" } | DecisionsRelayRequestFailure;
