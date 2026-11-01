import {
  MAX_THROWAWAY_TIME_LIMIT_MS,
  type HostThrowawayRun,
} from "../../../shared/types/hostThrowaway.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";

/** How long a launch or a run may still be going, on the Shell's monotonic clock. */
interface Hold {
  hostId: HostId;
  until: number;
}

interface RunHold extends Hold {
  /** False for a run from a host before time limits (#14447), which only a close ends. */
  limited: boolean;
}

const runKey = (hostId: HostId, runId: string): string => `${hostId}\u0000${runId}`;

/**
 * One help session's throwaway runs on hosts: the hosts to release when it
 * ends (#14447), and how long each run may still be going, so the link to a
 * host no window shows isn't released under it (#15878). A host ends a run
 * as soon as its Shell says goodbye, and nothing tells this Shell a run ended
 * on its own, so each is held until an answer shows it over or its time
 * limit passes. Bounds are kept on a monotonic clock, so a wall clock stepped
 * forward never lets a run go early. Nothing here runs a timer: each bound is
 * read when the idle sweep asks.
 */
export class ThrowawaySession {
  /** Every host it sent a launch to or saw a run of its own going on. */
  readonly hosts = new Set<HostId>();
  /** Launches whose run isn't known yet, by callId. */
  private readonly launches = new Map<string, Hold>();
  private readonly runs = new Map<string, RunHold>();
  /** Runs known to be over, so an answer the host replays from before can't bring one back. */
  private readonly over = new Set<string>();

  constructor(private readonly mono: () => number) {}

  /**
   * A launch about to be sent: until its run is known, the host is held for
   * as long as the run it may start could last. A resend keeps the first
   * send's bound. Answers whether this send made the hold, so only its own
   * send failing lets go of it.
   */
  launching(hostId: HostId, callId: string, holdMs: number): boolean {
    this.hosts.add(hostId);
    if (this.launches.has(callId)) return false;
    this.launches.set(callId, { hostId, until: this.mono() + holdMs });
    return true;
  }

  /** The launch sent under `callId` is known not to have started a run. */
  launchFailed(callId: string): void {
    this.launches.delete(callId);
  }

  /**
   * A run as an answer read it. One still going is held for what was left of
   * its time limit when the host read it, never past an earlier bound: an
   * answer the host replays from its record of a call read the run back then.
   */
  observe(hostId: HostId, run: HostThrowawayRun, launchCallId?: string): void {
    const launch = launchCallId === undefined ? undefined : this.launches.get(launchCallId);
    if (launchCallId !== undefined) this.launches.delete(launchCallId);
    if (run.state !== "running") {
      this.runOver(hostId, run.runId);
      return;
    }
    const key = runKey(hostId, run.runId);
    if (this.over.has(key)) return;
    this.hosts.add(hostId);
    const now = this.mono();
    if (run.timeLimitMs === null) {
      this.runs.set(key, { hostId, until: now + MAX_THROWAWAY_TIME_LIMIT_MS, limited: false });
      return;
    }
    const until = Math.min(
      now + Math.max(0, run.timeLimitMs - run.ageMs),
      this.runs.get(key)?.until ?? Infinity,
      launch?.until ?? Infinity
    );
    this.runs.set(key, { hostId, until, limited: true });
  }

  /** The run has ended, been closed, or is gone. */
  runOver(hostId: HostId, runId: string): void {
    const key = runKey(hostId, runId);
    this.runs.delete(key);
    this.over.add(key);
  }

  /** Whether a run of its own may still be going on `hostId`. Forgets every bound that has passed. */
  holds(hostId: HostId): boolean {
    const now = this.mono();
    let held = false;
    for (const [callId, hold] of this.launches) {
      if (hold.until <= now) this.launches.delete(callId);
      else if (hold.hostId === hostId) held = true;
    }
    for (const [key, hold] of this.runs) {
      if (hold.until > now) {
        if (hold.hostId === hostId) held = true;
        continue;
      }
      this.runs.delete(key);
      // Past its limit the host has ended it, whatever a later replay says.
      if (hold.limited) this.over.add(key);
    }
    return held;
  }
}
