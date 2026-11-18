import { z } from "zod";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import type { CredentialImportUnavailable } from "../../../../shared/types/forge.js";
import { GitHubAuth } from "./GitHubAuth.js";
import { getEnterpriseHost, setEnterpriseHost } from "./GitHubHost.js";
import { releaseRateLimitServiceForHost } from "./GitHubRateLimitService.js";
import { clearGitHubCaches } from "./GitHubCaches.js";
import { commitGhCredential, previewGhCredential } from "./GitHubCliCredential.js";
import {
  ENTERPRISE_HOST_SETTING,
  ENTERPRISE_TOKEN_SETTING,
  normalizeEnterpriseHost,
} from "../shared/githubHost.js";
import {
  ENTERPRISE_CHANNELS,
  type EnterpriseImportCommitResult,
  type EnterpriseImportPreviewResult,
  type EnterpriseSetHostResult,
  type EnterpriseStatus,
  type EnterpriseTokenResult,
} from "../shared/enterprise.js";
import type { GitHubTokenValidation } from "./GitHubAuth.js";

/**
 * The saved Enterprise Server credential. The host it was validated against
 * is stored with the token, so changing the configured host never sends this
 * token anywhere: a record for another host stays inert until it is replaced
 * or cleared.
 */
interface EnterpriseTokenRecord {
  version: 1;
  host: string;
  token: string;
}

export function parseEnterpriseTokenRecord(raw: unknown): EnterpriseTokenRecord | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const { version, host, token } = value as Record<string, unknown>;
  if (version !== 1 || typeof token !== "string" || token.trim().length === 0) return null;
  const normalizedHost = normalizeEnterpriseHost(host);
  if (normalizedHost === null || normalizedHost !== host) return null;
  return { version: 1, host: normalizedHost, token: token.trim() };
}

export interface EnterpriseSettingsAccess {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
}

export interface GitHubEnterpriseDeps {
  settings: EnterpriseSettingsAccess;
  /** Tell workspace hosts a credential appeared or went away, so PR detection refreshes. */
  onCredentialsChanged: () => void;
}

function isUnavailable(value: object): value is CredentialImportUnavailable {
  return (value as Partial<CredentialImportUnavailable>).unavailable === true;
}

const HOST_CHANGED_MESSAGE =
  "The Enterprise Server host changed in another window. Check the host, then try again.";
const CREDENTIAL_CHANGED_MESSAGE =
  "The Enterprise Server host or token changed while this token was checked. Try again.";

const INVALID_HOST_MESSAGE =
  "Enter the server's hostname, like github.example.com (https, no path or port). github.com doesn't need one.";

function toTokenResult(validation: GitHubTokenValidation): EnterpriseTokenResult {
  return {
    valid: validation.valid,
    scopes: validation.scopes,
    ...(validation.username ? { account: validation.username } : {}),
    ...(validation.error ? { error: validation.error } : {}),
  };
}

/**
 * Keeps the Enterprise Server host and its token session in step with the
 * plugin's settings, and answers the settings tab's account channels.
 */
export class GitHubEnterpriseAccount {
  /** The host whose session this account last filled, so a host change can empty it. */
  private sessionHost: string | null = null;
  private applyGeneration = 0;
  /**
   * Bumped by every change to which credential is saved, or for which host.
   * A save or import checks it after its slow validation, so an earlier one
   * can't undo a later clear, replacement or host change.
   */
  private credentialRevision = 0;
  /**
   * True until the startup restore (host, then token) has applied: restoring
   * what was saved changes nothing, so it keeps every cache, including the
   * on-disk pages startup reads.
   */
  private restoring = true;
  private disposed = false;

  constructor(private readonly deps: GitHubEnterpriseDeps) {}

  private async readRawRecord(): Promise<unknown> {
    try {
      return await this.deps.settings.get(ENTERPRISE_TOKEN_SETTING);
    } catch {
      // An unreadable secret (a locked keychain) leaves the server
      // unauthenticated rather than guessing.
      return undefined;
    }
  }

  private async readRecord(): Promise<EnterpriseTokenRecord | null> {
    return parseEnterpriseTokenRecord(await this.readRawRecord());
  }

