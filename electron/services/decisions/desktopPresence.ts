import { powerMonitor } from "electron";
import { subscribePowerPolicy } from "../../window/powerPolicy.js";
import { readUserPresence, type UserPresence } from "../userPresence.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * How often presence is read and reported while it may be: the client library
 * counts each report that the person is present for two minutes and asks for
 * one about every 30 s while they stay.
 */
export const PRESENCE_TICK_MS = 30_000;

/** What can change the answer between ticks. */
export interface PresenceWatchers {
  /** The machine is about to sleep: away at once, whatever the idle state says. */
  onSuspend(listener: () => void): () => void;
  onResume(listener: () => void): () => void;
  /** The screen locked or unlocked, or a Daintree window gained or lost focus. */
  onChange(listener: () => void): () => void;
}

export interface DesktopPresenceOptions {
  /** Daintree's own reading by default. */
  read?: () => UserPresence;
  /**
   * Whether presence may be reported now (#17240): the owner's lifetime, with
   * the switch on and question notifications on, so the person is told here
   * before their phone is held.
   */
  allowed(): boolean;
  report(present: boolean): void;
  watch?: PresenceWatchers;
  tickMs?: number;
}

/** Electron's own signals: sleep and wake, and the power policy's lock and focus observations. */
export const electronPresenceWatchers: PresenceWatchers = {
  onSuspend(listener) {
    powerMonitor.on("suspend", listener);
    return () => {
      powerMonitor.off("suspend", listener);
    };
  },
  onResume(listener) {
    powerMonitor.on("resume", listener);
    return () => {
      powerMonitor.off("resume", listener);
    };
  },
  onChange(listener) {
    return subscribePowerPolicy((next, previous) => {
      if (
        next.screenLocked !== previous.screenLocked ||
        next.anyWindowFocused !== previous.anyWindowFocused
      ) {
        listener();
      }
    });
  },
};

/**
 * Says whether the person is at this computer, for the relay to hold a new
 * question's phone push while they are (#17240). Present only while Daintree
 * observes them active; unknown, idle, a locked screen and sleep are all away.
 * A present answer is reported on every tick, since each one counts only for a
 * while; away is reported once, when the answer turns, so the lease ends then.
 * Nothing runs, and nothing is reported, while `allowed` says no.
 */
export class DesktopPresence {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: Array<() => void> = [];
  private asleep = false;
  /** The last answer reported: a lease may be current. A reporter that never said present has none to end. */
  private last = false;

  constructor(private readonly o: DesktopPresenceOptions) {}

  /** Follows presence while `allowed` says yes and stops when it says no: whatever it reads may have changed. */
  update(): void {
    if (!this.o.allowed()) {
      this.stop();
      return;
    }
    if (this.timer === null) {
      const watch = this.o.watch ?? electronPresenceWatchers;
      this.offs = [
        watch.onSuspend(() => {
          this.asleep = true;
          this.refresh();
        }),
        watch.onResume(() => {
          this.asleep = false;
          this.refresh();
        }),
        watch.onChange(() => this.refresh()),
      ];
      this.timer = setInterval(() => this.refresh(), this.o.tickMs ?? PRESENCE_TICK_MS);
      this.timer.unref?.();
    }
    this.refresh();
  }

  /** Stops following, ending a lease it may have started. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
    this.asleep = false;
    if (this.last) this.send(false);
    this.last = false;
  }

  /**
   * Reads and reports now while following, as on a tick: present again, or
   * away once when it turns. A new bridge asks for it, so it hears present at
   * once rather than on the next tick.
   */
  refresh(): void {
    if (this.timer === null) return;
    if (!this.o.allowed()) {
      this.stop();
      return;
    }
    const present = !this.asleep && (this.o.read ?? readUserPresence)() === "present";
    if (present || this.last) this.send(present);
    this.last = present;
  }

  private send(present: boolean): void {
    try {
      this.o.report(present);
    } catch (error) {
      console.warn(
        "[Decisions] Presence couldn't be reported:",
        formatErrorMessage(error, "error")
      );
    }
  }
}
