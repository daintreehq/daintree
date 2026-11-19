import { isHostIdleMinutes, type HostIdleObservation } from "../../../shared/types/hostIdle.js";
import type { HostSettingLeaf } from "../../../shared/types/hostSettings.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { withHostIdleClaim } from "../client/claimHostIdle.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import {
  followsHostIdleTime,
  type CloudHostLifecycle,
  type IdleSleepClaim,
} from "./CloudHostLifecycle.js";
import type { CloudHostStore, StoredCloudBinding } from "./CloudHostStore.js";
import { canSleepIdle } from "./provider.js";

/** A try that failed in a way that may pass, or a send the provider refused, is made again after this long. */
const RETRY_MS = 5 * 60_000;
/** A machine that wasn't one to put to sleep at that moment (a dial or an operation under way) is looked at again after this long. */
const SKIPPED_RETRY_MS = 60_000;

/** What a host's latest summary on the current link says of its idle time. */
export interface HostIdleReading {
  idle: HostIdleObservation;
  /** When the host took the summary, by its own clock. */
  sampledAt: number;
}

export interface CloudIdleSleepDeps {
  store: Pick<CloudHostStore, "bindingForHost" | "updateBinding">;
  accounts: Pick<CloudAccountService, "provider" | "providerUnavailable">;
  hosts: { get(hostId: HostId): HostDescriptor | null };
  lifecycle(): Pick<CloudHostLifecycle, "sleepIdleMachine" | "setIdleTime" | "idleTimeWriting"> | null;
  /** The host's open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** The host's latest idle reading, only when its summary came on `session`, and lately. */
  idleReading(hostId: HostId, session: LinkSession): HostIdleReading | null;
  /** Lets go of the host's link once its machine is asleep, unless another link has replaced `session`. */
  release(hostId: HostId, session: LinkSession): void;
  now?: () => number;
}

/**
 * Puts a linked machine to sleep once its host's idle time ends, for a
 * provider whose own idle timer a link keeps from running: Agent 37 counts an
 * open SSH connection as activity (#17916). Driven by the summaries a host
 * already streams, so nothing here dials, holds a link, or wakes on a timer.
 * The host has the last word: it reads afresh and grants the idle time once,
 * and the sleep request goes out in the turn it does.
 *
 * Also keeps the machine's own idle timeout at its host's idle time, for a
 * machine Daintree created or one the person picked an idle time for here.
 */
