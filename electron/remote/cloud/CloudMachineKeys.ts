import crypto from "node:crypto";
import type { CloudHostError } from "../../../shared/types/cloudHosts.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore, StoredMachineKey } from "./CloudHostStore.js";
import {
  MachineKeeperLinkMethod,
  MachineKeeperStatusSchema,
  type MachineKeeperArmRequest,
  type MachineKeeperStatus,
} from "./machineKeeperLink.js";
import { UnusableMachineKeyError, type ProviderCredentials } from "./provider.js";

/** How long a machine's key works before the provider turns it off by itself. */
export const MACHINE_KEY_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** A key this close to its expiry is replaced while a link to its machine is up. */
const REPLACE_BEFORE_MS = 10 * DAY_MS;
/** A refused issue is asked again after this long, or as soon as the account's key changes. */
const REFUSED_RETRY_MS = 60 * 60_000;
/** A failure that may pass (a dropped link, an unreachable provider) is tried again after this long. */
const RETRY_MS = 5 * 60_000;
/** An issue left behind by an earlier run: its key, if one was made, is looked for by name. */
const ISSUING_ABANDONED_MS = 10 * 60_000;
/** A key looked for by name and not found yet (its create may still land) is looked for again this much later. */
const LOOKUP_RETRY_MS = 60 * 60_000;
/** How often a linked machine is asked what it holds: a key it lost, or another device's that lapsed. */
const CHECK_EVERY_MS = 30 * 60_000;
const CALL_TIMEOUT_MS = 30_000;

/** Provider refusals: nothing was made, so there is nothing to look for. */
const REFUSED: ReadonlySet<CloudHostError["code"]> = new Set([
  "credential-invalid",
  "permission",
  "billing",
  "unsupported",
]);

/** The host's own answer to an arm: the key was refused, never lost. */
const ARM_REFUSALS: ReadonlySet<string> = new Set(["VALIDATION", "UNSUPPORTED", "PERMISSION"]);

export interface CloudMachineKeysDeps {
  store: CloudHostStore;
  accounts: Pick<CloudAccountService, "provider" | "providerUnavailable" | "credentials">;
  hosts: { get(hostId: HostId): HostDescriptor | null };
  /** The host's open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** What the person sees changed: a reason to show, or one gone. */
  changed(): void;
  now?: () => number;
}

/**
 * When a key stops working by itself. One issued with no expiry the provider
 * vouched for works until revoked; one whose create lost its answer was asked
 * for with the usual lifetime.
 */
function expiryOf(key: StoredMachineKey): number {
  if (key.expiresAt !== null) return key.expiresAt;
  return key.keyId !== null
    ? Number.POSITIVE_INFINITY
    : key.createdAt + MACHINE_KEY_TTL_DAYS * DAY_MS;
}

