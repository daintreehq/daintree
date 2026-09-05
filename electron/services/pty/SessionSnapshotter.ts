import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
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
  getSerializedState(): SerializedTerminalSnapshot | null;
  getSerializedStateAsync(): Promise<SerializedTerminalSnapshot | null>;
  // Sync snapshot in-thread; a Promise when the buffer lives in an analysis
  // worker. The sync flush paths degrade to best-effort async persistence for
  // Promise-returning hosts.
  serializeForPersistence():
    SerializedTerminalSnapshot | null | Promise<SerializedTerminalSnapshot | null>;
}

// Narrow view of a TerminalProcess-shaped owner, sufficient to build either
// the worker-mode or in-thread SessionSnapshotterHost without this module
// depending on TerminalProcess itself.
export interface TerminalSessionSnapshotterFactoryHost {
  readonly id: string;
  readonly isWorkerAnalysis: boolean;
  readonly wasKilled: boolean;
  readonly launchAgentId: string | undefined;
  readonly contentEpoch: number;
  readonly hasRestoreBannerMarkers: boolean;
  getSerializedState(): SerializedTerminalSnapshot | null;
  getSerializedStateAsync(): Promise<SerializedTerminalSnapshot | null>;
  serializeForPersistence(): SerializedTerminalSnapshot | null;
  serializeForPersistenceViaAnalysis(): Promise<SerializedTerminalSnapshot | null>;
}

export function createTerminalSessionSnapshotter(
  host: TerminalSessionSnapshotterFactoryHost
): SessionSnapshotter {
  if (host.isWorkerAnalysis) {
    const snapshotterHost: SessionSnapshotterHost = {
      get id() {
        return host.id;
      },
      get wasKilled() {
        return host.wasKilled;
      },
      get launchAgentId() {
        return host.launchAgentId;
      },
      get contentEpoch() {
        return host.contentEpoch;
      },
      // Route every persistence serialize through the worker's banner-aware
      // op (it falls back to a plain serialize when no banner markers exist),
      // so the host never needs to know whether a restore banner is present.
      hasBannerMarkers: () => true,
      getSerializedState: () => null,
      getSerializedStateAsync: () => host.getSerializedStateAsync(),
      serializeForPersistence: () => host.serializeForPersistenceViaAnalysis(),
    };
    return new SessionSnapshotter(snapshotterHost);
  }

  const snapshotterHost: SessionSnapshotterHost = {
    get id() {
      return host.id;
    },
    get wasKilled() {
      return host.wasKilled;
    },
    get launchAgentId() {
      return host.launchAgentId;
    },
    get contentEpoch() {
      return host.contentEpoch;
    },
    hasBannerMarkers: () => host.hasRestoreBannerMarkers,
    getSerializedState: () => host.getSerializedState(),
    getSerializedStateAsync: () => host.getSerializedStateAsync(),
    serializeForPersistence: () => host.serializeForPersistence(),
  };
  return new SessionSnapshotter(snapshotterHost);
}

type CaptureTrigger = "periodic" | "event";

