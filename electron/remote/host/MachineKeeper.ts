import { AppError } from "../../utils/errorTypes.js";
import { lifetimeRenewalDue, stopUnderWay } from "../cloud/lifetimeRenewal.js";
import type { MachineKeeperArmRequest, MachineKeeperStatus } from "../cloud/machineKeeperLink.js";
import type { ProviderResource } from "../cloud/provider.js";
import type { HostIdleActorSource } from "./HostIdleTracker.js";

/** What a failed request means for the key: try again later, or it no longer works. */
export type MachineKeeperFailure = { kind: "retry" } | { kind: "lost"; problem: string };

/** This machine, as its provider reports it through the key it was given. */
export interface MachineDriver {
  inspect(signal: AbortSignal): Promise<ProviderResource>;
  /** Moves the automatic stop to `lifetimeSeconds` from now. */
  renew(lifetimeSeconds: number, signal: AbortSignal): Promise<ProviderResource>;
  /** A normal, saving stop, sent once. */
  stop(signal: AbortSignal): Promise<ProviderResource | null>;
  failure(error: unknown): MachineKeeperFailure;
}

export interface MachineKeeperDeps {
  idle: HostIdleActorSource;
  /** The driver for a key, or why this host can't use it. */
  driverFor(request: MachineKeeperArmRequest): MachineDriver | string;
  now?: () => number;
  tickMs?: number;
  /** How long a new key's first read may take before it is taken on trust. */
  verifyTimeoutMs?: number;
}

interface HeldKey {
  grantId: string;
  resourceId: string;
  expiresAt: number;
  driver: MachineDriver;
}

const TICK_MS = 30_000;
/** While in use, the machine's deadline is read again this often, so one moved elsewhere is seen. */
const READING_TTL_MS = 10 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** A stop this machine sent shows as under way at once; still running and not stopping after this, it was overtaken. */
const STOP_SETTLE_MS = 60_000;
const VERIFY_TIMEOUT_MS = 10_000;
const STEP_DEADLINE_MS = 3 * 60_000;
/** A key whose turn comes later than this after it arrived is turned away: its sender has stopped waiting. */
const ARM_WAIT_MS = 20_000;

class VerifyTimeout extends Error {}

/** What changes when the machine is stopped, so a stop and start between two looks still shows. */
function stopMarker(resource: ProviderResource): string {
  return `${resource.stop?.id ?? ""}|${resource.stoppedAt ?? ""}`;
}

/**
 * The machine's own keeper (#17361): with the key a Shell handed it, it moves
 * its provider-side lifetime forward while this host sees work, and stops the
 * machine normally once the host has been idle for its idle time, with no
 * Shell attached. The key lives only in this process: a restart, or a fork of
 * the machine's saved disk, holds none until a Shell hands one over again.
 *
 * Both keepers act on what the provider says now, never on what they last
 * did: a deadline someone else moved is read before renewing, and a stop
 * anyone started is followed until the machine runs again, which counts as
 * use, so an idle time that ended before it never stops a machine someone
 * just started.
 */
export class MachineKeeper {
  private held: HeldKey | null = null;
  private problem: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private reading: { resource: ProviderResource; at: number } | null = null;
  private retryAt = 0;
  private failures = 0;
  /**
   * A stop seen under way, or this machine's own sent (its outcome perhaps
   * unknown) with the idle time it claimed, until it runs again.
   */
  private stopping: { since: number; claimed: number | null } | null = null;
  private marker: string | null = null;
  /** Arms in the order they came, so a late one from a link since gone can't land over a newer one. */
  private arms: Promise<unknown> = Promise.resolve();
  /** Who this keeper is to the idle clock, when it claims an idle time to stop on. */
  private readonly claimant = Symbol("machine-keeper");
  private disposed = false;

