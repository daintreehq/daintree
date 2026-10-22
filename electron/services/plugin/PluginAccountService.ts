import path from "path";
import { createHash, randomBytes } from "crypto";
import { net } from "electron";
import { PluginSettingsStore, wipeSettingsFile } from "../PluginSettingsStore.js";
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
  /** Told after any account connects, disconnects or changes identity. */
  onAccountChanged?: (pluginId: string) => void;
  cipher?: SecretCipher;
  fetch?: FetchLike;
  now?: () => number;
  startLoopback?: typeof startAuthorizationCodeLoopback;
  cancelLoopback?: typeof cancelOAuthLoopback;
}

interface AccountListener {
  cb: (state: PluginAccountState) => void;
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

/** Only an OAuth error code's own alphabet gets through to a message (RFC 6749 §5.2). */
function sanitizeOAuthError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[\x20-\x21\x23-\x5B\x5D-\x7E]{1,64}$/.test(value) ? value : null;
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
    case "denied":
      return result.error === "access_denied"
        ? "Sign-in was declined in the browser"
        : `The service refused the sign-in${sanitizeOAuthError(result.error) ? ` (${sanitizeOAuthError(result.error)})` : ""}`;
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
  /** One refresh per account at a time; concurrent callers share it. */
  private readonly refreshes = new Map<string, Promise<PluginAccountAccessToken | null>>();
  /** Sign-ins waiting on the browser, by plugin id, with the flow's own token. */
  private readonly pending = new Map<string, symbol>();
  /** Bumped by every disconnect, so a refresh that was in flight can't write after it. */
  private readonly generations = new Map<string, number>();

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
   * A second click supersedes a flow still waiting on the browser.
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
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    const startLoopback = this.deps.startLoopback ?? startAuthorizationCodeLoopback;
    let result: AuthorizationCodeLoopbackResult;
    try {
      result = await startLoopback(SESSION_PREFIX + pluginId, state, (redirectUri) => {
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
    } finally {
      if (this.pending.get(pluginId) === flow) this.pending.delete(pluginId);
    }
    if (!result.success) {
      const message = connectFailureMessage(result);
      return message === null ? { status: "cancelled" } : { status: "failed", message };
    }
    // The manifest may have changed while the browser was open; only the
    // endpoint declared now receives the code.
    const current = this.declaredAccount(pluginId);
    if (!current || current.kind !== "oauth2" || current.tokenUrl !== account.tokenUrl) {
      return { status: "failed", message: "The plugin's account changed during sign-in" };
    }
    try {
      const credentials = await this.requestTokens(account.tokenUrl, {
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: result.redirectUri,
        client_id: account.clientId,
        code_verifier: verifier,
      });
      await this.saveConnected(pluginId, account, credentials);
    } catch (err) {
      return { status: "failed", message: this.describeFailure(err, "Couldn't finish signing in") };
    }
    const status = await this.getUiStatus(pluginId);
    return status ? { status: "connected", account: status } : { status: "cancelled" };
  }

  /** Stop a sign-in still waiting on the browser. */
  cancelConnect(pluginId: string): void {
    if (!this.pending.has(pluginId)) return;
    (this.deps.cancelLoopback ?? cancelOAuthLoopback)(SESSION_PREFIX + pluginId);
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
    await this.saveConnected(
      pluginId,
      account,
      { accessToken: trimmed, refreshToken: null, expiresAt: null },
      { rejectUnauthorized: true }
    );
    const status = await this.getUiStatus(pluginId);
    if (!status) throw new Error(`Plugin "${pluginId}" declares no contributes.account`);
    return status;
  }

  /** Forget the account's tokens. Called from the settings row. */
  async disconnect(pluginId: string): Promise<void> {
    this.requireAccount(pluginId);
    this.cancelConnect(pluginId);
    await this.clear(pluginId);
  }

  /**
   * A current access token for the plugin, refreshing first when it is within
   * {@link ACCOUNT_REFRESH_SKEW_MS} of expiry. `null` when not connected.
   */
  async getAccessToken(pluginId: string): Promise<PluginAccountAccessToken | null> {
    const account = this.requireAccount(pluginId);
    if (!(await this.hasCurrentCredentials(pluginId, account))) {
      // Tokens issued for an earlier account declaration are not handed out.
      await this.clear(pluginId);
      return null;
    }
    const credentials = await this.readCredentials(pluginId);
    if (!credentials) return null;
    if (
      credentials.expiresAt === null ||
      credentials.expiresAt - ACCOUNT_REFRESH_SKEW_MS > this.now()
    ) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
    }
    if (account.kind !== "oauth2" || credentials.refreshToken === null) {
      // Expired with no way to renew it: the account has to be connected again.
      await this.clear(pluginId);
      return null;
    }
    const inFlight = this.refreshes.get(pluginId);
    if (inFlight) return inFlight;
    const refresh = this.refresh(pluginId, account, credentials).finally(() => {
      if (this.refreshes.get(pluginId) === refresh) this.refreshes.delete(pluginId);
    });
    this.refreshes.set(pluginId, refresh);
    return refresh;
  }

