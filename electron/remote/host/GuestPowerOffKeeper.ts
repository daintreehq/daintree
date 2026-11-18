import type { HostIdleObservation } from "../../../shared/types/hostIdle.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  sameGuestPowerOffTarget,
  type GuestPowerOffRequest,
  type GuestPowerOffStatus,
  type GuestPowerOffTarget,
} from "../cloud/machineKeeperLink.js";
import type { GuestPowerOffSystem } from "./guestPowerOffSystem.js";

export interface GuestPowerOffKeeperDeps {
  idle: {
    observation(): HostIdleObservation;
    /** A check whose read starts now, after any already under way. */
    checkFresh(): Promise<void>;
    noteWork(): void;
  };
  system: GuestPowerOffSystem;
  now?: () => number;
  tickMs?: number;
}

const TICK_MS = 30_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** A power-off the OS took that hasn't ended this process after this long didn't happen. */
const SHUTDOWN_SETTLE_MS = 5 * 60_000;
const REMOVAL_FAILED =
  "Daintree couldn't remove this machine's saved permission to power itself off. It keeps trying.";

/**
 * Powers this cloud machine off once its host has been idle for its idle
 * time, with no Shell attached (#17362), on a provider where that is a normal
 * stop that keeps the disk (EC2, Compute Engine). It holds no credential and
 * calls no cloud API: a Shell checks the machine at the provider and hands
 * over only which machine it is, and this host acts only after its own cloud
 * metadata server names that same machine.
 *
 * The permission is kept for this boot, so a restarted host still stops its
 * machine; a later boot, a clone of the disk included, needs a Shell to give
 * it again. Taking it back applies the moment it arrives, ahead of any grant
 * still being checked.
 */
export class GuestPowerOffKeeper {
  private armed: GuestPowerOffTarget | null = null;
  /** A permission kept from earlier in this boot, still to be checked against the machine. */
  private restoring: GuestPowerOffTarget | null = null;
  /** Why the last permission given couldn't be taken. */
  private armProblem: string | null = null;
  /** Why the last power-off didn't happen; kept across a repeated permission until one is taken. */
  private powerOffProblem: string | null = null;
  /**
   * A power-off asked of the OS, perhaps taken. It belongs to the machine, not
   * to the permission: taking the permission back and giving it again never
   * lets a second one go while the first may still be under way.
   */
  private poweringOff: { since: number } | null = null;
  /** The saved permission was taken back but its file couldn't be removed yet. */
  private removalPending = false;
  /** Requests in the order they arrived, so a grant checked after a later revoke can't land. */
  private received = 0;
  private revoked: { target: GuestPowerOffTarget; seq: number } | null = null;
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private controller = new AbortController();
  /** Permission changes, one at a time in the order they came. */
  private changes: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: GuestPowerOffKeeperDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  status(): GuestPowerOffStatus {
    return {
      armed: this.armed !== null,
      problem:
        this.armed === null
          ? this.removalPending
            ? REMOVAL_FAILED
            : this.armProblem
          : this.powerOffProblem,
    };
  }

  /** Whether this host will power its machine off once its idle time ends. */
  stopsWhenIdle(): boolean {
    return !this.disposed && this.armed !== null && this.powerOffProblem === null;
  }