  /**
   * Mirror the saved host before the provider registers. Restoring it is not a
   * change: caches stay, including the on-disk pages startup reads.
   */
  async loadHost(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.deps.settings.get(ENTERPRISE_HOST_SETTING);
    } catch {
      raw = undefined;
    }
    if (this.disposed) return;
    setEnterpriseHost(raw);
  }

  /**
   * A real change to the saved host or token: it ends the startup restore
   * (so its apply invalidates caches) and outdates any save still validating.
   */
  private markChanged(): void {
    this.restoring = false;
    this.credentialRevision++;
  }

  /**
   * The token setting changed, from this account or the generated settings
   * form. Whatever was fetched under the previous credential goes, even when
   * no session held it yet (a change during the startup read).
   */
  onTokenSetting(): void {
    if (this.disposed) return;
    this.markChanged();
    clearGitHubCaches();
  }

  /** Mirror a new `enterpriseHost` value, retiring what belonged to the old host. */
  onHostSetting(raw: unknown): void {
    if (this.disposed) return;
    const previous = getEnterpriseHost();
    setEnterpriseHost(raw);
    if (getEnterpriseHost() === previous) return;
    this.markChanged();
    // Repo contexts, pages and counts were parsed and fetched against the old
    // routing; a remote that was unserved may now be served.
    clearGitHubCaches();
    this.retireSession();
    // A host checked with Test but never given a token still has a breaker.
    if (previous !== null) releaseRateLimitServiceForHost(previous);
  }

  private retireSession(): void {
    const host = this.sessionHost;
    if (host === null || host === getEnterpriseHost()) return;
    GitHubAuth.setMemoryToken(null, host);
    releaseRateLimitServiceForHost(host);
    this.sessionHost = null;
    this.deps.onCredentialsChanged();
  }

  /** Load the saved token into the configured host's session, if it was saved for that host. */
  async applySession(): Promise<void> {
    const generation = ++this.applyGeneration;
    const raw = await this.readRawRecord();
    if (this.disposed || generation !== this.applyGeneration) return;
    // Only the startup apply restores; it is the first to complete only when
    // nothing changed while it read.
    const restoring = this.restoring;
    this.restoring = false;
    this.retireSession();
    const host = getEnterpriseHost();
    if (host === null) return;
    // Only a record bound to this host counts. A bare token (typed into the
    // generated settings form) names no host, so it is never sent anywhere.
    const record = parseEnterpriseTokenRecord(raw);
    const token = record && record.host === host ? record.token : null;
    if ((GitHubAuth.getToken(host) ?? null) !== token) {
      GitHubAuth.setMemoryToken(token, host);
      if (!restoring) clearGitHubCaches();
      this.deps.onCredentialsChanged();
    }
    this.sessionHost = token ? host : null;
  }

  /** `withAccount` names the token's account, validating it once if nothing has yet. */
  async status(withAccount = false): Promise<EnterpriseStatus> {
    const host = getEnterpriseHost();
    const record = await this.readRecord();
    const hasToken = host !== null && record?.host === host;
    // A hydration that failed (the keychain was locked at startup) gets
    // another try whenever the account is looked at.
    if (host !== null && record?.host === host && GitHubAuth.getToken(host) !== record.token) {
      await this.applySession();
    }
    const staleTokenHost = record && record.host !== host ? record.host : null;
    const account =
      hasToken && withAccount
        ? (await GitHubAuth.getConfigAsync(host)).username
        : hasToken
          ? GitHubAuth.getConfig(host).username
          : undefined;
    return { host, hasToken, staleTokenHost, ...(account ? { account } : {}) };
  }

  async setHost(raw: string): Promise<EnterpriseSetHostResult> {
    const trimmed = raw.trim();
    const host = trimmed.length === 0 ? null : normalizeEnterpriseHost(trimmed);
    if (trimmed.length > 0 && host === null) return { ok: false, error: INVALID_HOST_MESSAGE };
    await this.deps.settings.set(ENTERPRISE_HOST_SETTING, host ?? "");
    // The setting's change subscription does the same; doing it here too means
    // the reply already describes the new host.
    this.onHostSetting(host ?? "");
    await this.applySession();
    return { ok: true, host };
  }

  /**
   * The host the form showed must still be the configured one before a token
   * goes anywhere: another window may have changed it since.
   */
  private hostMismatch(expectedHost: string | null): EnterpriseTokenResult | null {
    const host = getEnterpriseHost();
    if (host === null) return { valid: false, error: "Set the Enterprise Server host first." };
    if (host !== expectedHost) return { valid: false, error: HOST_CHANGED_MESSAGE };
    return null;
  }

  async testToken(token: string, expectedHost: string): Promise<EnterpriseTokenResult> {
    const mismatch = this.hostMismatch(expectedHost);
    if (mismatch) return mismatch;
    return toTokenResult(
      await GitHubAuth.validate(token.trim(), { host: expectedHost, detached: true })
    );
  }

  private async persist(
    host: string,
    token: string,
    validation: GitHubTokenValidation
  ): Promise<void> {
    const record: EnterpriseTokenRecord = { version: 1, host, token };
    this.markChanged();
    await this.deps.settings.set(ENTERPRISE_TOKEN_SETTING, JSON.stringify(record));
    await this.applySession();
    // Only the token this validation describes gets its identity; a later
    // save may already have replaced it.
    if (validation.username && GitHubAuth.getToken(host) === token) {
      GitHubAuth.setValidatedUserInfo(
        validation.username,
        validation.avatarUrl,
        validation.scopes,
        GitHubAuth.getTokenVersion(host),
        host
      );
    }
  }

  async saveToken(token: string, expectedHost: string): Promise<EnterpriseTokenResult> {
    const mismatch = this.hostMismatch(expectedHost);
    if (mismatch) return mismatch;
    const revision = this.credentialRevision;
    const trimmed = token.trim();
    const validation = await GitHubAuth.validate(trimmed, { host: expectedHost, detached: true });
    if (!validation.valid) return toTokenResult(validation);
    // A token is only ever stored against the host it was checked on, and
    // never over a credential change that landed while it was checked.
    if (getEnterpriseHost() !== expectedHost || this.credentialRevision !== revision) {
      return { valid: false, error: CREDENTIAL_CHANGED_MESSAGE };
    }
    await this.persist(expectedHost, trimmed, validation);
    return toTokenResult(validation);
  }

  async clearToken(expectedHost: string | null): Promise<{ cleared: boolean }> {
    if (getEnterpriseHost() !== expectedHost) return { cleared: false };
    this.markChanged();
    await this.deps.settings.unset(ENTERPRISE_TOKEN_SETTING);
    clearGitHubCaches();
    await this.applySession();
    return { cleared: true };
  }

  async previewImport(): Promise<EnterpriseImportPreviewResult> {
    const host = getEnterpriseHost();
    if (host === null) return { ok: false, reason: "no-host" };
    const preview = await previewGhCredential(undefined, host);
    if (preview.unavailable) return { ok: false, reason: preview.reason };
    return {
      ok: true,
      host,
      account: preview.account,
      scopes: preview.scopes,
      missingScopes: preview.missingScopes,
    };
  }

  async commitImport(expected: {
    account: string;
    host: string;
  }): Promise<EnterpriseImportCommitResult> {
    const host = getEnterpriseHost();
    if (host === null || host !== expected.host) return { ok: false, reason: "host-changed" };
    const revision = this.credentialRevision;
    const candidate = await commitGhCredential({ account: expected.account }, undefined, host);
    if (isUnavailable(candidate)) return { ok: false, reason: candidate.reason };
    const { credentials, validation } = candidate;
    const token = credentials.token;
    if (!token) return { ok: false, reason: "invalid-output" };
    if (getEnterpriseHost() !== host || this.credentialRevision !== revision) {
      return { ok: false, reason: "host-changed" };
    }
    await this.persist(host, token, {
      valid: true,
      scopes: validation.scopes ?? [],
      ...(validation.account ? { username: validation.account } : {}),
    });
    return {
      ok: true,
      account: validation.account ?? expected.account,
      scopes: validation.scopes ?? [],
    };
  }

  /** Empty the in-memory session; the saved record stays for the next activation. */
  dispose(): void {
    this.disposed = true;
    this.applyGeneration++;
    for (const host of new Set([this.sessionHost, getEnterpriseHost()])) {
      if (host === null) continue;
      GitHubAuth.setMemoryToken(null, host);
      releaseRateLimitServiceForHost(host);
    }
    this.sessionHost = null;
    setEnterpriseHost(null);
  }
}

