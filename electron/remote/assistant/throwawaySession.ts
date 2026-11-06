import type { HostThrowawayRun } from "../../../shared/types/hostThrowaway.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";

/** How long a launch or a run may still be going, on the Shell's monotonic clock. */
interface Hold {
  hostId: HostId;
  until: number;
}

const runKey = (hostId: HostId, runId: string): string => `${hostId}\u0000${runId}`;

/**
 * One help session's throwaway runs on hosts: the hosts to release when it
 * ends (#14447), and how long each run may still be going, so the link to a
 * host no window shows isn't released under it (#15878). A host ends a run
 * as soon as its Shell says goodbye, and nothing tells this Shell a run ended
 * on its own, so each is held until an answer shows it over, its session
 * ends, or its time limit passes; a run from a host before time limits has
 * none, so only the first two end it. Bounds are kept on a monotonic clock,
 * so a wall clock stepped forward never lets a run go early. Nothing here
 * runs a timer: each bound is read when the idle sweep asks.
 */
export class ThrowawaySession {
  /** Every host it sent a launch to or saw a run of its own going on. */
  readonly hosts = new Set<HostId>();
  /** Launches whose run isn't known yet, by callId. */
  private readonly launches = new Map<string, Hold>();
  private readonly runs = new Map<string, Hold>();
  /** Runs known to be over, so an answer the host replays from before can't bring one back. */
  private readonly over = new Set<string>();

  constructor(private readonly mono: () => number) {}

  /**
   * A launch about to be sent: until its run is known, the host is held for
   * the run's limit past the latest the host should have started it. A
   * resend keeps the first send's bound. Answers whether this send made the
   * hold, so only its own send failing lets go of it.
   */
  launching(hostId: HostId, callId: string, holdMs: number): boolean {
    const now = this.mono();
    this.prune(now);
    this.hosts.add(hostId);
    if (this.launches.has(callId)) return false;
    this.launches.set(callId, { hostId, until: now + holdMs });
    return true;
  }

  /** The launch sent under `callId` is known not to have started a run. */
  launchFailed(callId: string): void {
    this.launches.delete(callId);
  }

  /**
   * A run as an answer read it. One still going is held for what was left of
   * its limit when first read, and later readings never move that: the limit
   * can't change, an answer the host replays from its record of a call read
   * the run back then, and the host's age reading follows its wall clock.
   */
  observe(hostId: HostId, run: HostThrowawayRun, launchCallId?: string): void {
    const now = this.mono();
    this.prune(now);
    if (launchCallId !== undefined) this.launches.delete(launchCallId);
    const key = runKey(hostId, run.runId);
    if (run.state !== "running") {
      this.runs.delete(key);
      this.over.add(key);
      return;
    }
    if (this.over.has(key) || this.runs.has(key)) return;
    this.hosts.add(hostId);
    const until =
      run.timeLimitMs === null ? Infinity : now + Math.max(0, run.timeLimitMs - run.ageMs);
    this.runs.set(key, { hostId, until });
  }

  /** The host no longer has the run, or its process has ended. */
  runOver(hostId: HostId, runId: string): void {
    const key = runKey(hostId, runId);
    if (this.runs.delete(key)) this.over.add(key);
  }

  /** Whether a run of its own may still be going on `hostId`. */
  holds(hostId: HostId): boolean {
    this.prune(this.mono());
    for (const hold of this.launches.values()) if (hold.hostId === hostId) return true;
    for (const hold of this.runs.values()) if (hold.hostId === hostId) return true;
    return false;
  }

  private prune(now: number): void {
    for (const [callId, hold] of this.launches) {
      if (hold.until <= now) this.launches.delete(callId);
    }
    for (const [key, hold] of this.runs) {
      if (hold.until > now) continue;
      this.runs.delete(key);
      // Past its limit the host has ended it, whatever a later replay says.
      this.over.add(key);
    }
  }
}
