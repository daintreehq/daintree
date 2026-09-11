/**
 * HostMemoryPauseTracker - the terminal hosts' memory pause as one app-wide
 * reading for the UI (#12375).
 *
 * `ResourceGovernor` pauses every terminal on its host at once, so the pause is
 * a host fact, not a pane fact. Each shard's pause and memory-warning
 * transitions become a pressure episode, and the episodes are ORed into one
 * snapshot.
 *
 * Fed per shard, before `HostSignalAggregator`: the aggregator drops every
 * transition that leaves its OR unchanged, and those are exactly the ones that
 * say whether a particular shard's pressure cleared. Tracking the aggregate
 * instead would let one shard's clean resume erase a sibling's unresolved
 * forced resume, and would age a fresh pause by an older shard's episode.
 */

import type {
  HostMemoryPauseSnapshot,
  HostThrottlePayload,
} from "../../../shared/types/pty-host.js";

/**
 * How long an episode may stay open before it counts as a stalled recovery —
 * the bound `.claude/rules/user-signals.md` sets for escalating an
 * auto-recovering state out of ambient chrome.
 */
export const HOST_MEMORY_STALL_MS = 30_000;

interface ShardPressure {
  paused: boolean;
  warning: boolean;
  /** Non-null while this shard's episode is open. */
  episodeStartedAt: number | null;
}

export interface HostMemoryPauseTrackerDeps {
  /** Called with every changed snapshot — the release as much as the pause. */
  onChange: (snapshot: HostMemoryPauseSnapshot) => void;
  now?: () => number;
}

const INACTIVE: HostMemoryPauseSnapshot = { active: false, paused: false, stalled: false };

export class HostMemoryPauseTracker {
  private readonly shards = new Map<string, ShardPressure>();
  private snapshot: HostMemoryPauseSnapshot = INACTIVE;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: HostMemoryPauseTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  recordThrottle(shardKey: string, payload: HostThrottlePayload): void {
    const shard = this.getShard(shardKey);
    if (payload.isThrottled) {
      shard.paused = true;
      shard.episodeStartedAt ??= this.now();
    } else {
      shard.paused = false;
      // An unforced resume means utilization fell below the governor's resume
      // threshold: the pressure cleared. A forced one only means the pause hit
      // its time bound, so while the host still warns the episode stays open —
      // and at critical pressure the governor re-pauses on the very next tick.
      if (!payload.forced || !shard.warning) shard.episodeStartedAt = null;
    }
    this.publish();
  }

  recordMemoryWarning(shardKey: string, isWarning: boolean): void {
    const shard = this.getShard(shardKey);
    shard.warning = isWarning;
    // A warning with no pause behind it is advisory and never opens an episode.
    if (!isWarning && !shard.paused) shard.episodeStartedAt = null;
    this.publish();
  }

  /** A retired or crashed shard's pause went with its process. */
  dropShard(shardKey: string): void {
    if (this.shards.delete(shardKey)) this.publish();
  }

  getSnapshot(): HostMemoryPauseSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.clearStallTimer();
    this.shards.clear();
    this.snapshot = INACTIVE;
  }

  private getShard(shardKey: string): ShardPressure {
    let shard = this.shards.get(shardKey);
    if (!shard) {
      shard = { paused: false, warning: false, episodeStartedAt: null };
      this.shards.set(shardKey, shard);
    }
    return shard;
  }

  private publish(): void {
    const now = this.now();
    let paused = false;
    let openedAt: number | null = null;
    for (const shard of this.shards.values()) {
      if (shard.paused) paused = true;
      const startedAt = shard.episodeStartedAt;
      if (startedAt !== null && (openedAt === null || startedAt < openedAt)) {
        openedAt = startedAt;
      }
    }

    const stallAt = openedAt === null ? null : openedAt + HOST_MEMORY_STALL_MS;
    const stalled = stallAt !== null && now >= stallAt;

    // No event arrives at the stall bound — a force-resumed host can sit in its
    // cooldown with nothing to report — so the bound is a deadline of its own.
    this.clearStallTimer();
    if (stallAt !== null && !stalled) {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        this.publish();
      }, stallAt - now);
    }

    const next: HostMemoryPauseSnapshot = { active: openedAt !== null, paused, stalled };
    const previous = this.snapshot;
    if (
      previous.active === next.active &&
      previous.paused === next.paused &&
      previous.stalled === next.stalled
    ) {
      return;
    }
    this.snapshot = next;
    this.deps.onChange(next);
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}