export class SessionSnapshotter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  // One in-flight flag for both triggers: a capture already running covers the
  // buffer either of them would serialize, so the second trigger records a
  // follow-up instead of starting a duplicate serialize + write.
  private inFlight = false;
  private lastEventDrivenFlushAt = -Infinity;
  private pendingEventFlush = false;
  // Shared "already persisted" identity, stamped by whichever trigger wrote
  // last. contentEpoch covers geometry as well as output — resize reflow,
  // geometry resync and preserved-snapshot capture all bump it — so an
  // unchanged epoch means the bytes on disk are the bytes we would write, and
  // no separate cols/rows key is needed.
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
    // Anchored, not refreshed: an armed timer keeps its original deadline so
    // sustained output cannot push the durability write out indefinitely.
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.captureAsync("periodic");
    }, SESSION_SNAPSHOT_DEBOUNCE_MS);
  }

  flushEventDriven(): void {
    void this.captureAsync("event");
  }

  // The one capture path behind both triggers. What stays per-trigger is the
  // eligibility gate and the timing — periodic is debounced 5s and skips agent
  // terminals, event-driven is throttled 2s and includes them. What is shared
  // is the in-flight flag, the persisted-epoch identity, and the serialize +
  // write itself.
  //
  // These were two independent routines with no common state until #12237, so
  // the end of every agent turn paid for the same buffer twice: the last output
  // chunk armed the debounce, the FSM settle fired the event flush and
  // serialized immediately, and the timer then fired and serialized identical
  // content because it had never looked at the epoch.
  //
  // Serializing up to 10k lines must not block the pty-host event loop, so the
  // work is async and every await is followed by a lifecycle re-check.
  private async captureAsync(trigger: CaptureTrigger): Promise<void> {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    // Agent terminals are event-driven only: their scrollback is captured on a
    // state settle, never on the debounce.
    if (trigger === "periodic" && this.host.launchAgentId) return;
    if (this.host.wasKilled) return;
    if (this.disposed) return;
    if (trigger === "periodic" && !this.dirty) return;

    // Buffer unchanged since the last persisted snapshot — nothing to write.
    // Checked before the throttle so an unchanged flush never consumes the
    // throttle window a later changed-content flush needs. Coverage means those
    // exact bytes are already on disk, which also satisfies any pending
    // debounced write.
    const epoch = this.host.contentEpoch;
    if (epoch === this.lastFlushedEpoch) {
      this.dirty = false;
      return;
    }

    const now = performance.now();
    if (
      trigger === "event" &&
      now - this.lastEventDrivenFlushAt < EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS
    ) {
      return;
    }

    if (this.inFlight) {
      // A capture is already running. Record the request rather than starting a
      // second serialize of the same buffer; the finally block hands it back to
      // this path once the current write lands. Periodic work needs no flag —
      // `dirty` is still set and finally re-arms the debounce for it.
      if (trigger === "event") this.pendingEventFlush = true;
      return;
    }

    this.inFlight = true;
    if (trigger === "event") this.lastEventDrivenFlushAt = now;
    try {
      if (trigger === "periodic") this.dirty = false;
      const state = await (this.host.hasBannerMarkers()
        ? this.host.serializeForPersistence()
        : this.host.getSerializedStateAsync());
      // Re-check lifecycle after the await — a kill or dispose during async
      // serialize would otherwise stomp the sync snapshot written from kill().
      if (this.disposed || this.host.wasKilled) return;
      if (!state) return;
      await persistSessionSnapshotAsync(this.host.id, state);
      // Mark coverage only after a successful persist. Uses the entry epoch, so
      // content that changed mid-serialize (epoch > entry) still triggers a
      // later flush. contentEpoch counts chunk RECEIPT, not parse completion,
      // so coverage means "the buffer as it serialized" — a chunk still queued
      // in HeadlessMirrorScheduler lands in the next capture. flushSyncOnKill
      // is the unconditional backstop on shutdown.
      //
      // `dirty` is deliberately NOT cleared here. Resize reflow and mirror
      // geometry repair bump contentEpoch without calling schedule(), so a
      // capture that cleared `dirty` would make the pending timer bail at its
      // `!dirty` guard before ever looking at the newer epoch — and take
      // flushSyncOnDispose's teardown write with it. The epoch check below is
      // what makes the pending debounce a no-op when it is genuinely covered.
      this.lastFlushedEpoch = epoch;
    } catch (error) {
      console.warn(
        trigger === "periodic"
          ? `[TerminalProcess] Failed to persist session for ${this.host.id}:`
          : `[TerminalProcess] Event-driven snapshot failed for ${this.host.id}:`,
        error
      );
    } finally {
      this.inFlight = false;
      if (!this.disposed) {
        if (this.pendingEventFlush) {
          this.pendingEventFlush = false;
          void this.captureAsync("event");
        }
        if (this.dirty) this.schedule();
      }
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
      if (state instanceof Promise) {
        // Worker-backed host: the buffer serializes off-thread, so a sync
        // flush is impossible. The serialize request is already in the
        // worker's queue ahead of the free message, so this best-effort async
        // persist still captures the pre-kill buffer.
        this.persistDeferred(state);
      } else if (state) {
        persistSessionSnapshotSync(this.host.id, state);
      }
    } catch {
      // best-effort only
    }
  }

  private persistDeferred(state: Promise<SerializedTerminalSnapshot | null>): void {
    void state
      .then((s) => {
        if (!s) return;
        if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
        if (isSessionPersistSuppressed()) return;
        return persistSessionSnapshotAsync(this.host.id, s);
      })
      .catch(() => {
        // best-effort only
      });
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
      const raw = this.host.serializeForPersistence();
      if (raw instanceof Promise) {
        this.persistDeferred(raw);
        this.dirty = false;
        return;
      }
      const state = raw ?? this.host.getSerializedState();
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
    this.pendingEventFlush = false;
  }
}
