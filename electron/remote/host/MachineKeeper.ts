import type { HostIdleObservation } from "../../../shared/types/hostIdle.js";
import { AppError } from "../../utils/errorTypes.js";
import { lifetimeRenewalDue, stopUnderWay } from "../cloud/lifetimeRenewal.js";
import type { MachineKeeperArmRequest, MachineKeeperStatus } from "../cloud/machineKeeperLink.js";
import type { ProviderResource } from "../cloud/provider.js";

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
  idle: {
    observation(): HostIdleObservation;
    check(): Promise<void>;
    noteWork(): void;
  };
  /** The driver for a key, or why this host can't use it. */
  driverFor(request: MachineKeeperArmRequest): MachineDriver | string;
  now?: () => number;
  tickMs?: number;
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

/**
 * The machine's own keeper (#17361): with the key a Shell handed it, it moves
 * its provider-side lifetime forward while this host sees work, and stops the
 * machine normally once the host has been idle for its idle time, with no
 * Shell attached. The key lives only in this process: a restart, or a fork of
 * the machine's saved disk, holds none until a Shell hands one over again.
 *
 * Both keepers act on what the provider says now, never on what they last
 * did: a deadline someone else moved is read before renewing, and a stop
 * someone else started, or a start that overtook this machine's own stop,
 * is seen and followed.
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
  /** When this machine's own stop was accepted, until it is seen through or overtaken. */
  private stopSentAt: number | null = null;
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

  /** Whether this host will stop its machine once its idle time ends. */
  stopsWhenIdle(): boolean {
    return this.held !== null && this.now() < this.held.expiresAt;
  }

  /** Holds this key in place of any other. Refused, the key it held stays. */
  arm(request: MachineKeeperArmRequest): MachineKeeperStatus {
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
    this.replace({
      grantId: request.grantId,
      resourceId: request.resourceId,
      expiresAt: request.expiresAt,
      driver,
    });
    this.problem = null;
    this.timer ??= setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
    return this.status();
  }

  /** One pass; a pass already under way is shared. Exposed for tests. */
  tick(): Promise<void> {
    if (this.disposed || !this.held) return Promise.resolve();
    this.running ??= this.step().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.replace(null);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private replace(next: HeldKey | null): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.held = next;
    this.reading = null;
    this.retryAt = 0;
    this.failures = 0;
    this.stopSentAt = null;
  }

  private drop(problem: string): void {
    this.replace(null);
    this.problem = problem;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      if (current()) this.reading = { resource, at: this.now() };
      return resource;
    };
    try {
      const idle = this.deps.idle.observation();
      if (this.stopSentAt !== null) {
        await this.followStop(read, current);
      } else if (idle.busy) {
        await this.keepRunning(held, read, current, signal);
      } else if (idle.idleEndsAt !== null && idle.idleEndsAt <= this.now()) {
        await this.stopIdle(held, read, current, signal);
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
      const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
      this.retryAt = this.now() + delay * (0.8 + Math.random() * 0.4);
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
    if (!current() || !this.renewalDue(resource)) return;
    const renewed = await held.driver.renew(resource.lifetimeSeconds!, signal);
    if (current()) this.reading = { resource: renewed, at: this.now() };
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
   * is still running with no stop under way and the host, asked again after
   * the last request came back, still sees no work.
   */
  private async stopIdle(
    held: HeldKey,
    read: () => Promise<ProviderResource>,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const resource = await read();
    if (!current() || resource.machine !== "running" || stopUnderWay(resource.stop)) return;
    // A stop would erase a disk nothing saves; Daintree never makes or takes such a machine.
    if (resource.snapshotsDisabled) return;
    await this.deps.idle.check();
    const idle = this.deps.idle.observation();
    if (!current() || idle.busy || idle.idleEndsAt === null || idle.idleEndsAt > this.now()) return;
    const stopping = await held.driver.stop(signal);
    if (!current()) return;
    this.stopSentAt = this.now();
    if (stopping) this.reading = { resource: stopping, at: this.now() };
  }

  /**
   * After this machine's own stop: wait for it to go through. Running again
   * with no stop under way means someone started it, or their start overtook
   * the stop: that is use, so the idle time starts over.
   */
  private async followStop(
    read: () => Promise<ProviderResource>,
    current: () => boolean
  ): Promise<void> {
    const sentAt = this.stopSentAt!;
    const resource = await read();
    if (!current()) return;
    if (resource.machine === "running" && !stopUnderWay(resource.stop)) {
      if (this.now() - sentAt < STOP_SETTLE_MS) return;
      this.stopSentAt = null;
      this.deps.idle.noteWork();
    }
  }
}
