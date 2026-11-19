import type { CloudKeepAwake } from "../../../shared/types/cloudHosts.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore, StoredCloudBinding } from "./CloudHostStore.js";
import {
  KeepAwakeLinkMethod,
  KeepAwakeStatusSchema,
  type KeepAwakeArmRequest,
  type KeepAwakeStatus,
} from "./machineKeeperLink.js";
import type { CloudProvider, ProviderCredentials } from "./provider.js";

/** How often a linked machine's host is asked what it holds: one it dropped, or another device's. */
const CHECK_EVERY_MS = 10 * 60_000;
/** A link this close to its expiry is replaced while its machine's own link stays up. */
const RENEW_BEFORE_MS = 24 * 60 * 60_000;
/** A failure that may pass (a dropped link, an unreachable provider) is tried again after this long. */
const RETRY_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 30_000;

const TOO_OLD =
  "The Daintree on this machine is too old to keep it awake with no device connected. Update it to let it.";

type KeepAwakeProvider = CloudProvider & Required<Pick<CloudProvider, "keepAwakeUrl">>;

function holdsKeepAwake(provider: CloudProvider): provider is KeepAwakeProvider {
  return typeof provider.keepAwakeUrl === "function";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function said(error: unknown, fallback: string): string {
  return error instanceof AppError && error.userMessage ? error.userMessage : fallback;
}

export interface CloudKeepAwakeLinksDeps {
  store: Pick<CloudHostStore, "bindings" | "binding" | "bindingForHost" | "account" | "updateBinding">;
  accounts: Pick<CloudAccountService, "provider" | "providerUnavailable" | "credentials">;
  hosts: { get(hostId: HostId): HostDescriptor | null };
  /** The host's open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** What the person sees changed. */
  changed(): void;
  now?: () => number;
}

/**
 * Hands the host of each Agent 37 instance a URL it holds the instance awake
 * with while it sees work, with no device connected (#17918). Agent 37's own
 * idle timer counts only traffic on the instance's URLs, and its keys reach
 * the whole workspace, so the host gets a signed URL for one port of its own
 * instance instead: minted with the account's key here, on every link and
 * again before it expires, and delivered over that machine's own link only.
 * What the host says it holds (never the URL) is kept for the host's details.
 */
export class CloudKeepAwakeLinks {
  /** The attempt under way for each binding, with the link it runs on. */
  private readonly running = new Map<string, { session: LinkSession; promise: Promise<void> }>();
  /** A link that came up while another's attempt ran: tried once that one settles. */
  private readonly queued = new Map<
    string,
    { hostId: HostId; session: LinkSession; mint: boolean }
  >();
  /** Why the host holds no link, by binding, as last found here. */
  private readonly problems = new Map<string, string>();
  private readonly checkedAt = new Map<string, number>();
  /** When the host last said it holds the link stored for its machine. */
  private readonly confirmedAt = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  /** The link on which the host said it doesn't know these calls: not asked again on it. */
  private readonly unsupportedOn = new Map<string, LinkSession>();
  /** Stored expiries already seen passing, so the details change once when one runs out. */
  private readonly expiredSeen = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: CloudKeepAwakeLinksDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** What the host holds, as last heard here; null for a machine whose provider has no such hold. */
  statusFor(bindingId: string): CloudKeepAwake | null {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || !this.providerOf(binding)) return null;
    const stored = binding.keepAwake;
    if (stored && stored.resourceId === binding.resourceId) {
      if (stored.expiresAt <= this.now()) return { kind: "expired", expiredAt: stored.expiresAt };
      return {
        kind: "held",
        expiresAt: stored.expiresAt,
        confirmedAt: Math.max(stored.confirmedAt, this.confirmedAt.get(bindingId) ?? 0),
      };
    }
    return { kind: "none", problem: this.problems.get(bindingId) ?? null };
  }

  /** A link to a host came up: hand its machine a fresh link to hold. */
  sessionOpened(hostId: HostId, session: LinkSession): void {
    void this.run(hostId, session, true);
  }

  /**
   * Background pass: says when a stored link ran out, asks each linked host
   * what it holds now and then, renews a link near its expiry, and retries
   * what may pass.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const bindings = this.deps.store.bindings();
    this.forgetRemoved(bindings);
    const now = this.now();
    for (const binding of bindings) {
      if (this.disposed) return;
      if (!binding.hostId || !binding.resourceId || !this.providerOf(binding)) continue;
      const stored =
        binding.keepAwake?.resourceId === binding.resourceId ? binding.keepAwake : undefined;
      if (stored && stored.expiresAt <= now && !this.expiredSeen.has(binding.id)) {
        this.expiredSeen.add(binding.id);
        this.deps.changed();
      }
      const session = this.deps.sessionFor(binding.hostId);
      if (!session?.isOpen || this.unsupportedOn.get(binding.id) === session) continue;
      const retryAt = this.retryAt.get(binding.id);
      const checked = this.checkedAt.get(binding.id);
      const renew = stored !== undefined && stored.expiresAt - now < RENEW_BEFORE_MS;
      if (retryAt !== undefined) {
        // A pause after a failure holds however long ago the last check was.
        if (retryAt <= now) await this.run(binding.hostId, session, true);
      } else if (renew) {
        await this.run(binding.hostId, session, true);
      } else if (checked === undefined || now - checked >= CHECK_EVERY_MS) {
        await this.run(binding.hostId, session, false);
      }
    }
  }

  /** Forgets what was found for bindings no longer stored. */
  forgetRemoved(bindings = this.deps.store.bindings()): void {
    const live = new Set(bindings.map((binding) => binding.id));
    for (const map of [
      this.problems,
      this.checkedAt,
      this.confirmedAt,
      this.retryAt,
      this.unsupportedOn,
    ]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
    for (const id of this.expiredSeen) if (!live.has(id)) this.expiredSeen.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    this.queued.clear();
  }

  /**
   * Asks the host what it holds over `session` and, with `mint`, hands it a
   * new link. One attempt per binding at a time; a newer link waits its turn.
   */
  run(hostId: HostId, session: LinkSession, mint: boolean): Promise<void> {
    const binding = this.deps.store.bindingForHost(hostId);
    if (this.disposed || !binding?.resourceId) return Promise.resolve();
    const bindingId = binding.id;
    const running = this.running.get(bindingId);
    if (running) {
      // A link since replaced never takes the place of the current link's queued attempt.
      const current = session.isOpen && this.deps.sessionFor(hostId) === session;
      if (current && (running.session !== session || mint)) {
        const queued = this.queued.get(bindingId);
        const sameLink = queued?.session === session;
        this.queued.set(bindingId, {
          hostId,
          session,
          mint: mint || (sameLink && queued.mint),
        });
      }
      return running.promise;
    }
    const promise = this.runOnce(bindingId, hostId, session, mint)
      .catch(() => {
        // A failure that may pass is retried by tick().
        this.retryAt.set(bindingId, this.now() + RETRY_MS);
      })
      .finally(() => {
        if (this.running.get(bindingId)?.promise === promise) this.running.delete(bindingId);
        if (!this.deps.store.binding(bindingId)) this.forgetRemoved();
        const next = this.queued.get(bindingId);
        this.queued.delete(bindingId);
        if (next && next.session.isOpen && this.deps.sessionFor(next.hostId) === next.session) {
          void this.run(next.hostId, next.session, next.mint);
        }
      });
    this.running.set(bindingId, { session, promise });
    return promise;
  }

  private providerOf(binding: StoredCloudBinding): KeepAwakeProvider | null {
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return null;
    const provider = this.deps.accounts.provider(binding.providerId);
    return holdsKeepAwake(provider) ? provider : null;
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

  private async runOnce(
    bindingId: string,
    hostId: HostId,
    session: LinkSession,
    mint: boolean
  ): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const resourceId = binding.resourceId;
    const provider = this.providerOf(binding);
    const account = this.deps.store.account(binding.accountId);
    if (!provider || !account) return;
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    if (this.unsupportedOn.get(bindingId) === session) return;
    this.retryAt.delete(bindingId);

    let status: KeepAwakeStatus;
    try {
      status = await this.call(session, KeepAwakeLinkMethod.STATUS, null);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      if (errorCode(error) === "UNSUPPORTED") {
        this.unsupportedOn.set(bindingId, session);
        this.record(bindingId, resourceId, null, TOO_OLD);
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.record(bindingId, resourceId, status, status.problem);
    if (!mint) return;
    if (status.port === null) {
      // The host couldn't open its port, perhaps for a moment.
      this.retryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }

    let credentials: ProviderCredentials;
    let grant: { url: string; expiresAt: number };
    try {
      credentials = await this.deps.accounts.credentials(account);
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      grant = await provider.keepAwakeUrl(credentials, resourceId, status.port);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      const reason =
        error instanceof AppError
          ? said(error, "Daintree couldn't read the account's key.")
          : provider.describeError(error).message;
      this.noteProblem(
        bindingId,
        `Daintree couldn't get a link from ${provider.info(process.platform).name} to keep this machine awake: ${reason}`
      );
      this.retryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    const request: KeepAwakeArmRequest = { resourceId, url: grant.url, expiresAt: grant.expiresAt };
    try {
      status = await this.call(session, KeepAwakeLinkMethod.ARM, request);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      if (errorCode(error) === "UNSUPPORTED") {
        this.unsupportedOn.set(bindingId, session);
        this.record(bindingId, resourceId, null, TOO_OLD);
        return;
      }
      if (errorCode(error) === "VALIDATION") {
        // Refused: whatever it held before stays, and says so.
        this.noteProblem(bindingId, said(error, "The host refused the link Daintree gave it."));
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.record(bindingId, resourceId, status, status.problem);
  }

  /** Why the host holds no link, said only while it holds none. */
  private noteProblem(bindingId: string, message: string): void {
    const before = JSON.stringify(this.statusFor(bindingId));
    this.problems.set(bindingId, message);
    if (JSON.stringify(this.statusFor(bindingId)) !== before) this.deps.changed();
  }

  /** What the host said it holds, kept for the details; the stored record is written only on a change. */
  private record(
    bindingId: string,
    resourceId: string,
    status: KeepAwakeStatus | null,
    problem: string | null
  ): void {
    const now = this.now();
    const before = JSON.stringify(this.statusFor(bindingId));
    this.checkedAt.set(bindingId, now);
    const expiresAt = status?.expiresAt ?? null;
    if (expiresAt !== null && expiresAt > now) {
      this.confirmedAt.set(bindingId, now);
      this.problems.delete(bindingId);
      this.expiredSeen.delete(bindingId);
      if (this.deps.store.binding(bindingId)?.keepAwake?.expiresAt !== expiresAt) {
        this.deps.store.updateBinding(bindingId, (binding) =>
          binding.resourceId === resourceId
            ? { ...binding, keepAwake: { resourceId, expiresAt, confirmedAt: now } }
            : binding
        );
      }
    } else {
      this.confirmedAt.delete(bindingId);
      if (problem) this.problems.set(bindingId, problem);
      else this.problems.delete(bindingId);
      if (this.deps.store.binding(bindingId)?.keepAwake) {
        this.deps.store.updateBinding(bindingId, (binding) => {
          const { keepAwake: _dropped, ...rest } = binding;
          return rest;
        });
      }
    }
    if (JSON.stringify(this.statusFor(bindingId)) !== before) this.deps.changed();
  }

  private async call(
    session: LinkSession,
    method: string,
    payload: KeepAwakeArmRequest | null
  ): Promise<KeepAwakeStatus> {
    return KeepAwakeStatusSchema.parse(
      await session.call(method, payload, { timeoutMs: CALL_TIMEOUT_MS })
    );
  }
}