/** A record a revoke pass may still have work for: one marked for revoking, or an issue that may have been left behind. */
export function awaitsRevoke(key: StoredMachineKey): boolean {
  return key.state === "revoke" || key.state === "issuing";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * The keys this device gives its cloud machines so they keep themselves
 * running while in use and stop themselves once idle (#17361). Each is
 * limited to one machine, issued from the machine's own account, delivered
 * over that machine's own link and nowhere else, and revoked at the provider
 * when its host is removed here. Every key is recorded before the provider is
 * asked for it, so none is lost track of across a crash.
 */
export class CloudMachineKeys {
  /** The attempt under way for each binding, with the link it runs on. */
  private readonly arming = new Map<string, { session: LinkSession; promise: Promise<void> }>();
  /** A link that came up while another's attempt ran: tried once that one settles. */
  private readonly queued = new Map<string, { hostId: HostId; session: LinkSession }>();
  /** Records whose create is out right now: never looked for or revoked meanwhile. */
  private readonly issuing = new Set<string>();
  /** Why a machine can't stop itself, by binding, with the account key it was found with. */
  private readonly problems = new Map<
    string,
    { message: string; at: number; keyHint: string | null; retry: boolean }
  >();
  /** When a linked machine was last asked what it holds. */
  private readonly checkedAt = new Map<string, number>();
  private readonly armRetryAt = new Map<string, number>();
  /** No new key is asked for before this, after one that failed in a way that may pass. */
  private readonly issueNotBefore = new Map<string, number>();
  private readonly revokeRetryAt = new Map<string, number>();
  private revokeTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: CloudMachineKeysDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Why this machine can't keep or stop itself, as last found here; null when nothing stands in the way. */
  problemFor(bindingId: string): string | null {
    return this.problems.get(bindingId)?.message ?? null;
  }

  /** A link to a host came up: make sure its machine holds a working key. */
  sessionOpened(hostId: HostId, session: LinkSession): void {
    void this.arm(hostId, session);
  }

  /**
   * Background pass: asks each linked machine what it holds now and then (a
   * key near expiry is replaced, one it lost is given again, a refusal is
   * asked about again an hour on), retries what may pass, and revokes what's left.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const binding of this.deps.store.bindings()) {
      if (!binding.hostId) continue;
      const session = this.deps.sessionFor(binding.hostId);
      if (!session?.isOpen) continue;
      const retryAt = this.armRetryAt.get(binding.id);
      const checked = this.checkedAt.get(binding.id);
      if (
        (retryAt !== undefined && retryAt <= now) ||
        checked === undefined ||
        now - checked >= CHECK_EVERY_MS
      ) {
        await this.arm(binding.hostId, session);
      }
    }
    await this.revokePending();
  }

  /**
   * Turns off, at the provider, every key nothing here should hold any more.
   * Passes run one after another, so a key marked during one is seen by the next.
   * With `accountId`, only that account's, at once whatever the backoff: its key is about to go.
   */
  revokePending(accountId?: string): Promise<void> {
    const pass = this.revokeTail.then(() => this.revokeOnce(accountId));
    this.revokeTail = pass.catch(() => {});
    return pass;
  }

  /**
   * Before an account's key leaves this device: revoke every key its machines
   * were given, and refuse while one may still work, since nothing else here
   * could turn it off afterwards.
   */
  async settleAccount(accountId: string): Promise<void> {
    await this.revokePending(accountId);
    const now = this.now();
    const live = this.deps.store
      .machineKeys()
      .filter((key) => key.accountId === accountId && expiryOf(key) > now);
    if (live.length === 0) return;
    const message = `Daintree couldn't yet revoke the ${live.length === 1 ? "key it gave a machine" : `keys it gave ${live.length} machines`} on this account. Try again once the provider can be reached.`;
    throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
  }

  dispose(): void {
    this.disposed = true;
    this.queued.clear();
  }

  arm(hostId: HostId, session: LinkSession): Promise<void> {
    const binding = this.deps.store.bindingForHost(hostId);
    if (this.disposed || !binding?.resourceId) return Promise.resolve();
    const bindingId = binding.id;
    const running = this.arming.get(bindingId);
    if (running) {
      // Another link's attempt can't deliver over this one: this one goes next.
      if (running.session !== session) this.queued.set(bindingId, { hostId, session });
      return running.promise;
    }
    const promise = this.armOnce(bindingId, hostId, session)
      .catch(() => {
        // A failure that may pass is retried by tick().
        this.armRetryAt.set(bindingId, this.now() + RETRY_MS);
      })
      .finally(() => {
        if (this.arming.get(bindingId)?.promise === promise) this.arming.delete(bindingId);
        const next = this.queued.get(bindingId);
        this.queued.delete(bindingId);
        if (next && next.session.isOpen && this.deps.sessionFor(next.hostId) === next.session) {
          void this.arm(next.hostId, next.session);
        }
      });
    this.arming.set(bindingId, { session, promise });
    return promise;
  }

  /** The session still reaches this binding's machine: the one the host is bound to, and open. */
  private reaches(
    hostId: HostId,
    bindingId: string,
    resourceId: string,
    session: LinkSession
  ): boolean {
    if (this.disposed || !session.isOpen || this.deps.sessionFor(hostId) !== session) return false;
    const connection = this.deps.hosts.get(hostId)?.connection;
    if (connection?.kind !== "cloud" || connection.bindingId !== bindingId) return false;
    const binding = this.deps.store.binding(bindingId);
    return binding?.hostId === hostId && binding.resourceId === resourceId;
  }

  private setProblem(
    bindingId: string,
    message: string,
    keyHint: string | null,
    retry: boolean
  ): void {
    const before = this.problems.get(bindingId)?.message;
    this.problems.set(bindingId, { message, at: this.now(), keyHint, retry });
    if (retry) {
      this.armRetryAt.set(bindingId, this.now() + RETRY_MS);
      this.issueNotBefore.set(bindingId, this.now() + RETRY_MS);
    }
    if (before !== message) this.deps.changed();
  }

  private clearProblem(bindingId: string): void {
    this.armRetryAt.delete(bindingId);
    this.issueNotBefore.delete(bindingId);
    if (this.problems.delete(bindingId)) this.deps.changed();
  }

  private async armOnce(bindingId: string, hostId: HostId, session: LinkSession): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || this.deps.accounts.providerUnavailable(binding.providerId)) return;
    const resourceId = binding.resourceId;
    const provider = this.deps.accounts.provider(binding.providerId);
    const issuer = provider.machineKeys;
    const account = this.deps.store.account(binding.accountId);
    if (!issuer || !account) return;
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.armRetryAt.delete(bindingId);

    let status: MachineKeeperStatus;
    try {
      status = MachineKeeperStatusSchema.parse(
        await session.call(MachineKeeperLinkMethod.STATUS, null, { timeoutMs: CALL_TIMEOUT_MS })
      );
    } catch (error) {
      if (errorCode(error) === "UNSUPPORTED") {
        this.checkedAt.set(bindingId, this.now());
        this.setProblem(
          bindingId,
          "The Daintree on this machine is too old to stop it by itself. Update it to let it.",
          account.keyHint,
          false
        );
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.checkedAt.set(bindingId, this.now());

    // What the host holds settles every key this device sent it: that one is in use, the rest aren't.
    for (const key of this.deps.store.machineKeys()) {
      if (key.bindingId !== bindingId || (key.state !== "delivering" && key.state !== "active")) {
        continue;
      }
      const held = key.id === status.grantId && key.resourceId === resourceId;
      if (held && key.state !== "active") {
        this.deps.store.updateMachineKey(key.id, (current) => ({ ...current, state: "active" }));
      } else if (!held) {
        this.deps.store.updateMachineKey(key.id, (current) => ({ ...current, state: "revoke" }));
      }
    }
    const now = this.now();
    const lasts = (expiresAt: number | null) =>
      expiresAt !== null && expiresAt - now > REPLACE_BEFORE_MS;
    const ours = status.grantId ? this.deps.store.machineKey(status.grantId) : null;
    if (ours?.state === "active" && lasts(ours.expiresAt)) {
      this.clearProblem(bindingId);
      void this.revokePending();
      return;
    }
    // Another device's key, still good: that device looks after it, and this one leaves it be.
    if (status.grantId && !ours && status.resourceId === resourceId && lasts(status.expiresAt)) {
      this.clearProblem(bindingId);
      void this.revokePending();
      return;
    }
    const refused = this.problems.get(bindingId);
    if (
      refused &&
      !refused.retry &&
      refused.keyHint === account.keyHint &&
      now - refused.at < REFUSED_RETRY_MS
    ) {
      return;
    }
    // A failure that may pass waits out its pause, however often the link comes back.
    const notBefore = this.issueNotBefore.get(bindingId) ?? 0;
    if (notBefore > now) {
      this.armRetryAt.set(bindingId, notBefore);
      return;
    }
    await this.issueAndDeliver(bindingId, hostId, resourceId, session);
    void this.revokePending();
  }

  private async issueAndDeliver(
    bindingId: string,
    hostId: HostId,
    resourceId: string,
    session: LinkSession
  ): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    const account = binding ? this.deps.store.account(binding.accountId) : null;
    if (!binding || !account) return;
    const provider = this.deps.accounts.provider(binding.providerId);
    const issuer = provider.machineKeys!;
    let credentials: ProviderCredentials;
    try {
      credentials = await this.deps.accounts.credentials(account);
    } catch (error) {
      // The account's own key is missing or unusable here: say so, ask nothing of the provider.
      const said =
        error instanceof AppError && error.userMessage ? error.userMessage : String(error);
      this.setProblem(
        bindingId,
        `This machine can't stop itself when idle: ${said}`,
        account.keyHint,
        true
      );
      // Nothing was asked of the provider: a replaced key is tried as soon as the link comes back.
      this.issueNotBefore.delete(bindingId);
      return;
    }
    // Nothing is asked for a link that went, or a run that ended, while the key was read.
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    const id = `mk_${crypto.randomBytes(8).toString("hex")}`;
    const record: StoredMachineKey = {
      id,
      bindingId,
      accountId: account.id,
      providerId: binding.providerId,
      resourceId,
      name: `daintree-${id}`,
      keyId: null,
      expiresAt: null,
      state: "issuing",
      createdAt: this.now(),
    };
    this.deps.store.putMachineKey(record);
    this.issuing.add(id);
    let issued: Awaited<ReturnType<typeof issuer.issue>>;
    try {
      issued = await issuer.issue(credentials, resourceId, {
        name: record.name,
        ttlDays: MACHINE_KEY_TTL_DAYS,
      });
    } catch (error) {
      this.issuing.delete(id);
      const described = provider.describeError(error);
      if (error instanceof UnusableMachineKeyError) {
        // Made, but not as asked: never delivered, and revoked by its id.
        this.deps.store.updateMachineKey(id, (current) => ({
          ...current,
          keyId: error.keyId,
          expiresAt: error.expiresAt,
          state: "revoke",
        }));
        this.setProblem(
          bindingId,
          `This machine can't stop itself when idle: ${described.message}`,
          account.keyHint,
          false
        );
        return;
      }
      if (REFUSED.has(described.code)) {
        this.deps.store.removeMachineKey(id);
        this.setProblem(
          bindingId,
          `This machine can't stop itself when idle: ${provider.info(process.platform).name} didn't let this account's API key give it a key of its own. ${described.message}`,
          account.keyHint,
          false
        );
        return;
      }
      // It may have been made with its answer lost: looked for by name and revoked.
      this.deps.store.updateMachineKey(id, (current) => ({ ...current, state: "revoke" }));
      this.setProblem(
        bindingId,
        `This machine can't stop itself when idle yet: ${described.message}`,
        account.keyHint,
        true
      );
      return;
    }
    this.issuing.delete(id);
    // Its id is kept before the secret goes anywhere.
    const recorded = this.deps.store.updateMachineKey(id, (current) => ({
      ...current,
      keyId: issued.keyId,
      expiresAt: issued.expiresAt,
      state: current.state === "issuing" ? "delivering" : current.state,
    }));
    // Removed, moved to another machine, or its link gone, while it was being made.
    if (recorded?.state !== "delivering" || !this.reaches(hostId, bindingId, resourceId, session)) {
      this.deps.store.updateMachineKey(id, (current) => ({ ...current, state: "revoke" }));
      return;
    }
    const request: MachineKeeperArmRequest = {
      grantId: id,
      provider: binding.providerId,
      apiUrl: credentials.apiUrl,
      scope: credentials.scopeId,
      resourceId,
      secret: issued.secret,
      expiresAt: issued.expiresAt,
    };
    let reply: MachineKeeperStatus;
    try {
      reply = MachineKeeperStatusSchema.parse(
        await session.call(MachineKeeperLinkMethod.ARM, request, { timeoutMs: CALL_TIMEOUT_MS })
      );
    } catch (error) {
      const code = errorCode(error);
      if (code !== null && ARM_REFUSALS.has(code)) {
        this.deps.store.updateMachineKey(id, (current) => ({ ...current, state: "revoke" }));
        const said =
          error instanceof Error && "userMessage" in error && typeof error.userMessage === "string"
            ? error.userMessage
            : "The machine refused the key.";
        this.setProblem(
          bindingId,
          `This machine can't stop itself when idle: ${said}`,
          account.keyHint,
          false
        );
        return;
      }
      // Lost on the way back, perhaps after the host took it: the next status says which.
      this.armRetryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }
    if (reply.grantId !== id) {
      this.deps.store.updateMachineKey(id, (current) => ({ ...current, state: "revoke" }));
      return;
    }
    for (const key of this.deps.store.machineKeys()) {
      if (key.bindingId !== bindingId || key.state === "revoke") continue;
      this.deps.store.updateMachineKey(key.id, (current) => ({
        ...current,
        state: current.id === id ? "active" : "revoke",
      }));
    }
    this.clearProblem(bindingId);
  }

  private async revokeOnce(accountId?: string): Promise<void> {
    for (const { id } of this.deps.store.machineKeys()) {
      if (this.disposed) return;
      // As it stands now: an earlier revoke's wait may have seen it issued, delivered or gone.
      const key = this.deps.store.machineKey(id);
      if (!key || (accountId !== undefined && key.accountId !== accountId)) continue;
      const now = this.now();
      const abandoned =
        key.state === "issuing" &&
        !this.issuing.has(key.id) &&
        now - key.createdAt > ISSUING_ABANDONED_MS;
      if ((key.state !== "revoke" && !abandoned) || this.issuing.has(key.id)) continue;
      if (accountId === undefined && (this.revokeRetryAt.get(key.id) ?? 0) > now) continue;
      // Off by itself already.
      if (expiryOf(key) <= now) {
        this.forget(key.id);
        continue;
      }
      const account = this.deps.store.account(key.accountId);
      if (!account || this.deps.accounts.providerUnavailable(key.providerId)) continue;
      const issuer = this.deps.accounts.provider(key.providerId).machineKeys;
      if (!issuer) continue;
      try {
        const credentials = await this.deps.accounts.credentials(account);
        if (key.keyId) {
          await issuer.revoke(credentials, key.keyId);
          this.forget(key.id);
          continue;
        }
        const ids = await issuer.findByName(credentials, key.name);
        for (const keyId of ids) await issuer.revoke(credentials, keyId);
        if (ids.length > 0) {
          this.forget(key.id);
        } else {
          // Not listed (yet, or to this key at all): kept, and looked for again until it would have expired.
          this.revokeRetryAt.set(key.id, this.now() + LOOKUP_RETRY_MS);
        }
      } catch {
        this.revokeRetryAt.set(key.id, this.now() + RETRY_MS);
      }
    }
  }

  private forget(recordId: string): void {
    this.revokeRetryAt.delete(recordId);
    this.deps.store.removeMachineKey(recordId);
  }
}