export class CloudIdleSleep {
  /** Bindings with a sleep under way. */
  private readonly sleeping = new Set<string>();
  /** The idle time each binding last tried, by the host's last work, and when it may be tried again; null for never. */
  private readonly tried = new Map<string, { lastWorkAt: number; retryAt: number | null }>();
  /** A binding whose idle time didn't take waits until then before it is sent again. */
  private readonly idleTimeRetryAt = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: CloudIdleSleepDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A host's summary arrived. */
  summaryReceived(hostId: HostId): void {
    if (this.disposed) return;
    const binding = this.deps.store.bindingForHost(hostId);
    if (!binding?.resourceId || !this.sleepsWhenHostIdle(binding)) return;
    const connection = this.deps.hosts.get(hostId)?.connection;
    if (connection?.kind !== "cloud" || connection.bindingId !== binding.id) return;
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) return;
    const reading = this.deps.idleReading(hostId, session);
    if (!reading) return;
    this.keepIdleTime(binding, reading.idle);
    if (this.due(binding, reading)) {
      void this.sleep(hostId, binding.id, session, reading.idle.lastWorkAt);
    }
  }

  /**
   * A change to a host's settings landed there. A new idle time becomes its
   * machine's own idle timeout too, and turns the provider's idle sleep on: the
   * person picked it. An imported machine follows the host's from then on.
   */
  settingsApplied(hostId: HostId, settings: readonly HostSettingLeaf[]): void {
    if (this.disposed) return;
    const minutes = settings.find((leaf) => leaf.key === "hostIdle.idleAfterMinutes")?.value;
    if (!isHostIdleMinutes(minutes)) return;
    const binding = this.deps.store.bindingForHost(hostId);
    const lifecycle = this.deps.lifecycle();
    if (!binding?.resourceId || !lifecycle || !this.sleepsWhenHostIdle(binding)) return;
    if (!followsHostIdleTime(binding)) {
      this.deps.store.updateBinding(binding.id, (current) => ({
        ...current,
        idleTimeChosen: true,
      }));
    }
    this.idleTimeRetryAt.delete(binding.id);
    void lifecycle.setIdleTime(binding.id, minutes * 60, true).catch(() => {
      this.idleTimeRetryAt.set(binding.id, this.now() + RETRY_MS);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.tried.clear();
    this.idleTimeRetryAt.clear();
  }

  private sleepsWhenHostIdle(binding: StoredCloudBinding): boolean {
    if (this.deps.accounts.providerUnavailable(binding.providerId) !== null) return false;
    return canSleepIdle(this.deps.accounts.provider(binding.providerId));
  }

  /**
   * Sends the host's idle time to a machine that follows it and whose own idle
   * sleep is on. One turned off at the provider stays off until a person
   * picks an idle time here.
   */
  private keepIdleTime(binding: StoredCloudBinding, idle: HostIdleObservation): void {
    if (!followsHostIdleTime(binding) || !isHostIdleMinutes(idle.idleAfterMinutes)) return;
    const own = binding.observation?.idleSleep;
    const seconds = idle.idleAfterMinutes * 60;
    if (own?.enabled !== true || own.idleSeconds === seconds) return;
    const lifecycle = this.deps.lifecycle();
    if (!lifecycle || lifecycle.idleTimeWriting(binding.id)) return;
    const retryAt = this.idleTimeRetryAt.get(binding.id);
    if (retryAt !== undefined && retryAt > this.now()) return;
    // Paused until it lands, or for good measure after: a provider that keeps another value isn't asked every summary.
    this.idleTimeRetryAt.set(binding.id, this.now() + RETRY_MS);
    void lifecycle.setIdleTime(binding.id, seconds, false).catch(() => {});
  }

  private due(binding: StoredCloudBinding, { idle, sampledAt }: HostIdleReading): boolean {
    // Both times are the host's: whether its idle time has ended is its clock's call.
    if (idle.busy || idle.idleEndsAt === null || idle.idleEndsAt > sampledAt) return false;
    if (this.sleeping.has(binding.id)) return false;
    const observed = binding.observation;
    if (observed?.machine !== "running" || observed.idleSleep?.enabled !== true) return false;
    const tried = this.tried.get(binding.id);
    return (
      !tried ||
      tried.lastWorkAt !== idle.lastWorkAt ||
      (tried.retryAt !== null && tried.retryAt <= this.now())
    );
  }

  private async sleep(
    hostId: HostId,
    bindingId: string,
    session: LinkSession,
    lastWorkAt: number
  ): Promise<void> {
    const lifecycle = this.deps.lifecycle();
    if (!lifecycle) return;
    this.sleeping.add(bindingId);
    // One try per idle time unless it says otherwise below: a granted claim spends it.
    const tryAgainIn = (ms: number | null) =>
      this.tried.set(bindingId, { lastWorkAt, retryAt: ms === null ? null : this.now() + ms });
    tryAgainIn(null);
    const asked: { claim: Awaited<ReturnType<IdleSleepClaim>> | null } = { claim: null };
    try {
      const outcome = await lifecycle.sleepIdleMachine(bindingId, async (act) => {
        asked.claim = (await withHostIdleClaim(hostId, session, this.deps.sessionFor, act)).kind;
        return asked.claim;
      });
      if (this.disposed) return;
      if (outcome === "asleep") this.deps.release(hostId, session);
      else if (outcome === "skipped") tryAgainIn(SKIPPED_RETRY_MS);
      // A link replaced before the host decided may not have spent the idle time.
      else if (asked.claim === "superseded") tryAgainIn(RETRY_MS);
    } catch {
      // The host or the provider couldn't be asked: nothing went out, and it's tried again later.
      if (!this.disposed) tryAgainIn(RETRY_MS);
    } finally {
      this.sleeping.delete(bindingId);
    }
  }
}
