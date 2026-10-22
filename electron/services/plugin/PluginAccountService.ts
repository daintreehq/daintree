import path from "path";
import { createHash, randomBytes } from "crypto";
import { net } from "electron";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import { safeStorageCipher, type SecretCipher } from "./secretCipher.js";
import { isSafePluginInstanceId } from "./projectPluginIdentity.js";
import {
  cancelOAuthLoopback,
  startAuthorizationCodeLoopback,
  type AuthorizationCodeLoopbackResult,
} from "../OAuthLoopbackService.js";
import {
  createListenerFailureState,
  invokeTrackedListener,
  type ListenerFailureState,
} from "./pluginCallbackUtils.js";
import type {
  PluginAccountAccessToken,
  PluginAccountConnectResult,
  PluginAccountContribution,
  PluginAccountState,
  PluginAccountUiStatus,
  PluginManifest,
} from "../../../shared/types/plugin.js";

/** The keychain-encrypted credentials. Never leaves this module except as an access token. */
interface StoredCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

type OAuthAccount = Extract<PluginAccountContribution, { kind: "oauth2" }>;

/**
 * Store keys. Identity and the configuration fingerprint are plain so the
 * settings row can show the account without a keychain prompt.
 */
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = "identity";
const CONFIG_KEY = "config";

/** Refresh this long before the service says the token expires. */
export const ACCOUNT_REFRESH_SKEW_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const IDENTITY_REQUEST_TIMEOUT_MS = 15_000;
/** Bounds on what a service may send back; anything larger is not a token response. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_IDENTITY_LENGTH = 200;
const SESSION_PREFIX = "plugin-account\u0000";
/** A token read that keeps losing to concurrent sign-ins and sign-outs gives up after this many. */
const MAX_TOKEN_READ_ATTEMPTS = 3;

/**
 * The error codes RFC 6749 §4.1.2.1 and §5.2 define. Only these are repeated
 * to the user: a service's own `error` text is free-form and can echo what it
 * was sent.
 */
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

