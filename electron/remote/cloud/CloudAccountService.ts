import crypto from "node:crypto";
import {
  CLOUD_PROVISIONING_DIMENSIONS,
  canConnectCloudAccount,
  cloudProviderNamespace,
  isCloudProviderId,
  type CloudAccountAddRequest,
  type CloudAccountCheckResult,
  type CloudAccountSummary,
  type CloudCatalog,
  type CloudCredentialValues,
  type CloudProviderId,
  type CloudProviderInfo,
  type CloudProvisioningChoice,
  type CloudProvisioningDimension,
  type CloudProvisioningOptions,
  type CloudProvisioningSelection,
  type CloudResourceSummary,
} from "../../../shared/types/cloudHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CloudCredentialVault } from "./CloudCredentialVault.js";
import type { CloudHostStore, StoredCloudAccount } from "./CloudHostStore.js";
import { cloudCredentialHint, normalizeCloudCredentials } from "./cloudCredentials.js";
import type { CloudProvider, ProviderCatalog, ProviderCredentials } from "./provider.js";

const MAX_ACCOUNTS = 16;
const MAX_NAME_LENGTH = 64;
const CATALOG_TTL_MS = 5 * 60_000;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

const DIMENSION_LABELS: Record<CloudProvisioningDimension, string> = {
  location: "Location",
  image: "Image",
  network: "Network",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * One dimension's options as Daintree shows and checks them: choices with an
 * id, each id once, and a default that names one of them. A provider from a
 * plugin can hand over anything, so nothing here trusts the shape.
 */
function normalizeOptions(
  raw: unknown,
  dimension: CloudProvisioningDimension
): CloudProvisioningOptions {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const choices: CloudProvisioningChoice[] = [];
  for (const entry of Array.isArray(value.choices) ? value.choices : []) {
    const choice = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = typeof choice.id === "string" && choice.id.length > 0 ? choice.id : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    choices.push({
      id,
      label: text(choice.label) ?? id,
      description: text(choice.description),
      // A constraint that doesn't read narrows, never widens: only a plain true is available,
      // and locations that aren't a list tie the choice to none.
      available: choice.available === true,
      reason: text(choice.reason),
      locations:
        dimension === "location" || choice.locations === null || choice.locations === undefined
          ? null
          : Array.isArray(choice.locations)
            ? choice.locations.filter(
                (location): location is string => typeof location === "string"
              )
            : [],
    });
  }
  const defaultId =
    typeof value.defaultId === "string" && seen.has(value.defaultId) ? value.defaultId : null;
  return { label: text(value.label) ?? DIMENSION_LABELS[dimension], choices, defaultId };
}

/** The catalog's options for each dimension the provider says a create takes, and only those. */
export function normalizeProvisioning(
  info: CloudProviderInfo,
  raw: ProviderCatalog["provisioning"]
): CloudCatalog["provisioning"] {
  const offered = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const result = {} as CloudCatalog["provisioning"];
  for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
    result[dimension] =
      info.capabilities.provisioning[dimension] === "none"
        ? null
        : normalizeOptions(offered[dimension], dimension);
  }
  // With no location to pick, nothing can be tied to one.
  if (result.location === null) {
    for (const dimension of ["image", "network"] as const) {
      const options = result[dimension];
      if (options) {
        result[dimension] = {
          ...options,
          choices: options.choices.map((choice) => ({ ...choice, locations: null })),
        };
      }
    }
  }
  return result;
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

/** The providers registered right now; a CloudProviderRegistry, or a plain map in tests. */
export interface CloudProviderLookup {
  get(providerId: CloudProviderId): CloudProvider | undefined;
  values(): Iterable<CloudProvider>;
}

/** Why a stored account or host can't be used while its provider isn't registered. */
export function cloudProviderUnavailableReason(providerId: CloudProviderId): string {
  const namespace = cloudProviderNamespace(providerId);
  return namespace?.kind === "plugin"
    ? `Its cloud provider comes from the ${namespace.pluginId} plugin, which isn't running.`
    : `This build of Daintree doesn't include the ${providerId} cloud provider.`;
}

export interface CloudAccountServiceDeps {
  store: CloudHostStore;
  vault: CloudCredentialVault;
  providers: CloudProviderLookup;
  /** The API base URL this process may use for each provider; null when it isn't registered. */
  apiUrlFor(providerId: CloudProviderId): string | null;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** An account was removed from this device: drop what was kept for it (its ssh key). */
  onAccountRemoved?(accountId: string): Promise<void>;
  /** Before the account's key leaves this device: the last chance to use it. A rejection keeps the account. */
  beforeAccountRemoved?(accountId: string): Promise<void>;
  /** Why an unregistered provider can't be used, when its owner knows better than "missing"; null to fall back. */
  unavailableReason?(providerId: CloudProviderId): string | null;
}

/** The provider's check result, carried on as exactly the declared shape and nothing else. */
function projectCheck(result: CloudAccountCheckResult): CloudAccountCheckResult {
  return {
    // A blank sign-in is no sign-in: it must never stand in for a known one.
    identity:
      typeof result.identity === "string" && result.identity.trim().length > 0
        ? result.identity
        : null,
    scopes: result.scopes.map((choice) => ({
      scope: { kind: choice.scope.kind, id: choice.scope.id, name: choice.scope.name },
      active: choice.active === true,
    })),
  };
}

/** Whether two reads of an account hold the same credentials: a replace changes the revision. */
function sameCredentials(a: StoredCloudAccount, b: StoredCloudAccount): boolean {
  return a.credentialRevision === b.credentialRevision && a.keyHint === b.keyHint;
}

function newCredentialRevision(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Connected provider accounts: checking entered credentials, keeping them in
 * the keychain, resolving them for provider calls, and reading the account's
 * catalog and machines. Credentials only ever go to the API origin they were
 * connected against, so a development override can't receive production ones.
 */
export class CloudAccountService {
  private readonly catalogs = new Map<string, CloudCatalog>();
  /** Per account, the replace or remove committing now; the next one waits for it. */
  private readonly commits = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CloudAccountServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  providerInfos(): CloudProviderInfo[] {
    return [...this.deps.providers.values()].map((provider) =>
      provider.info(this.deps.platform ?? process.platform)
    );
  }

  /** Null while the provider is registered; otherwise why its accounts and hosts can't be used. */
  providerUnavailable(providerId: CloudProviderId): string | null {
    return this.deps.providers.get(providerId) ? null : this.unavailableReason(providerId);
  }

  private unavailableReason(providerId: CloudProviderId): string {
    return this.deps.unavailableReason?.(providerId) ?? cloudProviderUnavailableReason(providerId);
  }

  provider(providerId: CloudProviderId): CloudProvider {
    const provider = this.deps.providers.get(providerId);
    if (!provider) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: `Unknown cloud provider ${providerId}`,
        userMessage: this.unavailableReason(providerId),
      });
    }
    return provider;
  }

  /**
   * Refused before anything entered is read or kept: a plugin's provider
   * would be handed the credentials, which needs the person's say-so first.
   */
  private requireConnectable(providerId: CloudProviderId): void {
    if (canConnectCloudAccount(providerId)) return;
    const message = "Accounts can't be connected for a plugin's cloud provider yet.";
    throw new AppError({ code: "UNSUPPORTED", message, userMessage: message });
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
      providerUnavailable: this.providerUnavailable(account.providerId),
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

  /** Refused before entered credentials go anywhere: they couldn't be kept. */
  private requireVault(): void {
    if (this.deps.vault.available()) return;
    throw new AppError({
      code: "UNSUPPORTED",
      message: "No OS keychain to protect the cloud credentials",
      userMessage:
        "This device has no secure storage Daintree can use, so it can't keep cloud credentials. Daintree never stores them in plain text.",
    });
  }

  /** Entered credentials, checked against what the provider declares. */
  private normalize(provider: CloudProvider, values: unknown): CloudCredentialValues {
    const fields = provider.info(this.deps.platform ?? process.platform).credentialFields;
    return normalizeCloudCredentials(fields, values);
  }

  private hint(provider: CloudProvider, values: CloudCredentialValues): string | null {
    const fields = provider.info(this.deps.platform ?? process.platform).credentialFields;
    return cloudCredentialHint(fields, values);
  }

  private async check(
    provider: CloudProvider,
    values: CloudCredentialValues,
    apiUrl: string
  ): Promise<CloudAccountCheckResult> {
    try {
      return projectCheck(await provider.checkCredentials(values, apiUrl));
    } catch (error) {
      throw this.asAppError(provider, error);
    }
  }

  /** Runs `commit` once the account's previous replace or remove has finished. */
  private serialize<T>(accountId: string, commit: () => Promise<T>): Promise<T> {
    const previous = this.commits.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(commit);
    const settled = next.catch(() => {});
    this.commits.set(accountId, settled);
    void settled.then(() => {
      if (this.commits.get(accountId) === settled) this.commits.delete(accountId);
    });
    return next;
  }

  private findDuplicate(
    providerId: CloudProviderId,
    identity: string | null,
    scopeId: string,
    apiUrl: string,
    exceptId: string | null = null
  ): StoredCloudAccount | undefined {
    // A provider that can't say who a key belongs to can't tell two of its accounts apart.
    if (identity === null) return undefined;
    return this.deps.store
      .accounts()
      .find(
        (account) =>
          account.id !== exceptId &&
          account.providerId === providerId &&
          account.identity === identity &&
          account.scope.id === scopeId &&
          account.apiUrl === apiUrl
      );
  }

  /** Checks entered credentials without keeping them, and lists the scopes they may bill. */
  async checkCredentials(providerId: unknown, values: unknown): Promise<CloudAccountCheckResult> {
    if (!isCloudProviderId(providerId)) throw invalid("Choose a cloud provider.");
    this.requireConnectable(providerId);
    const provider = this.requireSupported(providerId);
    const credentials = this.normalize(provider, values);
    this.requireVault();
    return this.check(provider, credentials, this.apiUrl(providerId));
  }

  async addAccount(request: CloudAccountAddRequest): Promise<CloudAccountSummary> {
    if (!request || typeof request !== "object") throw invalid("Missing account details.");
    if (!isCloudProviderId(request.providerId)) throw invalid("Choose a cloud provider.");
    this.requireConnectable(request.providerId);
    const provider = this.requireSupported(request.providerId);
    const credentials = this.normalize(provider, request.credentials);
    if (typeof request.scopeId !== "string" || request.scopeId.length === 0) {
      throw invalid("Choose who pays for machines.");
    }
    this.requireVault();
    if (this.deps.store.accounts().length >= MAX_ACCOUNTS) {
      throw invalid(`At most ${MAX_ACCOUNTS} cloud accounts can be connected.`);
    }
    const apiUrl = this.apiUrl(request.providerId);
    const checked = await this.check(provider, credentials, apiUrl);
    const choice = checked.scopes.find((entry) => entry.scope.id === request.scopeId);
    if (!choice) throw invalid("These credentials can't create machines billed there.");
    const refuseDuplicate = () => {
      const duplicate = this.findDuplicate(
        request.providerId,
        checked.identity,
        choice.scope.id,
        apiUrl
      );
      if (duplicate) {
        throw invalid(
          `${duplicate.displayName} is already connected for ${choice.scope.name}. Replace its credentials instead.`
        );
      }
      if (this.deps.store.accounts().length >= MAX_ACCOUNTS) {
        throw invalid(`At most ${MAX_ACCOUNTS} cloud accounts can be connected.`);
      }
    };
    refuseDuplicate();
    const id = `ca_${crypto.randomBytes(8).toString("hex")}`;
    // An organization, a project or a provider account is named for itself; a personal or workspace key, for who holds it.
    const fallbackName =
      choice.scope.kind === "organization" ||
      choice.scope.kind === "project" ||
      choice.scope.kind === "account"
        ? choice.scope.name
        : (checked.identity ?? provider.info(process.platform).name);
    const account: StoredCloudAccount = {
      id,
      providerId: request.providerId,
      displayName: normalizeName(request.displayName, fallbackName),
      identity: checked.identity,
      scope: choice.scope,
      apiUrl,
      keyHint: this.hint(provider, credentials),
      credentialRevision: newCredentialRevision(),
      addedAt: this.now(),
      validation: { status: "valid", checkedAt: this.now() },
      lastProvisioning: null,
    };
    await this.deps.vault.put(id, credentials);
    try {
      // Another connect may have finished while the credentials were being sealed.
      refuseDuplicate();
      this.deps.store.putAccount(account);
    } catch (error) {
      // No account will ever name this set: it isn't left sealed with nothing able to remove it.
      await this.deps.vault.delete(id).catch(() => {});
      throw error;
    }
    return this.summaries().find((summary) => summary.id === id)!;
  }

  /**
   * A whole new set for the same account and scope: whatever the old set held
   * and the new one leaves out is gone. Machines and hosts stay bound as they are.
   */
  async replaceCredentials(accountId: unknown, values: unknown): Promise<CloudAccountSummary> {
    const account = this.requireAccount(accountId);
    const provider = this.requireSupported(account.providerId);
    const credentials = this.normalize(provider, values);
    this.requireVault();
    this.requireCurrentOrigin(account);
    const checked = await this.check(provider, credentials, account.apiUrl);
    const refuseOtherIdentity = (current: StoredCloudAccount) => {
      if (current.identity && checked.identity && checked.identity !== current.identity) {
        throw invalid(
          `Those credentials sign in as ${checked.identity}, not ${current.identity}. Connect them as another account instead.`
        );
      }
    };
    refuseOtherIdentity(account);
    if (!checked.scopes.some((choice) => choice.scope.id === account.scope.id)) {
      throw invalid(`Those credentials can't bill ${account.scope.name}.`);
    }
    return this.serialize(account.id, async () => {
      // Removed while the check was out: nothing is sealed for an account that's gone.
      const before = this.requireAccount(account.id);
      this.requireCurrentOrigin(before);
      // A check of the old set may have learned who it signs in as meanwhile.
      refuseOtherIdentity(before);
      // Two accounts for one sign-in and wallet are refused at connect, and so here.
      const identity = checked.identity ?? before.identity;
      const duplicate =
        identity &&
        this.findDuplicate(before.providerId, identity, before.scope.id, before.apiUrl, before.id);
      if (duplicate) {
        throw invalid(
          `${duplicate.displayName} is already connected as ${identity} for ${before.scope.name}. Remove one of them instead.`
        );
      }
      // Nothing says whose these are: they must see the machines this account already has.
      if (checked.identity === null) await this.requireSameMachines(before, provider, credentials);
      // Read before anything is overwritten: a set that can't be read now couldn't be put back.
      const previous = await this.deps.vault.get(account.id);
      await this.deps.vault.put(account.id, credentials);
      try {
        // A connect may have finished while the set was sealed.
        const raced =
          identity &&
          this.findDuplicate(
            before.providerId,
            identity,
            before.scope.id,
            before.apiUrl,
            before.id
          );
        if (raced) throw invalid(`${raced.displayName} is already connected as ${identity}.`);
        const latest = this.deps.store.account(account.id) ?? before;
        // A check of the old set may have learned whose account this is while the new one was sealed.
        refuseOtherIdentity(latest);
        this.deps.store.putAccount({
          ...latest,
          // Who the new set signs in as, never what a check of the old one wrote while it was sealed.
          identity,
          keyHint: this.hint(provider, credentials),
          credentialRevision: newCredentialRevision(),
          validation: { status: "valid", checkedAt: this.now() },
        });
      } catch (error) {
        // The account still names the set it had (a remove waits its turn), so the vault goes back to it.
        await (
          previous ? this.deps.vault.put(account.id, previous) : this.deps.vault.delete(account.id)
        ).catch(() => {});
        throw error;
      }
      this.catalogs.delete(account.id);
      return this.requireSummary(account.id);
    });
  }

  /**
   * For a provider that can't say who a key belongs to: the new key must see
   * at least one of the machines bound to the account. A key for another
   * workspace would otherwise take over, and the bound machines would read as
   * gone (a delete through it, a not-found, forgets a host whose machine
   * keeps billing). An account with no machines has nothing to strand.
   */
  private async requireSameMachines(
    account: StoredCloudAccount,
    provider: CloudProvider,
    values: CloudCredentialValues
  ): Promise<void> {
    const bound = this.deps.store.bindings().filter((binding) => binding.accountId === account.id);
    // A create sent and not yet found is looked for, and deleted, with the account's key.
    if (bound.some((binding) => binding.resourceId === null && binding.creation?.sentAt != null)) {
      throw invalid(
        "A machine this account asked for hasn't been confirmed yet, and a new key may not see it. Replace the key once it has, or remove that host first."
      );
    }
    const resourceIds = bound
      .filter((binding) => binding.resourceId !== null)
      .map((binding) => binding.resourceId!);
    if (resourceIds.length === 0) return;
    const credentials = { values, scopeId: account.scope.id, apiUrl: account.apiUrl };
    for (const resourceId of resourceIds) {
      try {
        await provider.inspect(credentials, resourceId);
        return;
      } catch (error) {
        // One deleted elsewhere proves nothing either way; anything else is an answer to give.
        if (provider.describeError(error).code !== "not-found") {
          throw this.asAppError(provider, error);
        }
      }
    }
    throw invalid(
      `That key can't see this account's machines, so it may belong to another ${provider.info(process.platform).name} workspace. Connect it as another account instead.`
    );
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
   * Removes the account from this device and deletes its credentials here. Refused
   * while hosts use it: their machines would keep running with nothing here
   * able to stop them. Nothing is revoked or deleted at the provider.
   */
  async removeAccount(accountId: unknown): Promise<void> {
    const account = this.requireAccount(accountId);
    await this.serialize(account.id, async () => {
      this.requireAccount(account.id);
      const bound = this.deps.store
        .bindings()
        .filter((binding) => binding.accountId === account.id);
      if (bound.length > 0) {
        throw invalid(
          `${account.displayName} still has ${bound.length === 1 ? "a cloud host" : `${bound.length} cloud hosts`}. Remove ${bound.length === 1 ? "it" : "them"} first, so no machine is left running with nothing here able to stop it.`
        );
      }
      // Keys its machines were given are revoked first; one that may still work keeps the account (#17361).
      await this.deps.beforeAccountRemoved?.(account.id);
      // The credentials first: if their file can't be written, the account stays listed and removable again.
      await this.deps.vault.delete(account.id);
      this.deps.store.removeAccount(account.id);
      this.catalogs.delete(account.id);
    });
    await this.deps.onAccountRemoved?.(account.id).catch(() => {});
  }

  async validate(accountId: unknown): Promise<CloudAccountSummary> {
    const account = this.requireAccount(accountId);
    const provider = this.provider(account.providerId);
    // A local failure (nothing kept here, another API origin) says nothing about the credentials at the provider.
    const credentials = await this.credentials(account);
    try {
      const { identity } = await provider.validate(credentials);
      // Removed, or its credentials replaced, while the check was out: that answer is about another set.
      const current = this.deps.store.account(account.id);
      if (current && sameCredentials(current, account)) {
        this.deps.store.putAccount({
          ...current,
          identity: identity?.trim() ? identity : current.identity,
          validation: { status: "valid", checkedAt: this.now() },
        });
      }
    } catch (error) {
      const described = provider.describeError(error);
      const current = this.deps.store.account(account.id);
      if (!current || !sameCredentials(current, account)) throw this.asAppError(provider, error);
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

  /**
   * The account's catalog. What the provider offers is cached for a while;
   * the account's last choice is read fresh on every call, so a create made
   * a moment ago is what the next dialog starts from.
   */
  async catalog(accountId: unknown, options: { refresh?: boolean } = {}): Promise<CloudCatalog> {
    const account = this.requireAccount(accountId);
    const provider = this.provider(account.providerId);
    const cached = this.catalogs.get(account.id);
    if (cached && !options.refresh && this.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return this.withLastChoice(cached);
    }
    try {
      const offered = await provider.catalog(await this.credentials(account));
      const catalog: CloudCatalog = {
        accountId: account.id,
        machineTypes: offered.machineTypes,
        canStart: offered.canStart,
        includedHoursRemaining: offered.includedHoursRemaining,
        startsRemaining: offered.startsRemaining,
        savedSnapshotDayDollars: offered.savedSnapshotDayDollars,
        provisioning: normalizeProvisioning(
          provider.info(this.deps.platform ?? process.platform),
          offered.provisioning
        ),
        lastChoice: null,
        fetchedAt: this.now(),
      };
      // Not cached when the answer came for credentials since replaced, or an account since removed.
      const current = this.deps.store.account(account.id);
      if (current && sameCredentials(current, account)) this.catalogs.set(account.id, catalog);
      return this.withLastChoice(catalog);
    } catch (error) {
      this.noteFailure(account, provider, error);
      throw this.asAppError(provider, error);
    }
  }

  private withLastChoice(catalog: CloudCatalog): CloudCatalog {
    return {
      ...catalog,
      lastChoice: this.deps.store.account(catalog.accountId)?.lastProvisioning ?? null,
    };
  }

  /** Keeps what a create named as the account's next starting point; an account since removed stays removed. */
  rememberProvisioning(accountId: string, selection: CloudProvisioningSelection): void {
    const current = this.deps.store.account(accountId);
    if (!current) return;
    this.deps.store.putAccount({ ...current, lastProvisioning: { ...selection } });
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
        asleep: resource.machine === "stopped" && resource.asleep === true,
      }));
  }

  /** The credentials and scope for a provider call; main only. */
  async credentials(
    account: StoredCloudAccount,
    signal?: AbortSignal
  ): Promise<ProviderCredentials> {
    this.requireCurrentOrigin(account);
    const values = await this.deps.vault.get(account.id);
    if (!values) {
      throw new AppError({
        code: "PERMISSION",
        message: "Cloud account credentials are missing",
        userMessage: `${account.displayName}'s credentials aren't on this device any more. Replace them in Settings → Hosts.`,
      });
    }
    return { values, scopeId: account.scope.id, apiUrl: account.apiUrl, signal };
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
    // A refusal of credentials since replaced says nothing about the ones kept now.
    const current = this.deps.store.account(account.id);
    if (!current || !sameCredentials(current, account)) return;
    this.deps.store.putAccount({
      ...current,
      validation: { status: "invalid", checkedAt: this.now(), detail: described.message },
    });
  }

  /** The registered provider's API origin; refused, like the provider itself, when it isn't registered. */
  private apiUrl(providerId: CloudProviderId): string {
    const apiUrl = this.deps.apiUrlFor(providerId);
    if (apiUrl === null) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: `No API origin for cloud provider ${providerId}`,
        userMessage: cloudProviderUnavailableReason(providerId),
      });
    }
    return apiUrl;
  }

  private requireCurrentOrigin(account: StoredCloudAccount): void {
    const current = this.apiUrl(account.providerId);
    if (account.apiUrl === current) return;
    throw new AppError({
      code: "PERMISSION",
      message: "Cloud account was connected against another API origin",
      userMessage: `${account.displayName} was connected against ${account.apiUrl}, and this build talks to ${current}. Its credentials are never sent anywhere else.`,
    });
  }
}
