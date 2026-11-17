import crypto from "node:crypto";
import type { CloudHostError } from "../../../shared/types/cloudHosts.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore, StoredMachineKey } from "./CloudHostStore.js";
import {
  MachineKeeperLinkMethod,
  MachineKeeperStatusSchema,
  type MachineKeeperArmRequest,
  type MachineKeeperStatus,
} from "./machineKeeperLink.js";

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
const CALL_TIMEOUT_MS = 30_000;

/** Provider refusals: nothing was made, so there is nothing to look for. */
const REFUSED: ReadonlySet<CloudHostError["code"]> = new Set([
  "credential-invalid",
  "permission",
  "billing",
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
  private readonly arming = new Map<string, Promise<void>>();
  /** Records whose create is out right now: never looked for or revoked meanwhile. */
  private readonly issuing = new Set<string>();
  /** Why a machine can't stop itself, by binding, with the account key it was found with. */
  private readonly problems = new Map<
    string,
    { message: string; at: number; keyHint: string | null; retry: boolean }
  >();
  private readonly armRetryAt = new Map<string, number>();
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

  /** Background pass: replace keys near expiry on machines linked now, retry what may pass, revoke what's left. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const binding of this.deps.store.bindings()) {
      if (!binding.hostId) continue;
      const session = this.deps.sessionFor(binding.hostId);
      if (!session?.isOpen) continue;
      const retryAt = this.armRetryAt.get(binding.id);
      const expiring = this.deps.store
        .machineKeys()
        .some(
          (key) =>
            key.bindingId === binding.id &&
            key.state === "active" &&
            key.expiresAt !== null &&
            key.expiresAt - now <= REPLACE_BEFORE_MS
        );
      if (expiring || (retryAt !== undefined && retryAt <= now)) {
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

  dispose(): void {
    this.disposed = true;
  }

  arm(hostId: HostId, session: LinkSession): Promise<void> {
    const binding = this.deps.store.bindingForHost(hostId);
    if (this.disposed || !binding?.resourceId) return Promise.resolve();
    const running = this.arming.get(binding.id);
    if (running) return running;
    const attempt = this.armOnce(binding.id, hostId, session)
      .catch(() => {
        // A failure that may pass is retried by tick().
        this.armRetryAt.set(binding.id, this.now() + RETRY_MS);
      })
      .finally(() => {
        if (this.arming.get(binding.id) === attempt) this.arming.delete(binding.id);
      });
    this.arming.set(binding.id, attempt);
    return attempt;
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
    if (retry) this.armRetryAt.set(bindingId, this.now() + RETRY_MS);
    if (before !== message) this.deps.changed();
  }

  private clearProblem(bindingId: string): void {
    this.armRetryAt.delete(bindingId);
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
    let credentials: Awaited<ReturnType<CloudAccountService["credentials"]>>;
    let issued: Awaited<ReturnType<NonNullable<typeof provider.machineKeys>["issue"]>>;
    try {
      credentials = await this.deps.accounts.credentials(account);
      issued = await issuer.issue(credentials, resourceId, {
        name: record.name,
        ttlDays: MACHINE_KEY_TTL_DAYS,
      });
    } catch (error) {
      this.issuing.delete(id);
      const described = provider.describeError(error);
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
    // Removed, or moved to another machine, while it was being made.
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
    for (const key of this.deps.store.machineKeys()) {
      if (this.disposed) return;
      if (accountId !== undefined && key.accountId !== accountId) continue;
      const now = this.now();
      const abandoned =
        key.state === "issuing" &&
        !this.issuing.has(key.id) &&
        now - key.createdAt > ISSUING_ABANDONED_MS;
      if ((key.state !== "revoke" && !abandoned) || this.issuing.has(key.id)) continue;
      if (accountId === undefined && (this.revokeRetryAt.get(key.id) ?? 0) > now) continue;
      // Off by itself already.
      const expiresAt = key.expiresAt ?? key.createdAt + MACHINE_KEY_TTL_DAYS * DAY_MS;
      if (expiresAt <= now) {
        this.forget(key.id);
        continue;
      }
      const account = this.deps.store.account(key.accountId);
      if (!account || this.deps.accounts.providerUnavailable(key.providerId)) continue;
      const issuer = this.deps.accounts.provider(key.providerId).machineKeys;
      if (!issuer) continue;
      try {
        const credentials = await this.deps.accounts.credentials(account);
        const ids = key.keyId ? [key.keyId] : await issuer.findByName(credentials, key.name);
        for (const keyId of ids) await issuer.revoke(credentials, keyId);
        this.forget(key.id);
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