const TokenArgsSchema = z.object({
  token: z.string().min(1).max(512),
  host: z.string().min(1).max(512),
});
const ClearArgsSchema = z.object({ host: z.string().max(512).nullable() });
const HostArgsSchema = z.object({ host: z.string().max(512) });
const CommitArgsSchema = z.object({
  account: z.string().min(1).max(256),
  host: z.string().min(1).max(512),
});
const EmptyArgsSchema = z.object({}).optional();

const TokenResultSchema = z.object({
  valid: z.boolean(),
  account: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  error: z.string().optional(),
});

/**
 * Wire the account to its settings and register the tab's channels. Must run
 * during `activate()`; the returned disposer empties the session.
 */
export async function registerGitHubEnterprise(
  host: PluginHostApi,
  onCredentialsChanged: () => void
): Promise<() => void> {
  const account = new GitHubEnterpriseAccount({
    settings: {
      get: (key) => host.settings.get(key),
      set: (key, value) => host.settings.set(key, value),
      unset: (key) => host.settings.unset(key),
    },
    onCredentialsChanged,
  });

  const disposers: Array<() => void> = [];
  const subscribe = async (key: string, onChange: (value: unknown) => void) => {
    try {
      disposers.push(await host.settings.onDidChange<unknown>(key, onChange));
    } catch {
      // Without the subscription the host is read again on the next activation.
    }
  };
  await subscribe(ENTERPRISE_HOST_SETTING, (value) => {
    account.onHostSetting(value);
    void account.applySession().catch(() => undefined);
  });
  await subscribe(ENTERPRISE_TOKEN_SETTING, () => {
    account.onTokenSetting();
    void account.applySession().catch(() => undefined);
  });
  // Only the hostname gates registration: remote parsing reads it
  // synchronously. The token is a keychain read that can be slow, so it
  // hydrates in the background rather than holding github.com's activation.
  await account.loadHost();
  void account.applySession().catch(() => undefined);

  await host.registerHandler(
    ENTERPRISE_CHANNELS.status,
    {
      args: z.object({ withAccount: z.boolean().optional() }).optional(),
      result: z.object({
        host: z.string().nullable(),
        hasToken: z.boolean(),
        staleTokenHost: z.string().nullable(),
        account: z.string().optional(),
      }),
    },
    (_ctx, args) => account.status(args?.withAccount === true)
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.setHost,
    {
      args: HostArgsSchema,
      result: z.union([
        z.object({ ok: z.literal(true), host: z.string().nullable() }),
        z.object({ ok: z.literal(false), error: z.string() }),
      ]),
    },
    (_ctx, { host: raw }) => account.setHost(raw)
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.testToken,
    { args: TokenArgsSchema, result: TokenResultSchema },
    (_ctx, { token, host: expectedHost }) => account.testToken(token, expectedHost)
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.saveToken,
    { args: TokenArgsSchema, result: TokenResultSchema },
    (_ctx, { token, host: expectedHost }) => account.saveToken(token, expectedHost)
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.clearToken,
    { args: ClearArgsSchema, result: z.object({ cleared: z.boolean() }) },
    (_ctx, { host: expectedHost }) => account.clearToken(expectedHost)
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.previewImport,
    {
      args: EmptyArgsSchema,
      result: z.union([
        z.object({
          ok: z.literal(true),
          host: z.string(),
          account: z.string(),
          scopes: z.array(z.string()),
          missingScopes: z.array(z.string()),
        }),
        z.object({ ok: z.literal(false), reason: z.string() }),
      ]),
    },
    () => account.previewImport()
  );
  await host.registerHandler(
    ENTERPRISE_CHANNELS.commitImport,
    {
      args: CommitArgsSchema,
      result: z.union([
        z.object({ ok: z.literal(true), account: z.string(), scopes: z.array(z.string()) }),
        z.object({ ok: z.literal(false), reason: z.string() }),
      ]),
    },
    (_ctx, expected) => account.commitImport(expected)
  );

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Keep tearing down the rest.
      }
    }
    account.dispose();
  };
}
