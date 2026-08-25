/**
 * The Daintree Assistant ACCOUNT surface.
 *
 * Daintree does not implement sign-in. The assistant CLI owns the credential — it is the
 * only process that touches the OS keychain, the only one that refreshes a rotating
 * token, and the only one that can coordinate that across the several modes it runs in
 * (a terminal session, the embedded host, a per-project supervisor daemon). Electron
 * drives it and renders what it reports.
 *
 * That division is what these types encode, and the shape enforces it: there is NO field
 * anywhere below that can carry an access token, a refresh token, or an authorization
 * URL. The renderer cannot receive a credential because there is nowhere to put one.
 */

/** The CLI's typed local account state. Mirrors internal/auth/state.go. */
export type AssistantAccountState =
  | "unknown"
  | "signed_out"
  | "authorizing"
  | "signed_in_unverified"
  | "signed_in_active"
  | "signed_in_subscription_required"
  | "signed_in_subscription_inactive"
  | "refreshing"
  | "temporarily_unavailable"
  | "revoked"
  | "storage_unavailable";

/** Where the CLI keeps the credential. */
export type AssistantAccountStorageTier = "keychain" | "memory" | "unavailable";

/**
 * A redacted account snapshot, as reported by `auth status --json`.
 *
 * Every field here is display data. `subjectHash` is a one-way correlation id for
 * support, deliberately in place of the user id.
 */
export interface AssistantAccountStatus {
  state: AssistantAccountState;
  authenticated: boolean;
  environment?: string;
  backendUrl?: string;
  email?: string;
  subjectHash?: string;
  planId?: string;
  entitlementSource?: string;
  entitlementStale?: boolean;
  usageRemaining?: string;
  /** ISO-8601. The EXPIRY of the current access token, never the token. */
  accessExpiresAt?: string;
  sessionMaxAgeSeconds?: number;
  storageTier: AssistantAccountStorageTier;
  /**
   * Whether this deployment REFUSES anonymous requests.
   *
   * Distinct from "does it have accounts", and the distinction is the whole point. A
   * backend can have accounts configured while still serving anonymous callers — that is
   * exactly the middle of a staged rollout — and in that state being signed out is not a
   * reason to stop anyone working. Only `true` means a signed-out caller cannot succeed.
   *
   * Optional and tri-state on purpose: absent means the engine did not say, which is the
   * current case, and every consumer must treat that as "carry on" rather than assuming
   * either answer.
   */
  authRequired?: boolean;
  lastVerifiedAt?: string;
  lastErrorCode?: string;
  links?: { account?: string; subscribe?: string };
  authRevision?: string;
}

/**
 * Why the account surface is unavailable, when it is.
 *
 * `cli-too-old` is the case that matters during rollout: Daintree vendors the assistant
 * as a submodule, so a build can ship a CLI that predates the `auth` command entirely.
 * Reporting that as a generic failure would send someone to debug a sign-in that the
 * binary has never heard of.
 */
export type AssistantAccountUnavailableReason =
  "cli-missing" | "cli-too-old" | "cli-failed" | "timeout";

/**
 * Options for a status read.
 *
 * `refresh` matters for one specific moment: the user has just paid. The CLI's ordinary
 * status is deliberately I/O-free — it reports what is already on disk — so a plan bought
 * thirty seconds ago is invisible to it no matter how often it is asked. `--refresh` is
 * what makes the CLI go and ask the backend again, and without it the subscribe flow
 * would poll a cached answer forever and then tell the user their payment did nothing.
 *
 * It is off by default because it costs a network round trip, and the common case —
 * rendering the settings panel, checking a gate — wants the cheap local answer.
 */
export interface AssistantAccountStatusOptions {
  refresh?: boolean;
}

/**
 * The result of asking for status.
 *
 * The discriminant is `available`, NOT `ok`. The IPC layer auto-wraps every handler
 * return in an `{ok: true, data}` envelope, so a payload with its own `ok` would nest
 * one meaning of the word inside another — a returned `{ok: false}` arriving as a
 * SUCCESSFUL envelope containing a failure (see #6020, and ForbidIpcEnvelopeKeys, which
 * rejects it at compile time).
 *
 * It also reads better: "the account surface is unavailable" is a STATE the UI renders,
 * not an exception. A genuine fault throws.
 */
export type AssistantAccountStatusResult =
  | { available: true; status: AssistantAccountStatus }
  | { available: false; reason: AssistantAccountUnavailableReason; message: string };

/** Progress from an in-flight login, forwarded to the initiating window only. */
export type AssistantAccountLoginProgress =
  | { type: "starting"; environment?: string }
  | { type: "browser_opened"; url?: string }
  | { type: "waiting"; callback?: string; timeoutSeconds?: number }
  | { type: "authenticated" }
  | { type: "cancelled" }
  /**
   * The backend has no account layer, so there is nothing to sign in to.
   *
   * A member of its own because it is NOT an error: the CLI reports it and exits zero.
   * Without a case for it the attempt fell through to the generic failure tail and
   * reported "Sign-in did not complete." on the shipped local default.
   */
  | { type: "not_offered" }
  | { type: "error"; code?: string; message?: string };

/** The terminal outcome of a login attempt. Discriminated on `signedIn`, not `ok` — see
 * AssistantAccountStatusResult for why the envelope forbids that key. */
export type AssistantAccountLoginResult =
  { signedIn: true } | { signedIn: false; cancelled: boolean; code?: string; message: string };

/** Whether a login is currently running, and for which window. */
export interface AssistantAccountLoginState {
  inProgress: boolean;
}
