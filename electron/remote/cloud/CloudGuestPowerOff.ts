import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore } from "./CloudHostStore.js";
import {
  GUEST_POWER_OFF_METHOD,
  GuestPowerOffStatusSchema,
  type GuestPowerOffRequest,
  type GuestPowerOffStatus,
  type GuestPowerOffTarget,
} from "./machineKeeperLink.js";
import type { GuestPowerOffCheck, ProviderCredentials } from "./provider.js";

/** How often a linked machine is checked again at the provider and its host asked to hold the permission. */
const CHECK_EVERY_MS = 30 * 60_000;
/** A check or a call that failed in a way that may pass is tried again after this long. */
const RETRY_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
const CANT = "This machine can't stop itself when idle:";

export interface CloudGuestPowerOffDeps {
  store: Pick<CloudHostStore, "bindings" | "binding" | "bindingForHost" | "account">;
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
 * Lets the host of each EC2 or Compute Engine machine power it off once idle,
 * with no Shell attached (#17362). A guest power-off is a normal stop that
 * keeps the disk there, so the machine needs no credential: this device checks
 * at the provider, on every link and every half hour, that a power-off would
 * stop the machine and keep its disk, and tells its host which machine it is.
 * A machine found no longer safe to power off has the permission taken back.
 */
export class CloudGuestPowerOff {
  /** The attempt under way for each binding, with the link it runs on. */
  private readonly arming = new Map<string, { session: LinkSession; promise: Promise<void> }>();
  /** A link that came up while another's attempt ran: tried once that one settles. */
  private readonly queued = new Map<string, { hostId: HostId; session: LinkSession }>();
  /** Why a machine can't stop itself, by binding. */
  private readonly problems = new Map<string, string>();
  private readonly checkedAt = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: CloudGuestPowerOffDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Why this machine can't stop itself when idle, as last found here; null when nothing stands in the way. */
  problemFor(bindingId: string): string | null {
    return this.problems.get(bindingId) ?? null;
  }

  /** A link to a host came up: make sure its machine may stop itself. */
  sessionOpened(hostId: HostId, session: LinkSession): void {
    void this.arm(hostId, session);
  }

  /** Background pass: checks each linked machine again now and then, and retries what may pass. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const bindings = this.deps.store.bindings();
    const live = new Set(bindings.map((binding) => binding.id));
    for (const map of [this.problems, this.checkedAt, this.retryAt]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
    const now = this.now();
    for (const binding of bindings) {
      if (this.disposed) return;
      if (!binding.hostId) continue;
      const session = this.deps.sessionFor(binding.hostId);
      if (!session?.isOpen) continue;
      const retryAt = this.retryAt.get(binding.id);
      const checked = this.checkedAt.get(binding.id);
      // A pause after a failure holds however long ago the last check was.
      const due =
        retryAt !== undefined
          ? retryAt <= now
          : checked === undefined || now - checked >= CHECK_EVERY_MS;
      if (due) await this.arm(binding.hostId, session);
    }
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
      if (running.session !== session) this.queued.set(bindingId, { hostId, session });
      return running.promise;
    }
    const promise = this.armOnce(bindingId, hostId, session)
      .catch(() => {
        // A failure that may pass is retried by tick().
        this.retryAt.set(bindingId, this.now() + RETRY_MS);
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

  private setProblem(bindingId: string, message: string): void {
    const before = this.problems.get(bindingId);
    this.problems.set(bindingId, message);
    if (before !== message) this.deps.changed();
  }

  private clearProblem(bindingId: string): void {
    if (this.problems.delete(bindingId)) this.deps.changed();
  }

  private async armOnce(bindingId: string, hostId: HostId, session: LinkSession): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || this.deps.accounts.providerUnavailable(binding.providerId)) return;
    const resourceId = binding.resourceId;
    const provider = this.deps.accounts.provider(binding.providerId);
    const account = this.deps.store.account(binding.accountId);
    if (typeof provider.checkGuestPowerOff !== "function" || !account) return;
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.retryAt.delete(bindingId);

    let credentials: ProviderCredentials;
    try {
      credentials = await this.deps.accounts.credentials(account);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      const said =
        error instanceof AppError && error.userMessage ? error.userMessage : String(error);
      this.checkedAt.set(bindingId, this.now());
      this.setProblem(bindingId, `${CANT} ${said}`);
      this.retryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    // Throws when the provider couldn't be asked: nothing is changed, and it's asked again later.
    const check: GuestPowerOffCheck = await provider.checkGuestPowerOff(credentials, resourceId);
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.checkedAt.set(bindingId, this.now());
    if (!check.eligible) {
      this.setProblem(bindingId, `${CANT} ${check.problem}`);
      // Given before, perhaps by another device: no longer safe, so taken back. A take-back that
      // may not have arrived is sent again soon, not in half an hour.
      if (check.target) {
        try {
          await this.send(session, check.target, false);
        } catch (error) {
          if (errorCode(error) !== "UNSUPPORTED")
            this.retryAt.set(bindingId, this.now() + RETRY_MS);
        }
      }
      return;
    }
    let status: GuestPowerOffStatus;
    try {
      status = await this.send(session, check.target, true);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      if (errorCode(error) === "UNSUPPORTED") {
        this.setProblem(
          bindingId,
          "The Daintree on this machine is too old to stop it by itself. Update it to let it."
        );
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    if (status.armed && status.problem === null) {
      this.clearProblem(bindingId);
      return;
    }
    this.setProblem(
      bindingId,
      status.problem ?? `${CANT} its host didn't take the permission to power it off.`
    );
    // The host may not have been able to read its identity yet.
    if (!status.armed) this.retryAt.set(bindingId, this.now() + RETRY_MS);
  }

  private async send(
    session: LinkSession,
    target: GuestPowerOffTarget,
    enabled: boolean
  ): Promise<GuestPowerOffStatus> {
    const request: GuestPowerOffRequest = { target, enabled };
    return GuestPowerOffStatusSchema.parse(
      await session.call(GUEST_POWER_OFF_METHOD, request, { timeoutMs: CALL_TIMEOUT_MS })
    );
  }
}