  constructor(private readonly deps: MachineKeeperDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  status(): MachineKeeperStatus {
    const held = this.held;
    return {
      grantId: held?.grantId ?? null,
      resourceId: held?.resourceId ?? null,
      expiresAt: held?.expiresAt ?? null,
      problem: held ? null : this.problem,
    };
  }

  /**
   * Whether this host will stop its machine once its idle time ends at `at`
   * (now, when absent): it holds a key that still works then, for a machine
   * whose disk a stop saves.
   */
  stopsWhenIdle(at?: number | null): boolean {
    const held = this.held;
    if (!held || this.reading?.resource.snapshotsDisabled) return false;
    return Math.max(at ?? 0, this.now()) < held.expiresAt;
  }

  /** What it holds once every key handed to it so far has been taken or refused. */
  async settledStatus(): Promise<MachineKeeperStatus> {
    await this.arms;
    return this.status();
  }

  /**
   * Holds this key in place of any other, once a first read through it shows
   * it works for the machine it names. Refused, the key it held stays. Keys
   * are taken one at a time, in the order they came.
   */
  arm(request: MachineKeeperArmRequest): Promise<MachineKeeperStatus> {
    const receivedAt = this.now();
    const taken = this.arms.then(() => {
      if (this.now() - receivedAt > ARM_WAIT_MS) {
        throw new AppError({ code: "CANCELLED", message: "Waited too long behind other keys" });
      }
      return this.armNow(request);
    });
    this.arms = taken.catch(() => {});
    return taken;
  }

  private async armNow(request: MachineKeeperArmRequest): Promise<MachineKeeperStatus> {
    if (this.disposed) {
      throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
    }
    if (request.expiresAt <= this.now()) {
      throw new AppError({ code: "VALIDATION", message: "That key has already expired" });
    }
    const driver = this.deps.driverFor(request);
    if (typeof driver === "string") {
      throw new AppError({ code: "VALIDATION", message: driver, userMessage: driver });
    }
    let first: ProviderResource | null = null;
    const check = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Its own clock, so a driver that ignores the abort still can't hold every later key up.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        check.abort();
        reject(new VerifyTimeout("The first read took too long"));
      }, this.deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);
    });
    try {
      first = await Promise.race([driver.inspect(check.signal), timeout]);
    } catch (error) {
      const failure: MachineKeeperFailure =
        error instanceof VerifyTimeout ? { kind: "retry" } : driver.failure(error);
      if (failure.kind === "lost") {
        throw new AppError({
          code: "VALIDATION",
          message: failure.problem,
          userMessage: failure.problem,
        });
      }
      // Unreachable for now: taken on trust, and its first pass says whether it works.
    } finally {
      clearTimeout(timer);
    }
    if (this.disposed) {
      throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
    }
    const sameMachine = this.held?.resourceId === request.resourceId;
    this.replace(
      {
        grantId: request.grantId,
        resourceId: request.resourceId,
        expiresAt: request.expiresAt,
        driver,
      },
      sameMachine
    );
    this.problem = null;
    if (first) {
      this.reading = { resource: first, at: this.now() };
      this.notice(first);
    }
    this.timer ??= setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
    return this.status();
  }

  /** One pass; a pass already under way is shared. Exposed for tests. */
  tick(): Promise<void> {
    if (this.disposed || !this.held) return Promise.resolve();
    if (this.running) return this.running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A pass that never settles is left behind, and nothing it finds later counts.
    const abandoned = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.generation += 1;
        this.controller?.abort();
        resolve();
      }, STEP_DEADLINE_MS);
    });
    this.running = Promise.race([this.step(), abandoned]).finally(() => {
      clearTimeout(timer);
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.replace(null, false);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A new key, or none. A request already sent under the old one can't be
   * recalled: for the same machine, a stop seen or sent is still followed.
   */
  private replace(next: HeldKey | null, sameMachine: boolean): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.held = next;
    this.reading = null;
    this.retryAt = 0;
    this.failures = 0;
    if (!sameMachine) {
      this.stopping = null;
      this.marker = null;
    }
  }

  private drop(problem: string): void {
    this.replace(null, false);
    this.problem = problem;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What a reading says about stops: one under way is followed; running again
   * afterwards, or stopped and started again since the last look, is use.
   */
  private notice(resource: ProviderResource): void {
    const now = this.now();
    const marker = stopMarker(resource);
    const restartedBetweenLooks = this.marker !== null && marker !== this.marker;
    this.marker = marker;
    if (resource.machine !== "running" || stopUnderWay(resource.stop)) {
      this.stopping ??= { since: now, claimed: null };
      return;
    }
    if (this.stopping) {
      const { claimed } = this.stopping;
      // Its own stop may not show yet; past that, running means the stop was overtaken.
      if (claimed !== null && now - this.stopping.since < STOP_SETTLE_MS) return;
      this.stopping = null;
      // A start after a stop is use; its own stop that never happened is use only for the idle
      // time it claimed, never for one a Shell claimed after newer work.
      if (claimed !== null && !restartedBetweenLooks) this.deps.idle.noteWorkIfCurrent(claimed);
      else this.deps.idle.noteWork();
      return;
    }
    if (restartedBetweenLooks) this.deps.idle.noteWork();
  }

  private async step(): Promise<void> {
    const held = this.held;
    if (!held) return;
    const generation = this.generation;
    const current = () => !this.disposed && this.generation === generation;
    if (this.now() >= held.expiresAt) {
      this.drop(
        "The key Daintree gave this machine expired. Connect to it from Daintree to renew it."
      );
      return;
    }
    if (this.now() < this.retryAt) return;
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const read = async (): Promise<ProviderResource> => {
      const resource = await held.driver.inspect(signal);
      if (current()) {
        this.reading = { resource, at: this.now() };
        this.notice(resource);
      }
      return resource;
    };
    try {
      const idle = this.deps.idle.observation();
      if (this.stopping !== null) {
        // Followed until it runs again; nothing else is done to it meanwhile.
        await read();
      } else if (idle.busy) {
        await this.keepRunning(held, read, current, signal);
      } else if (idle.idleEndsAt !== null && idle.idleEndsAt <= this.now()) {
        if (this.deps.idle.mayClaim(this.claimant))
          await this.stopIdle(held, read, current, signal);
        else await this.followSpent(read);
      }
      if (current()) {
        this.failures = 0;
        this.retryAt = 0;
      }
    } catch (error) {
      if (!current()) return;
      const failure = held.driver.failure(error);
      if (failure.kind === "lost") {
        this.drop(failure.problem);
        return;
      }
      this.failures += 1;
      const delay = RETRY_BASE_MS * 2 ** (this.failures - 1) * (0.8 + Math.random() * 0.4);
      this.retryAt = this.now() + Math.min(delay, RETRY_MAX_MS);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** In use: move the deadline forward once it is near, by the lifetime set on the machine now. */
  private async keepRunning(
    held: HeldKey,
    read: () => Promise<ProviderResource>,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const cached = this.reading;
    const fresh = cached !== null && this.now() - cached.at < READING_TTL_MS;
    if (fresh && !this.renewalDue(cached.resource)) return;
    // Read before writing: the desktop, or the person, may have moved it since.
    const resource = await read();
    if (!current() || this.stopping !== null || !this.renewalDue(resource)) return;
    const renewed = await held.driver.renew(resource.lifetimeSeconds!, signal);
    if (current()) this.reading = { resource: renewed, at: this.now() };
  }

  /**
   * An idle time someone else claimed: nothing is sent, but the machine is
   * still read now and then, so a stop and start at the provider is use.
   */
  private async followSpent(read: () => Promise<ProviderResource>): Promise<void> {
    const cached = this.reading;
    if (cached !== null && this.now() - cached.at < READING_TTL_MS) return;
    await read();
  }

  private renewalDue(resource: ProviderResource): boolean {
    if (resource.machine !== "running" || stopUnderWay(resource.stop)) return false;
    const lifetime = resource.lifetimeSeconds;
    // None set: there is no deadline to move.
    if (lifetime === null || !(lifetime > 0)) return false;
    const deadline = Date.parse(resource.autoStopAt ?? "");
    return Number.isFinite(deadline) && lifetimeRenewalDue(this.now(), deadline, lifetime);
  }

  /**
   * Idle past its idle time: stop the machine, once the provider confirms it
   * is still running with no stop under way and a check of the host started
   * after that answer still sees no work and claims the idle time for this
   * keeper, so a Shell that claimed it first is never followed by a stop here.
   * A stop sent is followed by reading the machine, never by a second claim.
   */
  private async stopIdle(
    held: HeldKey,
    read: () => Promise<ProviderResource>,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const resource = await read();
    if (!current() || this.stopping !== null) return;
    // A stop would erase a disk nothing saves; Daintree never makes or takes such a machine.
    if (resource.snapshotsDisabled) return;
    const reading = await this.deps.idle.checkFresh();
    // A key that lapsed meanwhile can't stop the machine, so it spends no idle time either.
    if (!current() || this.stopping !== null || this.now() >= held.expiresAt) return;
    if (!this.deps.idle.tryClaim(reading, this.claimant)) return;
    // Recorded before it goes: an answer lost on the way back still leaves it followed, never sent twice.
    this.stopping = { since: this.now(), claimed: reading };
    const stopping = await held.driver.stop(signal);
    if (current() && stopping) this.reading = { resource: stopping, at: this.now() };
  }
}
