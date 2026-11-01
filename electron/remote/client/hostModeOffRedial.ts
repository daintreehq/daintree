import type { HostConnectionState, HostId } from "../../../shared/types/remoteHosts.js";

/** The first wait before a window's host is checked again, doubling to a cap. */
export const HOST_MODE_OFF_REDIAL_MS = 30_000;
/** Inside ssh's ControlPersist, so a check rides the master it left rather than logging in again. */
export const HOST_MODE_OFF_REDIAL_MAX_MS = 5 * 60_000;

export interface HostModeOffRedialDeps {
  /** A window shows the host: the only thing that earns a parked link another dial. */
  isShown(hostId: HostId): boolean;
  /** Dial the host's existing link again. */
  redial(hostId: HostId): void;
}

interface Watch {
  /** The link last said Daintree isn't listening there, and stopped. */
  parked: boolean;
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Checks back now and then on a host a window shows whose link parked
 * because no Daintree was listening there. A host that reboots, or whose
 * Daintree is quit and started again, gives that answer for as long as it
 * takes to come back, and the window should then come back with it. Only
 * ever dials an existing link through its own retry, which starts Daintree
 * there only as any dial would (a host that was quit on purpose stays quit),
 * and a host nobody shows stays parked.
 */
export class HostModeOffRedial {
  private readonly watches = new Map<HostId, Watch>();

  constructor(private readonly deps: HostModeOffRedialDeps) {}

  onConnection(hostId: HostId, state: HostConnectionState): void {
    const hostModeOff = state.status === "unreachable" && state.hostModeOff === true;
    // A check under way, or failing some other way it retries by itself (sshd
    // not up yet): the backoff carries on through it.
    const checking =
      state.status === "connecting" ||
      (state.status === "unreachable" && state.stoppedRetrying !== true);
    let watch = this.watches.get(hostId);
    if (!hostModeOff && !(checking && watch)) {
      // Connected (the wait starts over next time), let go, or stopped for a
      // reason another dial won't change (ssh refused the login, another build).
      this.forget(hostId);
      return;
    }
    if (!watch) {
      watch = { parked: false, delayMs: HOST_MODE_OFF_REDIAL_MS, timer: null };
      this.watches.set(hostId, watch);
    }
    watch.parked = hostModeOff;
    if (hostModeOff) this.schedule(hostId, watch);
    else this.clear(watch);
  }

  /** Which windows show which host changed. */
  onWindowsChanged(): void {
    for (const [hostId, watch] of this.watches) if (watch.parked) this.schedule(hostId, watch);
  }

  dispose(): void {
    for (const watch of this.watches.values()) this.clear(watch);
    this.watches.clear();
  }

  private schedule(hostId: HostId, watch: Watch): void {
    if (!this.deps.isShown(hostId)) {
      this.clear(watch);
      return;
    }
    if (watch.timer) return;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      if (!watch.parked || !this.deps.isShown(hostId)) return;
      watch.delayMs = Math.min(watch.delayMs * 2, HOST_MODE_OFF_REDIAL_MAX_MS);
      this.deps.redial(hostId);
    }, watch.delayMs);
    watch.timer.unref?.();
  }

  private clear(watch: Watch): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
  }

  private forget(hostId: HostId): void {
    const watch = this.watches.get(hostId);
    if (watch) this.clear(watch);
    this.watches.delete(hostId);
  }
}
