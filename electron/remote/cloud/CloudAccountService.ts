import crypto from "node:crypto";
import {
  isCloudProviderId,
  type CloudAccountAddRequest,
  type CloudAccountCheckResult,
  type CloudAccountSummary,
  type CloudCatalog,
  type CloudProviderId,
  type CloudProviderInfo,
  type CloudResourceSummary,
} from "../../../shared/types/cloudHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CloudCredentialVault } from "./CloudCredentialVault.js";
import type { CloudHostStore, StoredCloudAccount } from "./CloudHostStore.js";
import type { CloudProvider, ProviderCredentials } from "./provider.js";

const MAX_ACCOUNTS = 16;
const MAX_KEY_LENGTH = 4096;
const MAX_NAME_LENGTH = 64;
const CATALOG_TTL_MS = 5 * 60_000;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** A pasted key, trimmed: printable ASCII with no whitespace inside. */
export function normalizeApiKey(value: unknown): string {
  if (typeof value !== "string") throw invalid("Paste the API key as text.");
  const key = value.trim();
  if (key.length === 0) throw invalid("Paste an API key.");
  if (/PRIVATE KEY/.test(key)) throw invalid("That's a private key, not an API key.");
  if (key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw invalid(
      "That doesn't look like an API key: it should be one line of letters, digits and symbols."
    );
  }
  return key;
}

function normalizeName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw invalid("Account name must be text.");
  const name = value.trim();
  if (name.length === 0) return fallback;
  if (name.length > MAX_NAME_LENGTH || [...name].some((ch) => ch < " " || ch === "\x7f")) {
    throw invalid(`Account name must be 1-${MAX_NAME_LENGTH} printable characters.`);
  }
  return name;
}

export interface CloudAccountServiceDeps {
  store: CloudHostStore;
  vault: CloudCredentialVault;
  providers: ReadonlyMap<CloudProviderId, CloudProvider>;
  /** The API base URL this process may use for each provider. */
  apiUrlFor(providerId: CloudProviderId): string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** An account was removed from this device: drop what was kept for it (its ssh key). */
  onAccountRemoved?(accountId: string): Promise<void>;
}

/**
 * Connected provider accounts: checking a pasted key, keeping it in the
 * keychain, resolving it for provider calls, and reading the account's
 * catalog and machines. A key only ever goes to the API origin it was
 * connected against, so a development override can't receive a production key.
 */
export class CloudAccountService {
  private readonly catalogs = new Map<string, CloudCatalog>();

