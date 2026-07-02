import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  SESSION_SNAPSHOT_DEBOUNCE_MS,
  persistSessionSnapshotSync,
  persistSessionSnapshotAsync,
  isSessionPersistSuppressed,
} from "./terminalSessionPersistence.js";

const EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS = 2000;

export interface SessionSnapshotterHost {
  readonly id: string;
  readonly wasKilled: boolean;
  readonly launchAgentId: string | undefined;
  // Monotonic buffer-mutation counter (bumped per PTY chunk / resize / snapshot
  // capture). Read as a dirty check so an unchanged buffer is not re-serialized.
  readonly contentEpoch: number;
  hasBannerMarkers(): boolean;
  getSerializedState(): string | null;
  getSerializedStateAsync(): Promise<string | null>;
  serializeForPersistence(): string | null;
}

export class SessionSnapshotter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private inFlight = false;
  private lastEventDrivenFlushAt = -Infinity;
  private eventDrivenInFlight = false;
  private lastFlushedEpoch = -1;
  private disposed = false;

  constructor(private readonly host: SessionSnapshotterHost) {}

  schedule(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.launchAgentId) return;
    if (this.host.wasKilled) return;
    if (this.disposed) return;

    this.dirty = true;
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistAsync();
    }, SESSION_SNAPSHOT_DEBOUNCE_MS);
  }

  private async persistAsync(): Promise<void> {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.launchAgentId) return;
    if (this.host.wasKilled) return;
    if (this.disposed) return;
    if (!this.dirty) return;
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      this.dirty = false;
      const state = this.host.hasBannerMarkers()
        ? this.host.serializeForPersistence()
        : await this.host.getSerializedStateAsync();
      // Re-check lifecycle after the await — a kill or dispose during async
      // serialize would otherwise stomp the sync snapshot written from kill().
      if (this.disposed || this.host.wasKilled) return;
      if (!state) return;
      await persistSessionSnapshotAsync(this.host.id, state);
    } catch (error) {
      console.warn(`[TerminalProcess] Failed to persist session for ${this.host.id}:`, error);
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.dirty) {
        this.schedule();
      }
    }
  }

  flushEventDriven(): void {
    void this.flushEventDrivenAsync();
  }

  // Async event-driven flush fired on agent state settles (waiting/completed/
  // exited). Mirrors persistAsync()'s banner-branch + post-await lifecycle
  // re-check so serializing up to 10k lines no longer blocks the pty-host event
  // loop on every transition. Two short-circuits keep it cheap: an unchanged
  // contentEpoch skips serialization entirely, and a 2s throttle caps churn from
  // rapid changed-content transitions.
  private async flushEventDrivenAsync(): Promise<void> {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.wasKilled) return;
    if (this.disposed) return;

    // Buffer unchanged since the last persisted snapshot — nothing to write.
    // Checked before the throttle so an unchanged flush never consumes the
    // throttle window a later changed-content flush needs.
    const epoch = this.host.contentEpoch;
    if (epoch === this.lastFlushedEpoch) return;

    const now = performance.now();
    if (now - this.lastEventDrivenFlushAt < EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS) return;

    // Drop overlapping flushes: the in-flight one already covers this settle.
    if (this.eventDrivenInFlight) return;
    this.eventDrivenInFlight = true;
    this.lastEventDrivenFlushAt = now;
    try {
      const state = this.host.hasBannerMarkers()
        ? this.host.serializeForPersistence()
        : await this.host.getSerializedStateAsync();
      // Re-check lifecycle after the await — a kill or dispose during async
      // serialize would otherwise stomp the sync snapshot written from kill().
      if (this.disposed || this.host.wasKilled) return;
      if (!state) return;
      await persistSessionSnapshotAsync(this.host.id, state);
      // Mark coverage only after a successful persist. Uses the entry epoch, so
      // content that changed mid-serialize (epoch > entry) still triggers a
      // later flush.
      this.lastFlushedEpoch = epoch;
    } catch (error) {
      console.warn(`[TerminalProcess] Event-driven snapshot failed for ${this.host.id}:`, error);
    } finally {
      this.eventDrivenInFlight = false;
    }
  }

  // Last-chance unconditional flush invoked by kill() before wasKilled is set.
  // Banner-aware: uses serializeForPersistence() so a hibernate→restore→hibernate
  // cycle doesn't bake the previous restore banner into the snapshot.
  flushSyncOnKill(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.launchAgentId) return;

    try {
      const state = this.host.serializeForPersistence();
      if (state) {
        persistSessionSnapshotSync(this.host.id, state);
      }
    } catch {
      // best-effort only
    }
  }

  // Sync flush invoked from dispose() when the debounced timer never fired.
  // Banner-aware (matches the debounced async path) and gated by `dirty` so
  // an already-persisted session is not rewritten on teardown.
  flushSyncOnDispose(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (!this.dirty) return;
    if (this.host.wasKilled) return;

    try {
      const state = this.host.serializeForPersistence() ?? this.host.getSerializedState();
      if (state) {
        persistSessionSnapshotSync(this.host.id, state);
        this.dirty = false;
      }
    } catch {
      // best-effort only
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }
}
