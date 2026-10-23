import path from "path";
import { createHash, randomBytes } from "crypto";
import { net } from "electron";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import { safeStorageCipher, type SecretCipher } from "./secretCipher.js";
import {
  isSafePluginInstanceId,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "./projectPluginIdentity.js";
import type { PluginAccountBindingStore } from "./pluginAccountBindings.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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
import {
  DEFAULT_PLUGIN_CONNECTION_ID,
  type PluginAccountAccessToken,
  type PluginAccountBinding,
  type PluginAccountBindingChoice,
  type PluginAccountBindingUiStatus,
  type PluginAccountConnectResult,
  type PluginAccountContribution,
  type PluginAccountRef,
  type PluginAccountState,
  type PluginAccountUiStatus,
  type PluginAccountVerification,
  type PluginConnectionContribution,
  type PluginManifest,
} from "../../../shared/types/plugin.js";
import {
  declaredPluginConnections,
  isPluginConnectionId,
} from "../../../shared/utils/pluginConnections.js";

/** The keychain-encrypted credentials. Never leaves this module except as an access token. */
interface StoredCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

type OAuthAccount = Extract<PluginAccountContribution, { kind: "oauth2" }>;

interface ConnectionKeys {
  credentials: string;
  identity: string;
  config: string;
}

/**
 * Store keys for one connection. Identity and the configuration fingerprint are
 * plain so the settings row can show the account without a keychain prompt.
 * The `"default"` connection keeps the keys `contributes.account` always used,
 * so an account stored before named connections existed is read where it is,
 * with nothing to move; every other connection has its own prefixed keys in
 * the same file.
 */
function connectionKeys(connectionId: string): ConnectionKeys {
  if (connectionId === DEFAULT_PLUGIN_CONNECTION_ID) {
    return { credentials: "credentials", identity: "identity", config: "config" };
  }
  const prefix = `connection:${connectionId}:`;
  return {
    credentials: `${prefix}credentials`,
    identity: `${prefix}identity`,
    config: `${prefix}config`,
  };
}

const UNCHECKED: PluginAccountVerification = {
  status: "unchecked",
  checkedAt: null,
  message: null,
};

/** Refresh this long before the service says the token expires. */
export const ACCOUNT_REFRESH_SKEW_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const IDENTITY_REQUEST_TIMEOUT_MS = 15_000;
const TEST_REQUEST_TIMEOUT_MS = 15_000;
/** Bounds on what a service may send back; anything larger is not a token response. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_IDENTITY_LENGTH = 200;
const SESSION_PREFIX = "plugin-account\u0000";
/** A token read that keeps losing to concurrent sign-ins and sign-outs gives up after this many. */
const MAX_TOKEN_READ_ATTEMPTS = 3;
/** A token read whose project binding keeps moving under it gives up after this many. */
const MAX_BINDING_READ_ATTEMPTS = 3;

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
   * or ends a browser sign-in, and after a project's binding changes. Carries
   * no state: a listener re-reads it.
   */
  onAccountChanged?: (pluginId: string) => void;
  /** Projects' connection choices. Defaults to an in-memory store (tests). */
  bindings?: PluginAccountBindingStore;
  cipher?: SecretCipher;
  fetch?: FetchLike;
  now?: () => number;
  startLoopback?: typeof startAuthorizationCodeLoopback;
  cancelLoopback?: typeof cancelOAuthLoopback;
}

/** One stored connection: the instance whose account file holds it, and its id there. */
interface ConnectionTarget {
  ownerId: string;
  connectionId: string;
}

/**
 * What a consumer's `host.account` call reaches. `available` is false when a
 * project points at a machine connection the installed plugin no longer
 * declares the same way: nothing is handed out rather than something else.
 */
interface ResolvedConnection extends ConnectionTarget {
  available: boolean;
}

interface AccountListener {
  consumerId: string;
  ref: PluginAccountRef;
  cb: (state: PluginAccountState) => unknown;
  failures: ListenerFailureState;
  /** Bumped on every delivery, so a slower read for an earlier binding can't land after it. */
  seq: number;
}

interface VerificationEntry {
  generation: number;
  revision: number;
  verification: PluginAccountVerification;
}

/** The runtime state key. The default connection keeps the bare instance id it always had. */
function connectionStateKey({ ownerId, connectionId }: ConnectionTarget): string {
  return connectionId === DEFAULT_PLUGIN_CONNECTION_ID
    ? ownerId
    : `${ownerId}\u0000${connectionId}`;
}

function ownsStateKey(ownerId: string, key: string): boolean {
  return key === ownerId || key.startsWith(`${ownerId}\u0000`);
}

function sameTarget(a: ConnectionTarget | null, b: ConnectionTarget | null): boolean {
  return a?.ownerId === b?.ownerId && a?.connectionId === b?.connectionId;
}