  constructor(private readonly deps: CloudAccountServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  providerInfos(): CloudProviderInfo[] {
    return [...this.deps.providers.values()].map((provider) =>
      provider.info(this.deps.platform ?? process.platform)
    );
  }

  provider(providerId: CloudProviderId): CloudProvider {
    const provider = this.deps.providers.get(providerId);
    if (!provider) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: `Unknown cloud provider ${providerId}`,
        userMessage: "This build of Daintree doesn't know that cloud provider.",
      });
    }
    return provider;
  }

  /** Refused before anything billable happens on a platform the provider can't serve. */
  requireSupported(providerId: CloudProviderId): CloudProvider {
    const provider = this.provider(providerId);
    const reason = provider.info(this.deps.platform ?? process.platform).unsupportedReason;
    if (reason) {
      throw new AppError({ code: "UNSUPPORTED", message: reason, userMessage: reason });
    }
    return provider;
  }

  summaries(): CloudAccountSummary[] {
    const bindings = this.deps.store.bindings();
    return this.deps.store.accounts().map((account) => ({
      id: account.id,
      providerId: account.providerId,
      displayName: account.displayName,
      identity: account.identity,
      billingScope: account.scope,
      validation: account.validation,
      hostCount: bindings.filter((binding) => binding.accountId === account.id && binding.hostId)
        .length,
      addedAt: account.addedAt,
      keyHint: account.keyHint,
    }));
  }

  requireAccount(accountId: unknown): StoredCloudAccount {
    const account = typeof accountId === "string" ? this.deps.store.account(accountId) : null;
    if (!account) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No cloud account ${String(accountId)}`,
        userMessage: "That cloud account isn't connected on this device.",
      });
    }
    return account;
  }

  /** Refused before a pasted key goes anywhere: it couldn't be kept. */
  private requireVault(): void {
    if (this.deps.vault.available()) return;
    throw new AppError({
      code: "UNSUPPORTED",
      message: "No OS keychain to protect the cloud API key",
      userMessage:
        "This device has no secure storage Daintree can use, so it can't keep a cloud API key. Daintree never stores one in plain text.",
    });
  }

  private findDuplicate(
    providerId: CloudProviderId,
    identity: string | null,
    scopeId: string,
    apiUrl: string
  ): StoredCloudAccount | undefined {
    return this.deps.store
      .accounts()
      .find(
        (account) =>
          account.providerId === providerId &&
          account.identity === identity &&
          account.scope.id === scopeId &&
          account.apiUrl === apiUrl
      );
  }

  /** Checks a pasted key without storing it, and lists the scopes it may bill. */
  async checkKey(providerId: unknown, apiKey: unknown): Promise<CloudAccountCheckResult> {
    if (!isCloudProviderId(providerId)) throw invalid("Choose a cloud provider.");
    const provider = this.requireSupported(providerId);
    const key = normalizeApiKey(apiKey);
    this.requireVault();
    try {
      return await provider.checkKey(key, this.deps.apiUrlFor(providerId));
    } catch (error) {
      throw this.asAppError(provider, error);
    }
  }

  async addAccount(request: CloudAccountAddRequest): Promise<CloudAccountSummary> {
    if (!request || typeof request !== "object") throw invalid("Missing account details.");
    if (!isCloudProviderId(request.providerId)) throw invalid("Choose a cloud provider.");
    const provider = this.requireSupported(request.providerId);
    const key = normalizeApiKey(request.apiKey);
    if (typeof request.scopeId !== "string" || request.scopeId.length === 0) {
      throw invalid("Choose which account or organization pays for machines.");
    }
    this.requireVault();
    if (this.deps.store.accounts().length >= MAX_ACCOUNTS) {
      throw invalid(`At most ${MAX_ACCOUNTS} cloud accounts can be connected.`);
    }
    const apiUrl = this.deps.apiUrlFor(request.providerId);
    let checked: CloudAccountCheckResult;
    try {
      checked = await provider.checkKey(key, apiUrl);
    } catch (error) {
      throw this.asAppError(provider, error);
    }
    const choice = checked.scopes.find((entry) => entry.scope.id === request.scopeId);
    if (!choice) throw invalid("This key can't bill that account or organization.");
    const refuseDuplicate = () => {
      const duplicate = this.findDuplicate(
        request.providerId,
        checked.identity,
        choice.scope.id,
        apiUrl
      );
      if (duplicate) {
        throw invalid(
          `${duplicate.displayName} is already connected for ${choice.scope.name}. Replace its key instead.`
        );
      }
      if (this.deps.store.accounts().length >= MAX_ACCOUNTS) {
        throw invalid(`At most ${MAX_ACCOUNTS} cloud accounts can be connected.`);
      }
    };
    refuseDuplicate();
    const id = `ca_${crypto.randomBytes(8).toString("hex")}`;
    const fallbackName =
      choice.scope.kind === "personal"
        ? (checked.identity ?? provider.info(process.platform).name)
        : choice.scope.name;
    const account: StoredCloudAccount = {
      id,
      providerId: request.providerId,
      displayName: normalizeName(request.displayName, fallbackName),
      identity: checked.identity,
      scope: choice.scope,
      apiUrl,
      keyHint: key.slice(-4),
      addedAt: this.now(),
      validation: { status: "valid", checkedAt: this.now() },
    };
    await this.deps.vault.put(id, key);
    // Another connect may have finished while the key was being sealed.
    try {
      refuseDuplicate();
    } catch (error) {
      await this.deps.vault.delete(id).catch(() => {});
      throw error;
    }
    this.deps.store.putAccount(account);
    return this.summaries().find((summary) => summary.id === id)!;
  }

  /** A new key for the same account and scope; machines and hosts stay bound as they are. */
  async replaceKey(accountId: unknown, apiKey: unknown): Promise<CloudAccountSummary> {
    const account = this.requireAccount(accountId);
    const provider = this.requireSupported(account.providerId);
    const key = normalizeApiKey(apiKey);
    this.requireVault();
    this.requireCurrentOrigin(account);
    let checked: CloudAccountCheckResult;
    try {
      checked = await provider.checkKey(key, account.apiUrl);
    } catch (error) {
      throw this.asAppError(provider, error);
    }
    if (account.identity && checked.identity && checked.identity !== account.identity) {
      throw invalid(
        `That key signs in as ${checked.identity}, not ${account.identity}. Connect it as another account instead.`
      );
    }
    if (!checked.scopes.some((choice) => choice.scope.id === account.scope.id)) {
      throw invalid(`That key can't bill ${account.scope.name}.`);
    }
    await this.deps.vault.put(account.id, key);
    const current = this.requireAccount(account.id);
    this.deps.store.putAccount({
      ...current,
      keyHint: key.slice(-4),
      validation: { status: "valid", checkedAt: this.now() },
    });
    this.catalogs.delete(account.id);
    return this.summaries().find((summary) => summary.id === account.id)!;
  }

  rename(accountId: unknown, displayName: unknown): CloudAccountSummary {
    const account = this.requireAccount(accountId);
    this.deps.store.putAccount({
      ...account,
      displayName: normalizeName(displayName, account.displayName),
    });
    return this.summaries().find((summary) => summary.id === account.id)!;
  }

  /**
   * Removes the account from this device and deletes its key here. Refused
   * while hosts use it: their machines would keep running with nothing here
   * able to stop them. Nothing is revoked or deleted at the provider.
   */
  async removeAccount(accountId: unknown): Promise<void> {
    const account = this.requireAccount(accountId);
    const bound = this.deps.store.bindings().filter((binding) => binding.accountId === account.id);
    if (bound.length > 0) {
      throw invalid(
        `${account.displayName} still has ${bound.length === 1 ? "a cloud host" : `${bound.length} cloud hosts`}. Remove ${bound.length === 1 ? "it" : "them"} first, so no machine is left running with nothing here able to stop it.`
      );
    }
    // The key first: if its file can't be written, the account stays listed and removable again.
    await this.deps.vault.delete(account.id);
    this.deps.store.removeAccount(account.id);
    this.catalogs.delete(account.id);
    await this.deps.onAccountRemoved?.(account.id).catch(() => {});
  }

  async validate(accountId: unknown): Promise<CloudAccountSummary> {
    const account = this.requireAccount(accountId);
    const provider = this.provider(account.providerId);
    // A local failure (no key here, another API origin) says nothing about the key at the provider.
    const credentials = await this.credentials(account);
    try {
      const { identity } = await provider.validate(credentials);
      // Removed, or its key replaced, while the check was out: that answer is about another key.
      const current = this.deps.store.account(account.id);
      if (current && current.keyHint === account.keyHint) {
        this.deps.store.putAccount({
          ...current,
          identity: identity ?? current.identity,
          validation: { status: "valid", checkedAt: this.now() },
        });
      }
    } catch (error) {
      const described = provider.describeError(error);
      const current = this.deps.store.account(account.id);
      if (!current || current.keyHint !== account.keyHint) throw this.asAppError(provider, error);
      this.deps.store.putAccount({
        ...current,
        validation:
          described.code === "credential-invalid"
            ? { status: "invalid", checkedAt: this.now(), detail: described.message }
            : { status: "unknown", checkedAt: this.now(), detail: described.message },
      });
      throw this.asAppError(provider, error);
    }
    return this.requireSummary(account.id);
  }

  private requireSummary(accountId: string): CloudAccountSummary {
    const summary = this.summaries().find((entry) => entry.id === accountId);
    if (!summary) this.requireAccount(accountId);
    return summary!;
  }

  async catalog(accountId: unknown, options: { refresh?: boolean } = {}): Promise<CloudCatalog> {
    const account = this.requireAccount(accountId);
    const cached = this.catalogs.get(account.id);
    if (cached && !options.refresh && this.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
    const provider = this.provider(account.providerId);
    try {
      const catalog: CloudCatalog = {
        accountId: account.id,
        ...(await provider.catalog(await this.credentials(account))),
        fetchedAt: this.now(),
      };
      this.catalogs.set(account.id, catalog);
      return catalog;
    } catch (error) {
      this.noteFailure(account, provider, error);
      throw this.asAppError(provider, error);
    }
  }

  /** The cached catalog's hourly rate for a size, when one was read. */
  cachedHourly(accountId: string, machineType: string | null): number | null {
    if (!machineType) return null;
    return (
      this.catalogs.get(accountId)?.machineTypes.find((type) => type.id === machineType)
        ?.hourlyDollars ?? null
    );
  }

  /** Machines in the account's scope, for import. Listing never starts anything. */
  async listResources(accountId: unknown): Promise<CloudResourceSummary[]> {
    const account = this.requireAccount(accountId);
    const provider = this.provider(account.providerId);
    let resources;
    try {
      resources = await provider.list(await this.credentials(account));
    } catch (error) {
      this.noteFailure(account, provider, error);
      throw this.asAppError(provider, error);
    }
    const bindings = this.deps.store
      .bindings()
      .filter((binding) => binding.providerId === account.providerId);
    return resources
      .filter((resource) => resource.machine !== "deleted")
      .map((resource) => ({
        resourceId: resource.resourceId,
        name: resource.name,
        machine: resource.machine,
        rawState: resource.rawState,
        machineType: resource.machineType,
        vcpu: resource.vcpu,
        memoryGB: resource.memoryGB,
        createdAt: resource.createdAt,
        stoppedAt: resource.stoppedAt,
        dataExpired: resource.dataExpired,
        boundHostId:
          bindings.find((binding) => binding.resourceId === resource.resourceId)?.hostId ?? null,
        restricted: resource.restricted,
      }));
  }

  /** The key and scope for a provider call; main only. */
  async credentials(
    account: StoredCloudAccount,
    signal?: AbortSignal
  ): Promise<ProviderCredentials> {
    this.requireCurrentOrigin(account);
    const apiKey = await this.deps.vault.get(account.id);
    if (!apiKey) {
      throw new AppError({
        code: "PERMISSION",
        message: "Cloud account key is missing",
        userMessage: `${account.displayName}'s API key isn't on this device any more. Replace it in Settings → Hosts.`,
      });
    }
    return { apiKey, scopeId: account.scope.id, apiUrl: account.apiUrl, signal };
  }

  /** A provider failure as an AppError the renderer can show, with no secret in it. */
  asAppError(provider: CloudProvider, error: unknown): AppError {
    if (error instanceof AppError) return error;
    const described = provider.describeError(error);
    const code =
      described.code === "credential-invalid" || described.code === "permission"
        ? "PERMISSION"
        : described.code === "rate-limited"
          ? "RATE_LIMITED"
          : described.code === "not-found"
            ? "NOT_FOUND"
            : described.code === "unsupported"
              ? "UNSUPPORTED"
              : "OUTCOME_UNKNOWN";
    return new AppError({ code, message: described.message, userMessage: described.message });
  }

  private noteFailure(account: StoredCloudAccount, provider: CloudProvider, error: unknown): void {
    const described = provider.describeError(error);
    if (described.code !== "credential-invalid") return;
    const current = this.deps.store.account(account.id);
    if (!current) return;
    this.deps.store.putAccount({
      ...current,
      validation: { status: "invalid", checkedAt: this.now(), detail: described.message },
    });
  }

  private requireCurrentOrigin(account: StoredCloudAccount): void {
    const current = this.deps.apiUrlFor(account.providerId);
    if (account.apiUrl === current) return;
    throw new AppError({
      code: "PERMISSION",
      message: "Cloud account was connected against another API origin",
      userMessage: `${account.displayName} was connected against ${account.apiUrl}, and this build talks to ${current}. Its key is never sent anywhere else.`,
    });
  }
}
