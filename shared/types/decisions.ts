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
  /** The relay this computer is set up with, as an origin; absent until one is entered. */
  relayOrigin?: string;
  /** When the person agreed to what Decisions sends; absent until they have. */
  consentedAt?: number;
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