  /** Takes back up a permission given earlier in this boot, once the machine is checked again. */
  restore(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || this.deps.system.unsupported() !== null) return;
      const seq = this.received;
      const stored = await this.deps.system.loadArm();
      if (!stored || this.disposed || this.armed || this.restoring) return;
      if (this.revokedSince(stored.target, seq)) return;
      const boot = await this.deps.system.bootId();
      // Unreadable: kept for a later start that can read it, and not acted on now.
      if (boot === null || this.disposed || this.armed) return;
      if (boot !== stored.bootId) {
        // From another boot: given for a machine that has since stopped, or for the disk's original.
        await this.removeSaved();
        return;
      }
      this.restoring = stored.target;
      this.ensureTimer();
      await this.restoreOnce();
    });
  }

  /** Gives or takes back the permission, for the machine it names. */
  set(request: GuestPowerOffRequest): Promise<GuestPowerOffStatus> {
    if (this.disposed) {
      return Promise.reject(
        new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" })
      );
    }
    const seq = ++this.received;
    if (!request.enabled) {
      const { target } = request;
      this.revoked = { target, seq };
      const holds = (held: GuestPowerOffTarget | null) =>
        held !== null && sameGuestPowerOffTarget(held, target);
      // Another machine's permission stays; one for this machine, or a file left behind, goes now.
      if (this.armed !== null && !holds(this.armed)) return Promise.resolve(this.status());
      if (this.restoring !== null && !holds(this.restoring)) return Promise.resolve(this.status());
      this.dropArm();
      return this.enqueue(async () => {
        await this.removeSaved();
        return this.status();
      });
    }
    return this.enqueue(() => this.grant(request.target, seq));
  }

  /** One pass; a pass already under way is shared. Exposed for tests. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.running ??= this.step().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.controller.abort();
    this.stopTimer();
  }

  private enqueue<T>(change: () => Promise<T>): Promise<T> {
    const next = this.changes.then(change);
    this.changes = next.catch(() => {});
    return next;
  }

  /** A revoke for this machine arrived after the request numbered `seq`. */
  private revokedSince(target: GuestPowerOffTarget, seq: number): boolean {
    return (
      this.revoked !== null &&
      this.revoked.seq > seq &&
      sameGuestPowerOffTarget(this.revoked.target, target)
    );
  }

  private async grant(target: GuestPowerOffTarget, seq: number): Promise<GuestPowerOffStatus> {
    if (this.disposed) return this.status();
    const holds = (held: GuestPowerOffTarget | null) =>
      held !== null && sameGuestPowerOffTarget(held, target);
    const unsupported = this.deps.system.unsupported();
    if (unsupported !== null) {
      this.armProblem = unsupported;
      return this.status();
    }
    const signal = this.controller.signal;
    const identity = await this.deps.system.verifyIdentity(target, signal);
    if (this.disposed || this.revokedSince(target, seq)) return this.status();
    if (!identity.ok) {
      if (!identity.definite && holds(this.armed)) {
        // Checked when it was given: a metadata server that doesn't answer now changes nothing.
        return this.status();
      }
      if (identity.definite && (holds(this.armed) || holds(this.restoring))) {
        this.dropArm();
        await this.removeSaved();
      }
      this.armProblem = identity.problem;
      return this.status();
    }
    const refused = await this.deps.system.probePowerOff(signal);
    if (this.disposed || this.revokedSince(target, seq)) return this.status();
    if (refused !== null) {
      if (holds(this.armed) || holds(this.restoring)) {
        this.dropArm();
        await this.removeSaved();
      }
      this.armProblem = refused;
      return this.status();
    }
    const boot = await this.deps.system.bootId();
    if (this.disposed || this.revokedSince(target, seq)) return this.status();
    if (boot !== null) {
      // Kept or not, it holds for as long as this process runs.
      const saved = await this.deps.system.saveArm({ bootId: boot, target }).then(
        () => true,
        () => false
      );
      if (saved) this.removalPending = false;
    }
    if (this.disposed || this.revokedSince(target, seq)) {
      await this.removeSaved();
      return this.status();
    }
    if (!holds(this.armed)) {
      this.generation += 1;
      this.powerOffProblem = null;
      this.retryAt = 0;
      this.failures = 0;
    }
    this.armed = target;
    this.restoring = null;
    this.armProblem = null;
    this.ensureTimer();
    return this.status();
  }

  /** Forgets the permission in this process at once; the saved one goes separately. */
  private dropArm(): void {
    this.generation += 1;
    this.armed = null;
    this.restoring = null;
    this.armProblem = null;
    this.powerOffProblem = null;
    this.retryAt = 0;
    this.failures = 0;
    if (!this.removalPending) this.stopTimer();
  }

  private async removeSaved(): Promise<void> {
    try {
      await this.deps.system.saveArm(null);
      this.removalPending = false;
      if (this.armed === null && this.restoring === null) this.stopTimer();
    } catch {
      // A file left behind would come back on a restart in this boot: tried again on every pass.
      this.removalPending = true;
      this.ensureTimer();
    }
  }

  private async restoreOnce(): Promise<void> {
    const target = this.restoring;
    if (!target || this.disposed) return;
    const generation = this.generation;
    const current = () =>
      !this.disposed && this.generation === generation && this.restoring === target;
    const signal = this.controller.signal;
    const identity = await this.deps.system.verifyIdentity(target, signal);
    if (!current()) return;
    if (!identity.ok) {
      if (identity.definite) {
        this.dropArm();
        await this.removeSaved();
      } else {
        this.backOff();
      }
      return;
    }
    const refused = await this.deps.system.probePowerOff(signal);
    if (!current()) return;
    if (refused !== null) {
      // Perhaps not settled yet this early in the boot: kept, and checked again later.
      this.armProblem = refused;
      this.backOff();
      return;
    }
    this.armed = target;
    this.restoring = null;
    this.armProblem = null;
    this.retryAt = 0;
    this.failures = 0;
  }

  private async step(): Promise<void> {
    if (this.disposed) return;
    if (this.removalPending) await this.enqueue(() => this.removeSaved());
    if (this.restoring) {
      if (this.now() >= this.retryAt) await this.enqueue(() => this.restoreOnce());
      return;
    }
    if (!this.armed) return;
    const now = this.now();
    if (this.poweringOff) {
      if (now - this.poweringOff.since < SHUTDOWN_SETTLE_MS) return;
      // Still here: something held the shutdown off. It counts as use, so a full idle time passes first.
      this.poweringOff = null;
      this.powerOffProblem =
        "This machine asked to power itself off but kept running. It tries again after its next idle time.";
      this.deps.idle.noteWork();
      this.backOff();
      return;
    }
    if (now < this.retryAt || !this.idleEnded(this.deps.idle.observation())) return;
    const generation = this.generation;
    const current = () => !this.disposed && this.generation === generation && this.armed !== null;
    // Everything that can wait is done before the last look, so nothing comes between it and the launch.
    const launch = await this.deps.system.preparePowerOff();
    if (!current()) return;
    if (typeof launch === "string") {
      this.powerOffProblem = launch;
      this.backOff();
      return;
    }
    await this.deps.idle.checkFresh();
    if (!current() || this.poweringOff || !this.idleEnded(this.deps.idle.observation())) return;
    // Recorded before it goes: an answer lost on the way back is never followed by a second one.
    this.poweringOff = { since: this.now() };
    const outcome = await launch(this.controller.signal);
    if (this.disposed) return;
    if (outcome.kind === "accepted") {
      if (this.generation === generation) this.powerOffProblem = null;
      this.failures = 0;
    } else if (outcome.kind === "refused") {
      this.poweringOff = null;
      if (this.generation === generation) this.powerOffProblem = outcome.problem;
      this.backOff();
    }
  }

  private idleEnded(idle: HostIdleObservation): boolean {
    return !idle.busy && idle.idleEndsAt !== null && idle.idleEndsAt <= this.now();
  }

  private backOff(): void {
    this.failures += 1;
    const delay = RETRY_BASE_MS * 2 ** (this.failures - 1) * (0.8 + Math.random() * 0.4);
    this.retryAt = this.now() + Math.min(delay, RETRY_MAX_MS);
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