  private async refresh(
    pluginId: string,
    account: Extract<PluginAccountContribution, { kind: "oauth2" }>,
    credentials: StoredCredentials
  ): Promise<PluginAccountAccessToken | null> {
    const generation = this.generations.get(pluginId) ?? 0;
    let next: StoredCredentials;
    try {
      next = await this.requestTokens(account.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken ?? "",
        client_id: account.clientId,
      });
    } catch (err) {
      if (err instanceof AccountRequestError && err.oauthError === "invalid_grant") {
        // RFC 6749 §5.2: the grant is revoked or expired. Retrying can't help.
        await this.clear(pluginId);
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
    // A disconnect while the request was out wins over the late answer.
    if ((this.generations.get(pluginId) ?? 0) !== generation) return null;
    await this.store(pluginId).set(CREDENTIALS_KEY, merged, { secret: true });
    if ((this.generations.get(pluginId) ?? 0) !== generation) {
      // The keychain write waited and a disconnect landed meanwhile: undo it.
      await this.store(pluginId).delete(CREDENTIALS_KEY);
      return null;
    }
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

  private async saveConnected(
    pluginId: string,
    account: PluginAccountContribution,
    credentials: StoredCredentials,
    options: { rejectUnauthorized?: boolean } = {}
  ): Promise<void> {
    const identity = account.identity
      ? await this.fetchIdentity(account.identity, credentials.accessToken, options)
      : null;
    const store = this.store(pluginId);
    // A new sign-in supersedes any refresh still running on the old tokens.
    this.generations.set(pluginId, (this.generations.get(pluginId) ?? 0) + 1);
    await store.set(CREDENTIALS_KEY, credentials, { secret: true });
    await store.set(CONFIG_KEY, accountFingerprint(account));
    if (identity === null) await store.delete(IDENTITY_KEY);
    else await store.set(IDENTITY_KEY, identity);
    this.notify(pluginId, { connected: true, identity });
  }

  private async clear(pluginId: string): Promise<void> {
    this.generations.set(pluginId, (this.generations.get(pluginId) ?? 0) + 1);
    const store = this.store(pluginId);
    const removedCredentials = await store.delete(CREDENTIALS_KEY);
    const removedIdentity = await store.delete(IDENTITY_KEY);
    await store.delete(CONFIG_KEY);
    if (removedCredentials || removedIdentity) {
      this.notify(pluginId, { connected: false, identity: null });
    }
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
        sanitizeOAuthError(record?.error),
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
    const expiresIn = record?.expires_in;
    const seconds =
      typeof expiresIn === "number"
        ? expiresIn
        : typeof expiresIn === "string"
          ? Number(expiresIn)
          : NaN;
    const expiresAt = Number.isFinite(seconds) && seconds > 0 ? this.now() + seconds * 1000 : null;
    return { accessToken, refreshToken, expiresAt };
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
    if (name.length === 0) return null;
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

  /** `host.account.onDidChange` for one plugin. */
  subscribe(pluginId: string, cb: (state: PluginAccountState) => void): () => void {
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

  /** Drop a plugin's listeners and cached store on unload; its tokens stay stored. */
  clearPluginState(pluginId: string): void {
    this.listeners.delete(pluginId);
    this.cancelConnect(pluginId);
    try {
      this.stores.delete(this.accountFilePath(pluginId));
    } catch {
      // Not a valid instance id, so nothing was ever cached for it.
    }
  }

  /** Delete a plugin's stored account for good, as an uninstall that wipes settings does. */
  async wipeAccount(pluginId: string): Promise<void> {
    const filePath = this.accountFilePath(pluginId);
    this.stores.delete(filePath);
    await wipeSettingsFile(filePath);
  }
}