/** A service refusal worth naming to the user: the OAuth `error` code, never its free text. */
class AccountRequestError extends Error {
  constructor(
    message: string,
    readonly oauthError: string | null = null,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "AccountRequestError";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface PluginAccountServiceDeps {
  /** Root of the plugin settings tree; accounts live under `<root>/accounts`. */
  getSettingsRoot: () => string;
  getManifest: (pluginId: string) => PluginManifest | undefined;
  /**
   * Told after any account connects, disconnects, changes identity, or starts
   * or ends a browser sign-in. Carries no state: a listener re-reads it.
   */
  onAccountChanged?: (pluginId: string) => void;
  cipher?: SecretCipher;
  fetch?: FetchLike;
  now?: () => number;
  startLoopback?: typeof startAuthorizationCodeLoopback;
  cancelLoopback?: typeof cancelOAuthLoopback;
}

interface AccountListener {
  cb: (state: PluginAccountState) => unknown;
  failures: ListenerFailureState;
}

/**
 * What the stored tokens were issued for. A manifest update that changes where
 * tokens go or what they were granted must not inherit them, so a mismatch
 * reads as disconnected.
 */
export function accountFingerprint(account: PluginAccountContribution): string {
  const parts =
    account.kind === "oauth2"
      ? [account.kind, account.authorizeUrl, account.tokenUrl, account.clientId, ...account.scopes]
      : [account.kind];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function knownOAuthError(value: unknown): string | null {
  return typeof value === "string" && OAUTH_ERROR_CODES.has(value) ? value : null;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AccountRequestError("The service sent a response too large to be a token response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readDottedField(value: unknown, field: string): unknown {
  let current = value;
  for (const part of field.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    (v.refreshToken === null || typeof v.refreshToken === "string") &&
    (v.expiresAt === null || typeof v.expiresAt === "number")
  );
}

function connectFailureMessage(result: AuthorizationCodeLoopbackResult): string | null {
  if (result.success) return null;
  switch (result.cause) {
    case "cancelled":
      return null;
    case "denied": {
      if (result.error === "access_denied") return "Sign-in was declined in the browser";
      const code = knownOAuthError(result.error);
      return `The service refused the sign-in${code ? ` (${code})` : ""}`;
    }
    case "timed-out":
      return "Sign-in timed out before the browser came back to Daintree";
    case "open-external-failed":
      return "Couldn't open the browser to sign in";
    default:
      return "Couldn't start the sign-in";
  }
}

/**
 * Host-managed accounts for plugins (#13823). The host runs the sign-in, keeps
 * the tokens in the OS keychain, refreshes them, and hands a plugin only its
 * current access token. Accounts are keyed by plugin instance id, so a project
 * plugin's account belongs to its project and an installed plugin has one
 * account on this machine.
 *
 * Every write or delete of an account runs under that account's lock and
 * bumps its generation. An operation remembers the generation it started
 * under and does nothing once a newer one exists, so a sign-in, a refresh or a
 * failure that finishes late can never undo a disconnect, a newer sign-in or
 * an uninstall.
 *
 * Tokens are never logged and never returned to a renderer. Requests go only to
 * the manifest's endpoints, refuse redirects, and send no client secret.
 */
export class PluginAccountService {
  private readonly deps: PluginAccountServiceDeps;
  private readonly cipher: SecretCipher;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly stores = new Map<string, PluginSettingsStore>();
  private readonly listeners = new Map<string, Set<AccountListener>>();
  /** One token read (and refresh) per account at a time; concurrent callers share it. */
  private readonly tokenReads = new Map<string, Promise<PluginAccountAccessToken | null>>();
  /** Sign-ins in progress, from the click until the tokens are stored. */
  private readonly pending = new Map<string, symbol>();
  private readonly generations = new Map<string, number>();
  /** Bumped when the plugin unloads: retires every read that began before it. */
  private readonly epochs = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(deps: PluginAccountServiceDeps) {
    this.deps = deps;
    this.cipher = deps.cipher ?? safeStorageCipher;
    this.fetchImpl = deps.fetch ?? ((url, init) => net.fetch(url, init));
    this.now = deps.now ?? Date.now;
  }

  /** The declared account, or `undefined` when the plugin declares none. */
  declaredAccount(pluginId: string): PluginAccountContribution | undefined {
    return this.deps.getManifest(pluginId)?.contributes.account;
  }

  private requireAccount(pluginId: string): PluginAccountContribution {
    const account = this.declaredAccount(pluginId);
    if (!account) {
      throw new Error(`Plugin "${pluginId}" declares no contributes.account`);
    }
    return account;
  }

  /**
   * `<settingsRoot>/accounts/<pluginId>.json`. A project plugin's instance id
   * names its project, so its file is already per project; nothing here is
   * under a project root, so nothing can be committed.
   */
  accountFilePath(pluginId: string): string {
    if (!isSafePluginInstanceId(pluginId)) {
      throw new Error("plugin account: pluginId must be a plugin instance id");
    }
    return path.join(this.deps.getSettingsRoot(), "accounts", `${pluginId}.json`);
  }

  private store(pluginId: string): PluginSettingsStore {
    const filePath = this.accountFilePath(pluginId);
    let store = this.stores.get(filePath);
    if (!store) {
      store = new PluginSettingsStore(filePath, this.cipher);
      this.stores.set(filePath, store);
    }
    return store;
  }

  private generation(pluginId: string): number {
    return this.generations.get(pluginId) ?? 0;
  }

  private epoch(pluginId: string): number {
    return this.epochs.get(pluginId) ?? 0;
  }

  private bumpGeneration(pluginId: string): void {
    this.generations.set(pluginId, this.generation(pluginId) + 1);
  }

  /** Run `fn` after every earlier mutation of this account has finished. */
  private withLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(pluginId) ?? Promise.resolve()).then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(pluginId, tail);
    void tail.then(() => {
      if (this.locks.get(pluginId) === tail) this.locks.delete(pluginId);
    });
    return result;
  }

  private async readIdentity(pluginId: string): Promise<string | null> {
    const identity = await this.store(pluginId).get<unknown>(IDENTITY_KEY);
    return typeof identity === "string" ? identity : null;
  }

  async getState(pluginId: string): Promise<PluginAccountState> {
    const account = this.requireAccount(pluginId);
    const connected = await this.hasCurrentCredentials(pluginId, account);
    return { connected, identity: connected ? await this.readIdentity(pluginId) : null };
  }

  /** Stored credentials issued under the manifest's current account, checked without decrypting. */
  private async hasCurrentCredentials(
    pluginId: string,
    account: PluginAccountContribution
  ): Promise<boolean> {
    const store = this.store(pluginId);
    if ((await store.storedSecretTier(CREDENTIALS_KEY)) !== "keychain") return false;
    return (await store.get<unknown>(CONFIG_KEY)) === accountFingerprint(account);
  }

  async getUiStatus(pluginId: string): Promise<PluginAccountUiStatus | null> {
    const account = this.declaredAccount(pluginId);
    if (!account) return null;
    const state = await this.getState(pluginId);
    return {
      kind: account.kind,
      label: account.label,
      description: account.description ?? null,
      connected: state.connected,
      identity: state.identity,
      pending: this.pending.has(pluginId),
      secretTier: this.cipher.tier(),
    };
  }

  /**
   * Run the declared OAuth sign-in. Called only from the settings row's click.
   * A second click supersedes a sign-in still in progress, and Cancel or
   * Disconnect ends one at any point until its tokens are stored.
   */
  async connect(pluginId: string): Promise<PluginAccountConnectResult> {
    const account = this.requireAccount(pluginId);
    if (account.kind !== "oauth2") {
      throw new Error(`Plugin "${pluginId}" account takes a pasted token, not a sign-in`);
    }
    if (this.cipher.tier() !== "keychain") {
      return {
        status: "failed",
        message: "There's no unlocked OS keychain to keep the account's tokens in",
      };
    }
    const flow = Symbol(pluginId);
    this.pending.set(pluginId, flow);
    this.deps.onAccountChanged?.(pluginId);
    const current = () => this.pending.get(pluginId) === flow;
    try {
      return await this.runSignIn(pluginId, account, current);
    } finally {
      if (current()) {
        this.pending.delete(pluginId);
        this.deps.onAccountChanged?.(pluginId);
      }
    }
  }

  private async runSignIn(
    pluginId: string,
    account: OAuthAccount,
    current: () => boolean
  ): Promise<PluginAccountConnectResult> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    const startLoopback = this.deps.startLoopback ?? startAuthorizationCodeLoopback;
    const result = await startLoopback(SESSION_PREFIX + pluginId, state, (redirectUri) => {
      const url = new URL(account.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", account.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      if (account.scopes.length > 0) url.searchParams.set("scope", account.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    });
    if (!current()) return { status: "cancelled" };
    if (!result.success) {
      const message = connectFailureMessage(result);
      return message === null ? { status: "cancelled" } : { status: "failed", message };
    }
    // The manifest may have changed while the browser was open; only the
    // account declared now receives the code.
    const declared = this.declaredAccount(pluginId);
    if (!declared || accountFingerprint(declared) !== accountFingerprint(account)) {
      return { status: "failed", message: "The plugin's account changed during sign-in" };
    }
    let saved: boolean;
    try {
      const credentials = await this.requestTokens(account.tokenUrl, {
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: result.redirectUri,
        client_id: account.clientId,
        code_verifier: verifier,
      });
      if (!current()) return { status: "cancelled" };
      saved = await this.saveConnected(pluginId, account, credentials, current, {
        cancellable: true,
      });
    } catch (err) {
      if (!current()) return { status: "cancelled" };
      return { status: "failed", message: this.describeFailure(err, "Couldn't finish signing in") };
    }
    if (!saved) return { status: "cancelled" };
    const status = await this.getUiStatus(pluginId);
    return status ? { status: "connected", account: status } : { status: "cancelled" };
  }

  /** Stop a sign-in that hasn't stored its tokens yet. */
  cancelConnect(pluginId: string): void {
    if (!this.pending.delete(pluginId)) return;
    (this.deps.cancelLoopback ?? cancelOAuthLoopback)(SESSION_PREFIX + pluginId);
    this.deps.onAccountChanged?.(pluginId);
  }

  /**
   * Store a token the user pasted. When the manifest declares `identity`, the
   * token is checked against it first: a 401/403 means the service doesn't
   * accept it, and nothing is stored.
   */
  async setToken(pluginId: string, token: unknown): Promise<PluginAccountUiStatus> {
    const account = this.requireAccount(pluginId);
    if (account.kind !== "token") {
      throw new Error(`Plugin "${pluginId}" account signs in through the browser`);
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("Paste a token to connect");
    }
    const trimmed = token.trim();
    // Visible ASCII only: a header value can carry nothing else safely.
    if (trimmed.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7E]+$/.test(trimmed)) {
      throw new Error("That doesn't look like an API token");
    }
    this.cancelConnect(pluginId);
    const generation = this.generation(pluginId);
    const saved = await this.saveConnected(
      pluginId,
      account,
      { accessToken: trimmed, refreshToken: null, expiresAt: null },
      () => this.generation(pluginId) === generation,
      { rejectUnauthorized: true }
    );
    if (!saved) throw new Error("The account changed while the token was being checked");
    const status = await this.getUiStatus(pluginId);
    if (!status) throw new Error(`Plugin "${pluginId}" declares no contributes.account`);
    return status;
  }

  /** Forget the account's tokens and end any sign-in in progress. Called from the settings row. */
  async disconnect(pluginId: string): Promise<void> {
    this.requireAccount(pluginId);
    this.cancelConnect(pluginId);
    await this.clear(pluginId);
  }

  /**
   * A current access token for the plugin, refreshing first when it is within
   * {@link ACCOUNT_REFRESH_SKEW_MS} of expiry. `null` when not connected.
   * Concurrent callers share one read, so a rotating refresh token is only
   * ever spent once.
   */
  getAccessToken(pluginId: string): Promise<PluginAccountAccessToken | null> {
    let account: PluginAccountContribution;
    try {
      account = this.requireAccount(pluginId);
    } catch (err) {
      return Promise.reject(err);
    }
    const inFlight = this.tokenReads.get(pluginId);
    if (inFlight) return inFlight;
    const read = this.readToken(pluginId, account).finally(() => {
      if (this.tokenReads.get(pluginId) === read) this.tokenReads.delete(pluginId);
    });
    this.tokenReads.set(pluginId, read);
    return read;
  }

  private async readToken(
    pluginId: string,
    account: PluginAccountContribution
  ): Promise<PluginAccountAccessToken | null> {
    const epoch = this.epoch(pluginId);
    for (let attempt = 0; attempt < MAX_TOKEN_READ_ATTEMPTS; attempt++) {
      // Unloaded since the read began: nothing may act on the account for it.
      if (this.epoch(pluginId) !== epoch) return null;
      const outcome = await this.readTokenOnce(pluginId, account, epoch);
      // A read that saw the account replaced or removed under it starts over.
      if (outcome !== "stale") return outcome;
    }
    return null;
  }

  private async readTokenOnce(
    pluginId: string,
    account: PluginAccountContribution,
    epoch: number
  ): Promise<PluginAccountAccessToken | null | "stale"> {
    // Read under the lock, so the credentials and the generation they belong
    // to are one snapshot: no sign-in or disconnect can land between them.
    const snapshot = await this.withLock(pluginId, async () => {
      const generation = this.generation(pluginId);
      const current = await this.hasCurrentCredentials(pluginId, account);
      return {
        generation,
        current,
        credentials: current ? await this.readCredentials(pluginId) : null,
      };
    });
    const { generation, credentials } = snapshot;
    if (!snapshot.current) {
      // Tokens issued for an earlier account declaration are not handed out.
      await this.clear(pluginId, generation);
      return null;
    }
    if (!credentials) return null;
    const now = this.now();
    if (credentials.expiresAt === null || credentials.expiresAt - ACCOUNT_REFRESH_SKEW_MS > now) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
    }
    if (account.kind === "oauth2" && credentials.refreshToken !== null) {
      return this.refresh(pluginId, account, credentials, generation, epoch);
    }
    // No way to renew it: hand it out until it actually expires, then the
    // account has to be connected again.
    if (credentials.expiresAt > now) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
    }
    await this.clear(pluginId, generation);
    return null;
  }

  /** Whether an operation that began under `generation` and `epoch` still speaks for the account. */
  private stillCurrent(pluginId: string, generation: number, epoch: number): boolean {
    return this.generation(pluginId) === generation && this.epoch(pluginId) === epoch;
  }

  private async refresh(
    pluginId: string,
    account: OAuthAccount,
    credentials: StoredCredentials,
    generation: number,
    epoch: number
  ): Promise<PluginAccountAccessToken | null | "stale"> {
    let next: StoredCredentials;
    try {
      next = await this.requestTokens(account.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken ?? "",
        client_id: account.clientId,
      });
    } catch (err) {
      if (!this.stillCurrent(pluginId, generation, epoch)) return "stale";
      if (err instanceof AccountRequestError && err.oauthError === "invalid_grant") {
        // RFC 6749 §5.2: the grant is revoked or expired. Retrying can't help.
        await this.clear(pluginId, generation);
        return null;
      }
      throw new Error(this.describeFailure(err, "Couldn't refresh the account's access token"), {
        cause: err,
      });
    }
    // A service that doesn't rotate refresh tokens leaves the old one valid.
    const merged: StoredCredentials = {
      ...next,
      refreshToken: next.refreshToken ?? credentials.refreshToken,
    };
    const stored = await this.withLock(pluginId, async () => {
      if (!this.stillCurrent(pluginId, generation, epoch)) return false;
      await this.store(pluginId).set(CREDENTIALS_KEY, merged, { secret: true });
      return true;
    });
    if (!stored) return "stale";
    return { accessToken: merged.accessToken, expiresAt: merged.expiresAt };
  }