function memoryBindings(): PluginAccountBindingStore {
  const byProject = new Map<string, Map<string, PluginAccountBinding>>();
  return {
    get: (projectId, pluginId) => byProject.get(projectId)?.get(pluginId) ?? null,
    set: (projectId, pluginId, binding) => {
      const current = byProject.get(projectId)?.get(pluginId) ?? null;
      if (binding === null) {
        return byProject.get(projectId)?.delete(pluginId) ?? false;
      }
      if (current?.connectionId === binding.connectionId && current.source === binding.source) {
        return false;
      }
      let project = byProject.get(projectId);
      if (!project) {
        project = new Map();
        byProject.set(projectId, project);
      }
      project.set(pluginId, { ...binding });
      return true;
    },
  };
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
 * Host-managed accounts for plugins (#13823), as named connections (#14102).
 * The host runs the sign-in, keeps the tokens in the OS keychain, refreshes
 * them, and hands a plugin only its current access token.
 *
 * A connection is stored in its owning instance's account file, so a project
 * plugin's connections belong to its project and an installed plugin's are
 * this machine's. A project picks which connection a plugin uses through a
 * binding: one of the instance's own, or — for a project plugin — the
 * installed plugin's connection of the same id, when it is declared the same
 * way. A binding is only a reference; tokens are never copied.
 *
 * Every write or delete of a connection runs under that connection's lock and
 * bumps its generation. An operation remembers the generation it started
 * under and does nothing once a newer one exists, so a sign-in, a refresh, a
 * test or a failure that finishes late can never undo a disconnect, a newer
 * sign-in or an uninstall.
 *
 * Tokens are never logged and never returned to a renderer. Requests go only to
 * the manifest's endpoints, refuse redirects, and send no client secret.
 */
export class PluginAccountService {
  private readonly deps: PluginAccountServiceDeps;
  private readonly cipher: SecretCipher;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly bindings: PluginAccountBindingStore;
  private readonly stores = new Map<string, PluginSettingsStore>();
  private readonly listeners = new Set<AccountListener>();
  /** One token read (and refresh) per connection at a time; concurrent callers share it. */
  private readonly tokenReads = new Map<string, Promise<PluginAccountAccessToken | null>>();
  /** Sign-ins in progress, from the click until the tokens are stored. */
  private readonly pending = new Map<string, symbol>();
  private readonly generations = new Map<string, number>();
  /** Bumped when the owning plugin unloads: retires every read that began before it. */
  private readonly epochs = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();
  /** What a test or refresh last saw, for the generation it saw it under. Never stored. */
  private readonly verifications = new Map<string, VerificationEntry>();
  /**
   * Bumped when a refresh replaces the tokens without a new sign-in, so a test
   * of the old token can't speak for the new one.
   */
  private readonly revisions = new Map<string, number>();

  constructor(deps: PluginAccountServiceDeps) {
    this.deps = deps;
    this.cipher = deps.cipher ?? safeStorageCipher;
    this.fetchImpl = deps.fetch ?? ((url, init) => net.fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.bindings = deps.bindings ?? memoryBindings();
  }

  /** The plugin's connections in manifest order; `contributes.account` is `"default"`. */
  declaredConnections(pluginId: string): PluginConnectionContribution[] {
    return declaredPluginConnections(this.deps.getManifest(pluginId));
  }

  /** A declared connection: the named one, or the first. `undefined` when there's none. */
  declaredConnection(
    pluginId: string,
    connectionId?: string
  ): PluginConnectionContribution | undefined {
    const declared = this.declaredConnections(pluginId);
    return connectionId === undefined
      ? declared[0]
      : declared.find((connection) => connection.id === connectionId);
  }

  /** The first declared account, or `undefined` when the plugin declares none. */
  declaredAccount(pluginId: string): PluginAccountContribution | undefined {
    return this.declaredConnection(pluginId);
  }

  private requireConnection(
    pluginId: string,
    connectionId?: string
  ): PluginConnectionContribution & ConnectionTarget {
    if (connectionId !== undefined && !isPluginConnectionId(connectionId)) {
      throw new Error("plugin account: malformed connection id");
    }
    const connection = this.declaredConnection(pluginId, connectionId);
    if (!connection) {
      throw new Error(
        connectionId === undefined
          ? `Plugin "${pluginId}" declares no contributes.account`
          : `Plugin "${pluginId}" declares no connection "${connectionId}"`
      );
    }
    return { ...connection, ownerId: pluginId, connectionId: connection.id };
  }

  /**
   * `<settingsRoot>/accounts/<pluginId>.json`, holding every connection the
   * instance owns. A project plugin's instance id names its project, so its
   * file is already per project; nothing here is under a project root, so
   * nothing can be committed.
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

  private generation(target: ConnectionTarget): number {
    return this.generations.get(connectionStateKey(target)) ?? 0;
  }

  private epoch(ownerId: string): number {
    return this.epochs.get(ownerId) ?? 0;
  }

  private bumpGeneration(target: ConnectionTarget): void {
    this.generations.set(connectionStateKey(target), this.generation(target) + 1);
  }

  /** Run `fn` after every earlier mutation of this connection has finished. */
  private withLock<T>(target: ConnectionTarget, fn: () => Promise<T>): Promise<T> {
    const key = connectionStateKey(target);
    const result = (this.locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return result;
  }

  private async readIdentity(target: ConnectionTarget): Promise<string | null> {
    const keys = connectionKeys(target.connectionId);
    const identity = await this.store(target.ownerId).get<unknown>(keys.identity);
    return typeof identity === "string" ? identity : null;
  }

  async getState(pluginId: string, connectionId?: string): Promise<PluginAccountState> {
    const connection = this.requireConnection(pluginId, connectionId);
    const connected = await this.hasCurrentCredentials(connection, connection);
    return { connected, identity: connected ? await this.readIdentity(connection) : null };
  }

  /** Stored credentials issued under the manifest's current declaration, checked without decrypting. */
  private async hasCurrentCredentials(
    target: ConnectionTarget,
    account: PluginAccountContribution
  ): Promise<boolean> {
    const store = this.store(target.ownerId);
    const keys = connectionKeys(target.connectionId);
    if ((await store.storedSecretTier(keys.credentials)) !== "keychain") return false;
    return (await store.get<unknown>(keys.config)) === accountFingerprint(account);
  }

  private revision(target: ConnectionTarget): number {
    return this.revisions.get(connectionStateKey(target)) ?? 0;
  }

  private verification(target: ConnectionTarget): PluginAccountVerification {
    const entry = this.verifications.get(connectionStateKey(target));
    return entry &&
      entry.generation === this.generation(target) &&
      entry.revision === this.revision(target)
      ? { ...entry.verification }
      : { ...UNCHECKED };
  }

  /**
   * Record what was seen, unless the tokens changed since `generation` and
   * `revision`. A changed answer tells the settings row to re-read.
   */
  private recordVerification(
    target: ConnectionTarget,
    generation: number,
    status: PluginAccountVerification["status"],
    message: string | null = null,
    revision: number = this.revision(target)
  ): void {
    if (this.generation(target) !== generation || this.revision(target) !== revision) return;
    const previous = this.verification(target);
    this.verifications.set(connectionStateKey(target), {
      generation,
      revision,
      verification: { status, checkedAt: this.now(), message },
    });
    if (previous.status !== status || previous.message !== message) {
      this.deps.onAccountChanged?.(target.ownerId);
    }
  }

  /** The settings row for one connection; the first declared without `connectionId`. */
  async getUiStatus(
    pluginId: string,
    connectionId?: string
  ): Promise<PluginAccountUiStatus | null> {
    if (this.declaredConnections(pluginId).length === 0) return null;
    const connection = this.requireConnection(pluginId, connectionId);
    const state = await this.getState(pluginId, connection.connectionId);
    return {
      connectionId: connection.connectionId,
      kind: connection.kind,
      label: connection.label,
      description: connection.description ?? null,
      connected: state.connected,
      identity: state.identity,
      pending: this.pending.has(connectionStateKey(connection)),
      secretTier: this.cipher.tier(),
      testable: connection.test !== undefined || connection.identity !== undefined,
      verification: this.verification(connection),
    };
  }

  /** Every connection the instance declares, in manifest order. */
  async listUiStatus(pluginId: string): Promise<PluginAccountUiStatus[]> {
    const statuses: PluginAccountUiStatus[] = [];
    for (const connection of this.declaredConnections(pluginId)) {
      const status = await this.getUiStatus(pluginId, connection.id);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  /**
   * Run the declared OAuth sign-in. Called only from the settings row's click.
   * A second click supersedes a sign-in still in progress, and Cancel or
   * Disconnect ends one at any point until its tokens are stored. Connecting
   * an already connected account replaces its tokens (Reconnect).
   */
  async connect(pluginId: string, connectionId?: string): Promise<PluginAccountConnectResult> {
    const connection = this.requireConnection(pluginId, connectionId);
    if (connection.kind !== "oauth2") {
      throw new Error(`Plugin "${pluginId}" account takes a pasted token, not a sign-in`);
    }
    if (this.cipher.tier() !== "keychain") {
      return {
        status: "failed",
        message: "There's no unlocked OS keychain to keep the account's tokens in",
      };
    }
    const key = connectionStateKey(connection);
    const flow = Symbol(key);
    this.pending.set(key, flow);
    this.deps.onAccountChanged?.(pluginId);
    const current = () => this.pending.get(key) === flow;
    try {
      return await this.runSignIn(connection, connection, current);
    } finally {
      if (current()) {
        this.pending.delete(key);
        this.deps.onAccountChanged?.(pluginId);
      }
    }
  }

  private async runSignIn(
    target: ConnectionTarget,
    account: OAuthAccount,
    current: () => boolean
  ): Promise<PluginAccountConnectResult> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    const startLoopback = this.deps.startLoopback ?? startAuthorizationCodeLoopback;
    const result = await startLoopback(
      SESSION_PREFIX + connectionStateKey(target),
      state,
      (redirectUri) => {
        const url = new URL(account.authorizeUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", account.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        if (account.scopes.length > 0) url.searchParams.set("scope", account.scopes.join(" "));
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
        return url.toString();
      }
    );
    if (!current()) return { status: "cancelled" };
    if (!result.success) {
      const message = connectFailureMessage(result);
      return message === null ? { status: "cancelled" } : { status: "failed", message };
    }
    // The manifest may have changed while the browser was open; only the
    // connection declared now receives the code.
    const declared = this.declaredConnection(target.ownerId, target.connectionId);
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
      saved = await this.saveConnected(target, account, credentials, current, {
        cancellable: true,
      });
    } catch (err) {
      if (!current()) return { status: "cancelled" };
      return { status: "failed", message: this.describeFailure(err, "Couldn't finish signing in") };
    }
    if (!saved) return { status: "cancelled" };
    const status = await this.getUiStatus(target.ownerId, target.connectionId);
    return status ? { status: "connected", account: status } : { status: "cancelled" };
  }

  /** Stop a sign-in that hasn't stored its tokens yet. */
  cancelConnect(pluginId: string, connectionId?: string): void {
    // Omitted means the first declared connection, as for `connect`.
    const key = connectionStateKey({
      ownerId: pluginId,
      connectionId:
        connectionId ?? this.declaredConnection(pluginId)?.id ?? DEFAULT_PLUGIN_CONNECTION_ID,
    });
    if (!this.pending.delete(key)) return;
    (this.deps.cancelLoopback ?? cancelOAuthLoopback)(SESSION_PREFIX + key);
    this.deps.onAccountChanged?.(pluginId);
  }

  /**
   * Store a token the user pasted. When the manifest declares `identity`, the
   * token is checked against it first: a 401/403 means the service doesn't
   * accept it, and nothing is stored.
   */
  async setToken(
    pluginId: string,
    token: unknown,
    connectionId?: string
  ): Promise<PluginAccountUiStatus> {
    const connection = this.requireConnection(pluginId, connectionId);
    if (connection.kind !== "token") {
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
    this.cancelConnect(pluginId, connection.connectionId);
    const generation = this.generation(connection);
    const saved = await this.saveConnected(
      connection,
      connection,
      { accessToken: trimmed, refreshToken: null, expiresAt: null },
      () => this.generation(connection) === generation,
      { rejectUnauthorized: true }
    );
    if (!saved) throw new Error("The account changed while the token was being checked");
    const status = await this.getUiStatus(pluginId, connection.connectionId);
    if (!status) throw new Error(`Plugin "${pluginId}" declares no contributes.account`);
    return status;
  }

  /**
   * Forget the connection's tokens and end any sign-in in progress. Called
   * from the settings row. Projects bound to it keep their binding and read
   * it as disconnected until it is connected again.
   */
  async disconnect(pluginId: string, connectionId?: string): Promise<void> {
    const connection = this.requireConnection(pluginId, connectionId);
    this.cancelConnect(pluginId, connection.connectionId);
    await this.clear(connection);
  }

  /**
   * A current access token for the connection, refreshing first when it is
   * within {@link ACCOUNT_REFRESH_SKEW_MS} of expiry. `null` when not
   * connected. Concurrent callers share one read, so a rotating refresh token
   * is only ever spent once — however many projects share the connection.
   */
  getAccessToken(
    pluginId: string,
    connectionId?: string
  ): Promise<PluginAccountAccessToken | null> {
    let connection: PluginConnectionContribution & ConnectionTarget;
    try {
      connection = this.requireConnection(pluginId, connectionId);
    } catch (err) {
      return Promise.reject(err);
    }
    const key = connectionStateKey(connection);
    const inFlight = this.tokenReads.get(key);
    if (inFlight) return inFlight;
    const read = this.readToken(connection, connection).finally(() => {
      if (this.tokenReads.get(key) === read) this.tokenReads.delete(key);
    });
    this.tokenReads.set(key, read);
    return read;
  }

  private async readToken(
    target: ConnectionTarget,
    account: PluginAccountContribution
  ): Promise<PluginAccountAccessToken | null> {
    const epoch = this.epoch(target.ownerId);
    for (let attempt = 0; attempt < MAX_TOKEN_READ_ATTEMPTS; attempt++) {
      // Unloaded since the read began: nothing may act on the account for it.
      if (this.epoch(target.ownerId) !== epoch) return null;
      const outcome = await this.readTokenOnce(target, account, epoch);
      // A read that saw the account replaced or removed under it starts over.
      if (outcome !== "stale") return outcome;
    }
    return null;
  }

  private async readTokenOnce(
    target: ConnectionTarget,
    account: PluginAccountContribution,
    epoch: number
  ): Promise<PluginAccountAccessToken | null | "stale"> {
    // Read under the lock, so the credentials and the generation they belong
    // to are one snapshot: no sign-in or disconnect can land between them.
    const snapshot = await this.withLock(target, async () => {
      const generation = this.generation(target);
      const current = await this.hasCurrentCredentials(target, account);
      return {
        generation,
        current,
        credentials: current ? await this.readCredentials(target) : null,
      };
    });
    const { generation, credentials } = snapshot;
    if (!snapshot.current) {
      // Tokens issued for an earlier account declaration are not handed out.
      await this.clear(target, generation);
      return null;
    }
    if (!credentials) return null;
    const now = this.now();
    if (credentials.expiresAt === null || credentials.expiresAt - ACCOUNT_REFRESH_SKEW_MS > now) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
    }
    if (account.kind === "oauth2" && credentials.refreshToken !== null) {
      return this.refresh(target, account, credentials, generation, epoch);
    }
    // No way to renew it: hand it out until it actually expires, then the
    // account has to be connected again.
    if (credentials.expiresAt > now) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
    }
    await this.clear(target, generation);
    return null;
  }

  /** Whether an operation that began under `generation` and `epoch` still speaks for the connection. */
  private stillCurrent(target: ConnectionTarget, generation: number, epoch: number): boolean {
    return this.generation(target) === generation && this.epoch(target.ownerId) === epoch;
  }

  private async refresh(
    target: ConnectionTarget,
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
      if (!this.stillCurrent(target, generation, epoch)) return "stale";
      if (err instanceof AccountRequestError && err.oauthError === "invalid_grant") {
        // RFC 6749 §5.2: the grant is revoked or expired. Retrying can't help.
        // Bindings stay; the row says why it needs connecting again.
        await this.clear(
          target,
          generation,
          "The service refused to renew the sign-in (invalid_grant)"
        );
        return null;
      }
      const message = this.describeFailure(err, "Couldn't refresh the account's access token");
      this.recordVerification(target, generation, "unreachable", message);
      throw new Error(message, { cause: err });
    }
    // A service that doesn't rotate refresh tokens leaves the old one valid.
    const merged: StoredCredentials = {
      ...next,
      refreshToken: next.refreshToken ?? credentials.refreshToken,
    };
    const keys = connectionKeys(target.connectionId);
    const stored = await this.withLock(target, async () => {
      if (!this.stillCurrent(target, generation, epoch)) return false;
      await this.store(target.ownerId).set(keys.credentials, merged, { secret: true });
      this.revisions.set(connectionStateKey(target), this.revision(target) + 1);
      return true;
    });
    if (!stored) return "stale";
    this.recordVerification(target, generation, "ok");
    return { accessToken: merged.accessToken, expiresAt: merged.expiresAt };
  }

  private async readCredentials(target: ConnectionTarget): Promise<StoredCredentials | null> {
    const keys = connectionKeys(target.connectionId);
    const raw = await this.store(target.ownerId).get<unknown>(keys.credentials, { secret: true });
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
    target: ConnectionTarget,
    account: PluginAccountContribution,
    credentials: StoredCredentials,
    stillWanted: () => boolean,
    options: { rejectUnauthorized?: boolean; cancellable?: boolean } = {}
  ): Promise<boolean> {
    const identity = account.identity
      ? await this.fetchIdentity(account.identity, credentials.accessToken, options)
      : null;
    const keys = connectionKeys(target.connectionId);
    const outcome = await this.withLock(target, async () => {
      if (!stillWanted()) return "skipped" as const;
      // Whatever was running against the previous tokens no longer applies.
      this.bumpGeneration(target);
      const store = this.store(target.ownerId);
      await store.set(keys.credentials, credentials, { secret: true });
      await store.set(keys.config, accountFingerprint(account));
      if (identity === null) await store.delete(keys.identity);
      else await store.set(keys.identity, identity);
      // Only a browser sign-in has a Cancel; a Disconnect waits for this lock.
      if (!options.cancellable || stillWanted()) return "stored" as const;
      await this.removeStored(target);
      return "withdrawn" as const;
    });
    if (outcome === "stored") this.notify(target, { connected: true, identity });
    // Whatever the account held before was overwritten, so it is disconnected now.
    else if (outcome === "withdrawn") this.notify(target, { connected: false, identity: null });
    return outcome === "stored";
  }

  /** Delete the stored connection under the lock already held. Resolves whether anything was there. */
  private async removeStored(target: ConnectionTarget): Promise<boolean> {
    const store = this.store(target.ownerId);
    const keys = connectionKeys(target.connectionId);
    const removedCredentials = await store.delete(keys.credentials);
    const removedIdentity = await store.delete(keys.identity);
    const removedConfig = await store.delete(keys.config);
    return removedCredentials || removedIdentity || removedConfig;
  }

  /**
   * Remove the connection's stored tokens. With `expected`, this is automatic
   * cleanup: it runs only while the connection is still the one that
   * generation saw, so a late failure can't remove a newer sign-in, and it
   * retires other operations only when there was something to remove. Without
   * it (the user's Disconnect) everything in flight is retired. With
   * `revoked`, the service refused the tokens for good: the row says so until
   * the connection next changes.
   */
  private async clear(
    target: ConnectionTarget,
    expected?: number,
    revoked?: string
  ): Promise<void> {
    const removed = await this.withLock(target, async () => {
      if (expected !== undefined && this.generation(target) !== expected) return false;
      const removedAny = await this.removeStored(target);
      if (removedAny || expected === undefined) this.bumpGeneration(target);
      if (removedAny && revoked !== undefined) {
        this.recordVerification(target, this.generation(target), "revoked", revoked);
      }
      return removedAny;
    });
    if (removed) this.notify(target, { connected: false, identity: null });
  }

  /**
   * The settings row's Test: use the stored tokens against the manifest's
   * `test` endpoint (else its `identity` endpoint) and remember what the
   * service said until the connection next changes. Never disconnects: a
   * refusal is shown, and the user decides whether to reconnect.
   */
  async testConnection(
    pluginId: string,
    connectionId?: string
  ): Promise<PluginAccountVerification> {
    const connection = this.requireConnection(pluginId, connectionId);
    const url = connection.test?.url ?? connection.identity?.url;
    if (!url) throw new Error(`Plugin "${pluginId}" declares no way to test this connection`);
    const generation = this.generation(connection);
    let token: PluginAccountAccessToken | null;
    try {
      token = await this.getAccessToken(pluginId, connection.connectionId);
    } catch (err) {
      const message = formatErrorMessage(err, "Couldn't reach the service");
      this.recordVerification(connection, generation, "unreachable", message);
      return this.verification(connection);
    }
    // After the read: a refresh it ran is the token tested, a later one isn't.
    const revision = this.revision(connection);
    if (!token) {
      const seen = this.verification(connection);
      return seen.status === "revoked"
        ? seen
        : { status: "unchecked", checkedAt: null, message: "Not connected" };
    }
    let status: PluginAccountVerification["status"];
    let message: string | null = null;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TEST_REQUEST_TIMEOUT_MS),
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        status = "ok";
      } else if (response.status === 401 || response.status === 403) {
        status = "rejected";
        message = `The service refused the stored token (HTTP ${response.status})`;
      } else {
        status = "unreachable";
        message = `The service answered HTTP ${response.status}`;
      }
    } catch {
      status = "unreachable";
      message = "Couldn't reach the service";
    }
    // A sign-in or disconnect meanwhile: this result is about tokens that are
    // gone, so it isn't recorded against the ones there now.
    this.recordVerification(connection, generation, status, message, revision);
    this.deps.onAccountChanged?.(pluginId);
    return this.verification(connection);
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

  // ── Projects and bindings ─────────────────────────────────────────────

  /**
   * The project `ref` speaks for. A project plugin only ever speaks for its own
   * project; an installed plugin names the project it is acting in, or none.
   */
  private projectFor(consumerId: string, ref: PluginAccountRef | undefined): string | null {
    const bound = projectIdFromPluginInstanceKey(consumerId);
    const asked = ref?.projectId;
    if (asked !== undefined && (typeof asked !== "string" || asked.length === 0)) {
      throw new Error("plugin account: projectId must be a project id");
    }
    if (bound !== null && asked !== undefined && asked !== bound) {
      throw new Error(`Plugin "${consumerId}" can't use another project's connection`);
    }
    return bound ?? asked ?? null;
  }

  /**
   * The installed plugin's connection a project plugin may share, when the
   * installed plugin declares the same connection the same way. Signing in was
   * done for that declaration, so only an identical one may use its tokens.
   */
  private machineTarget(consumerId: string, connectionId: string): ConnectionTarget | null {
    const ownerId = pluginManifestIdFromInstanceKey(consumerId);
    if (ownerId === consumerId) return null;
    const own = this.declaredConnection(consumerId, connectionId);
    const machine = this.declaredConnection(ownerId, connectionId);
    if (!own || !machine || accountFingerprint(own) !== accountFingerprint(machine)) return null;
    return { ownerId, connectionId };
  }

  /**
   * Which stored connection a consumer's call reaches: `ref.connection`, else
   * the project's bound connection, else the first declared. Its owner is the
   * consumer itself unless the project bound that connection to the machine.
   * `null` when the plugin declares no connections.
   */
  resolve(consumerId: string, ref?: PluginAccountRef): ResolvedConnection | null {
    const declared = this.declaredConnections(consumerId);
    if (declared.length === 0) return null;
    const asked = ref?.connection;
    if (asked !== undefined && !isPluginConnectionId(asked)) {
      throw new Error("plugin account: malformed connection id");
    }
    if (asked !== undefined && !declared.some((connection) => connection.id === asked)) {
      throw new Error(`Plugin "${consumerId}" declares no connection "${asked}"`);
    }
    const projectId = this.projectFor(consumerId, ref);
    const stored = projectId === null ? null : this.bindings.get(projectId, consumerId);
    const binding =
      stored && declared.some((connection) => connection.id === stored.connectionId)
        ? stored
        : null;
    // The project chose a connection the plugin no longer declares. With
    // others still declared, quietly using one of them would hand out an
    // account the user never picked, so nothing is handed out until they
    // choose again. With one left there is nothing to choose.
    if (asked === undefined && stored && !binding && declared.length > 1) {
      return { ownerId: consumerId, connectionId: stored.connectionId, available: false };
    }
    const connectionId = asked ?? binding?.connectionId ?? declared[0].id;
    if (binding?.connectionId !== connectionId || binding.source !== "machine") {
      return { ownerId: consumerId, connectionId, available: true };
    }
    const machine = this.machineTarget(consumerId, connectionId);
    return machine
      ? { ...machine, available: true }
      : {
          ownerId: pluginManifestIdFromInstanceKey(consumerId),
          connectionId,
          available: false,
        };
  }

  /** `host.account.getState` for a consumer. */
  async getStateFor(consumerId: string, ref?: PluginAccountRef): Promise<PluginAccountState> {
    const target = this.resolve(consumerId, ref);
    if (!target) throw new Error(`Plugin "${consumerId}" declares no contributes.account`);
    if (!target.available) return { connected: false, identity: null };
    return this.getState(target.ownerId, target.connectionId);
  }

  /**
   * `host.account.getAccessToken` for a consumer. A token read while the
   * project's binding moved belongs to the connection it no longer uses, so it
   * is dropped and the read starts over against the new one.
   */
  async getAccessTokenFor(
    consumerId: string,
    ref?: PluginAccountRef
  ): Promise<PluginAccountAccessToken | null> {
    for (let attempt = 0; attempt < MAX_BINDING_READ_ATTEMPTS; attempt++) {
      const target = this.resolve(consumerId, ref);
      if (!target) throw new Error(`Plugin "${consumerId}" declares no contributes.account`);
      if (!target.available) return null;
      let token: PluginAccountAccessToken | null = null;
      let failure: { error: unknown } | null = null;
      try {
        token = await this.getAccessToken(target.ownerId, target.connectionId);
      } catch (error) {
        failure = { error };
      }
      // A failure, like a token, belongs to the connection it was read from.
      const now = this.resolve(consumerId, ref);
      if (!now?.available || !sameTarget(now, target)) continue;
      if (failure) throw failure.error;
      return token;
    }
    return null;
  }

  /** What a project uses for a plugin, and what it could choose. */
  async getBindingUiStatus(
    consumerId: string,
    projectId: string
  ): Promise<PluginAccountBindingUiStatus> {
    const ref = { projectId };
    this.projectFor(consumerId, ref);
    const stored = this.bindings.get(projectId, consumerId);
    const resolved = this.resolve(consumerId, ref);
    if (!resolved) throw new Error(`Plugin "${consumerId}" declares no contributes.account`);
    const choices: PluginAccountBindingChoice[] = [];
    for (const connection of this.declaredConnections(consumerId)) {
      const own = await this.getState(consumerId, connection.id);
      choices.push({ connectionId: connection.id, source: "own", label: connection.label, ...own });
      const machine = this.machineTarget(consumerId, connection.id);
      if (machine) {
        const shared = await this.getState(machine.ownerId, machine.connectionId);
        choices.push({
          connectionId: connection.id,
          source: "machine",
          label: connection.label,
          ...shared,
        });
      }
    }
    return {
      binding: stored,
      selected:
        !resolved.available && stored
          ? stored
          : {
              connectionId: resolved.connectionId,
              source: resolved.ownerId === consumerId ? "own" : "machine",
            },
      choices,
    };
  }

  /**
   * Choose the connection `projectId` uses for a plugin, or `null` for the
   * default. Called only from the settings row. Only a project plugin can
   * point at the machine, and only at a connection declared the same way.
   */
  async setBinding(
    consumerId: string,
    projectId: string,
    binding: PluginAccountBinding | null
  ): Promise<PluginAccountBindingUiStatus> {
    const ref = { projectId };
    this.projectFor(consumerId, ref);
    if (binding !== null) {
      if (!isPluginConnectionId(binding.connectionId)) {
        throw new Error("plugin account: malformed connection id");
      }
      if (!this.declaredConnection(consumerId, binding.connectionId)) {
        throw new Error(`Plugin "${consumerId}" declares no connection "${binding.connectionId}"`);
      }
      if (binding.source === "machine" && !this.machineTarget(consumerId, binding.connectionId)) {
        throw new Error("There's no matching connection on this machine to use");
      }
      if (binding.source !== "own" && binding.source !== "machine") {
        throw new Error("plugin account: malformed binding");
      }
    }
    const before = new Map(
      [...this.listeners].map((listener) => [listener, this.safeResolve(listener)] as const)
    );
    if (this.bindings.set(projectId, consumerId, binding)) {
      for (const [listener, previous] of before) {
        const next = this.safeResolve(listener);
        if (listener.consumerId !== consumerId || sameTarget(previous, next)) continue;
        const seq = ++listener.seq;
        void this.stateOf(next).then((state) => {
          // A newer delivery, or another binding change, has spoken since.
          const now = this.safeResolve(listener);
          if (
            listener.seq !== seq ||
            !sameTarget(now, next) ||
            now?.available !== next?.available
          ) {
            return;
          }
          this.invokeListener(listener, state);
        });
      }
      this.deps.onAccountChanged?.(consumerId);
    }
    return this.getBindingUiStatus(consumerId, projectId);
  }

  // ── Listeners ─────────────────────────────────────────────────────────

  private safeResolve(listener: AccountListener): ResolvedConnection | null {
    try {
      return this.resolve(listener.consumerId, listener.ref);
    } catch {
      return null;
    }
  }

  private async stateOf(target: ResolvedConnection | null): Promise<PluginAccountState> {
    if (!target?.available) return { connected: false, identity: null };
    try {
      return await this.getState(target.ownerId, target.connectionId);
    } catch {
      return { connected: false, identity: null };
    }
  }

  /**
   * `host.account.onDidChange` for one consumer. Hears changes to whichever
   * connection `ref` resolves to at the time, so a binding change moves it.
   * A rejected async callback is tracked like a thrown one.
   */
  subscribe(
    consumerId: string,
    cb: (state: PluginAccountState) => unknown,
    ref: PluginAccountRef = {}
  ): () => void {
    this.projectFor(consumerId, ref);
    const listener: AccountListener = {
      consumerId,
      ref: { ...ref },
      cb,
      failures: createListenerFailureState(),
      seq: 0,
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private invokeListener(listener: AccountListener, state: PluginAccountState): void {
    if (!this.listeners.has(listener)) return;
    invokeTrackedListener(
      listener.failures,
      listener.consumerId,
      "account.onDidChange",
      () => listener.cb({ ...state }),
      () => this.listeners.delete(listener)
    );
  }

  private notify(target: ConnectionTarget, state: PluginAccountState): void {
    const consumers = new Set<string>();
    for (const listener of [...this.listeners]) {
      const resolved = this.safeResolve(listener);
      if (!resolved?.available || !sameTarget(resolved, target)) continue;
      consumers.add(listener.consumerId);
      listener.seq++;
      this.invokeListener(listener, state);
    }
    this.deps.onAccountChanged?.(target.ownerId);
    // A project plugin sharing the machine's connection hears about it too.
    for (const consumerId of consumers) {
      if (consumerId !== target.ownerId) this.deps.onAccountChanged?.(consumerId);
    }
  }

  /**
   * Unload: drop the plugin's listeners and cached store, end its sign-ins in
   * progress, and retire anything still running against its tokens (a refresh
   * in flight must not write after an uninstall wipes the file). The tokens
   * and every project's binding stay stored.
   */
  clearPluginState(pluginId: string): void {
    for (const listener of [...this.listeners]) {
      if (listener.consumerId === pluginId) this.listeners.delete(listener);
    }
    let cancelled = false;
    for (const key of [...this.pending.keys()]) {
      if (!ownsStateKey(pluginId, key)) continue;
      this.pending.delete(key);
      (this.deps.cancelLoopback ?? cancelOAuthLoopback)(SESSION_PREFIX + key);
      cancelled = true;
    }
    const connectionIds = new Set(this.declaredConnections(pluginId).map((c) => c.id));
    connectionIds.add(DEFAULT_PLUGIN_CONNECTION_ID);
    for (const key of this.generations.keys()) {
      if (!ownsStateKey(pluginId, key)) continue;
      connectionIds.add(
        key === pluginId ? DEFAULT_PLUGIN_CONNECTION_ID : key.slice(pluginId.length + 1)
      );
    }
    for (const connectionId of connectionIds) {
      this.bumpGeneration({ ownerId: pluginId, connectionId });
    }
    this.epochs.set(pluginId, this.epoch(pluginId) + 1);
    for (const key of [...this.tokenReads.keys()]) {
      if (ownsStateKey(pluginId, key)) this.tokenReads.delete(key);
    }
    if (cancelled) this.deps.onAccountChanged?.(pluginId);
    try {
      this.stores.delete(this.accountFilePath(pluginId));
    } catch {
      // Not a valid instance id, so nothing was ever cached for it.
    }
  }
}
