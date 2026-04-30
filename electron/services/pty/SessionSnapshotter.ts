import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  SESSION_SNAPSHOT_MAX_BYTES,
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
      if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
        return;
      }
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
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.wasKilled) return;
    if (this.disposed) return;

    const now = performance.now();
    if (now - this.lastEventDrivenFlushAt < EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS) return;
    this.lastEventDrivenFlushAt = now;

    const state = this.host.getSerializedState();
    if (!state) return;
    if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;

    persistSessionSnapshotAsync(this.host.id, state).catch((error) => {
      console.warn(`[TerminalProcess] Event-driven snapshot failed for ${this.host.id}:`, error);
    });
  }

  // Last-chance unconditional flush invoked by kill() before wasKilled is set.
  // Mirrors the legacy inline block: plain sync serialize, no banner awareness,
  // skipped only when persistence is disabled / suppressed / agent terminal.
  flushSyncOnKill(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.host.launchAgentId) return;

    try {
      const state = this.host.getSerializedState();
      if (state && Buffer.byteLength(state, "utf8") <= SESSION_SNAPSHOT_MAX_BYTES) {
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
      if (state && Buffer.byteLength(state, "utf8") <= SESSION_SNAPSHOT_MAX_BYTES) {
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