  private async readCredentials(pluginId: string): Promise<StoredCredentials | null> {
    const raw = await this.store(pluginId).get<unknown>(CREDENTIALS_KEY, { secret: true });
    if (raw === undefined) return null;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = null;
      }
    }
    return isStoredCredentials(parsed) ? parsed : null;
  }

  /**
   * Store a new sign-in, unless `stillWanted` says it was cancelled or
   * superseded. A `cancellable` one is checked again once the keychain has
   * written, since that can wait on a prompt: a sign-in cancelled meanwhile is
   * taken back out.
   * Resolves whether it was stored.
   */
  private async saveConnected(
    pluginId: string,
    account: PluginAccountContribution,
    credentials: StoredCredentials,
    stillWanted: () => boolean,
    options: { rejectUnauthorized?: boolean; cancellable?: boolean } = {}
  ): Promise<boolean> {
    const identity = account.identity
      ? await this.fetchIdentity(account.identity, credentials.accessToken, options)
      : null;
    const outcome = await this.withLock(pluginId, async () => {
      if (!stillWanted()) return "skipped" as const;
      // Whatever was running against the previous tokens no longer applies.
      this.bumpGeneration(pluginId);
      const store = this.store(pluginId);
      await store.set(CREDENTIALS_KEY, credentials, { secret: true });
      await store.set(CONFIG_KEY, accountFingerprint(account));
      if (identity === null) await store.delete(IDENTITY_KEY);
      else await store.set(IDENTITY_KEY, identity);
      // Only a browser sign-in has a Cancel; a Disconnect waits for this lock.
      if (!options.cancellable || stillWanted()) return "stored" as const;
      await this.removeStored(pluginId);
      return "withdrawn" as const;
    });
    if (outcome === "stored") this.notify(pluginId, { connected: true, identity });
    // Whatever the account held before was overwritten, so it is disconnected now.
    else if (outcome === "withdrawn") this.notify(pluginId, { connected: false, identity: null });
    return outcome === "stored";
  }

  /** Delete the stored account under the lock already held. Resolves whether anything was there. */
  private async removeStored(pluginId: string): Promise<boolean> {
    const store = this.store(pluginId);
    const removedCredentials = await store.delete(CREDENTIALS_KEY);
    const removedIdentity = await store.delete(IDENTITY_KEY);
    const removedConfig = await store.delete(CONFIG_KEY);
    return removedCredentials || removedIdentity || removedConfig;
  }

  /**
   * Remove the account's stored tokens. With `expected`, this is automatic
   * cleanup: it runs only while the account is still the one that generation
   * saw, so a late failure can't remove a newer sign-in, and it retires other
   * operations only when there was something to remove. Without it (the
   * user's Disconnect) everything in flight is retired.
   */
  private async clear(pluginId: string, expected?: number): Promise<void> {
    const removed = await this.withLock(pluginId, async () => {
      if (expected !== undefined && this.generation(pluginId) !== expected) return false;
      const removedAny = await this.removeStored(pluginId);
      if (removedAny || expected === undefined) this.bumpGeneration(pluginId);
      return removedAny;
    });
    if (removed) this.notify(pluginId, { connected: false, identity: null });
  }

  /**
   * POST a token request as a public client (RFC 6749 §4.1.3, §6) to the
   * manifest's token URL. Redirects are refused: a code or refresh token must
   * reach exactly the endpoint the user was shown.
   */
  private async requestTokens(
    tokenUrl: string,
    params: Record<string, string>
  ): Promise<StoredCredentials> {
    let response: Response;
    try {
      response = await this.fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(params).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AccountRequestError("Couldn't reach the service");
    }
    const body = await readJsonBody(response);
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (!response.ok) {
      throw new AccountRequestError(
        "The service refused the request",
        knownOAuthError(record?.error),
        response.status
      );
    }
    const accessToken = record?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new AccountRequestError("The service didn't send an access token");
    }
    const tokenType = record?.token_type;
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new AccountRequestError("The service sent a token type Daintree can't use");
    }
    const refreshToken =
      typeof record?.refresh_token === "string" && record.refresh_token.length > 0
        ? record.refresh_token
        : null;
    return { accessToken, refreshToken, expiresAt: this.expiryFrom(record?.expires_in) };
  }

  /**
   * `expires_in` as an instant. Absent or unreadable means the service gave no
   * lifetime (`null`); zero or less means the token is already spent.
   */
  private expiryFrom(expiresIn: unknown): number | null {
    const seconds =
      typeof expiresIn === "number"
        ? expiresIn
        : typeof expiresIn === "string" && expiresIn.trim() !== ""
          ? Number(expiresIn)
          : NaN;
    if (!Number.isFinite(seconds)) return null;
    return this.now() + Math.max(0, seconds) * 1000;
  }

  /**
   * Ask the manifest's identity endpoint who the token belongs to. Best effort,
   * except that a pasted token the service answers 401/403 for is refused.
   */
  private async fetchIdentity(
    identity: NonNullable<PluginAccountContribution["identity"]>,
    accessToken: string,
    options: { rejectUnauthorized?: boolean }
  ): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(identity.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (options.rejectUnauthorized && (response.status === 401 || response.status === 403)) {
      throw new Error("The service didn't accept this token");
    }
    if (!response.ok) return null;
    let body: unknown;
    try {
      body = await readJsonBody(response);
    } catch {
      return null;
    }
    const value = readDottedField(body, identity.field);
    const name =
      typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
    if (name.length === 0 || name.includes(accessToken)) return null;
    return name.length > MAX_IDENTITY_LENGTH ? `${name.slice(0, MAX_IDENTITY_LENGTH - 1)}…` : name;
  }

  private describeFailure(err: unknown, fallback: string): string {
    if (err instanceof AccountRequestError) {
      if (err.oauthError) return `${err.message} (${err.oauthError})`;
      if (err.status !== null) return `${err.message} (HTTP ${err.status})`;
      return err.message;
    }
    // Keychain refusals and timeouts already say what happened in words.
    return err instanceof Error && err.message.length > 0 ? err.message : fallback;
  }

  /**
   * `host.account.onDidChange` for one plugin. A rejected async callback is
   * tracked like a thrown one.
   */
  subscribe(pluginId: string, cb: (state: PluginAccountState) => unknown): () => void {
    const listener: AccountListener = { cb, failures: createListenerFailureState() };
    let set = this.listeners.get(pluginId);
    if (!set) {
      set = new Set();
      this.listeners.set(pluginId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(pluginId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(pluginId);
    };
  }

  private notify(pluginId: string, state: PluginAccountState): void {
    for (const listener of [...(this.listeners.get(pluginId) ?? [])]) {
      invokeTrackedListener(
        listener.failures,
        pluginId,
        "account.onDidChange",
        () => listener.cb({ ...state }),
        () => this.listeners.get(pluginId)?.delete(listener)
      );
    }
    this.deps.onAccountChanged?.(pluginId);
  }

  /**
   * Unload: drop the plugin's listeners and cached store, end a sign-in in
   * progress, and retire anything still running against its tokens (a refresh
   * in flight must not write after an uninstall wipes the file). The tokens
   * themselves stay stored.
   */
  clearPluginState(pluginId: string): void {
    this.listeners.delete(pluginId);
    this.cancelConnect(pluginId);
    this.bumpGeneration(pluginId);
    this.epochs.set(pluginId, this.epoch(pluginId) + 1);
    this.tokenReads.delete(pluginId);
    try {
      this.stores.delete(this.accountFilePath(pluginId));
    } catch {
      // Not a valid instance id, so nothing was ever cached for it.
    }
  }
}
