import { logWarn } from "@/utils/logger";
import type { AuthoritySnapshot } from "./parseAuthority";
import { applySnapshotToMirror, type MirrorTarget } from "./mirrorApply";
import type { AuthorityResponse, AuthorityTransport } from "./parseTransport";

export interface WorkerParseSessionOptions {
  cols: number;
  rows: number;
  scrollback: number;
  // How often a dirty authority repaints the mirror. The mirror of a flooding
  // background terminal needs to look current, not be byte-current.
  cadenceMs?: number;
  // Scrollback lines carried per cadence snapshot — bounds the main-thread
  // apply cost per tick. Sync points (promote) always take a full snapshot.
  boundedScrollbackLines?: number;
}

export const DEFAULT_CADENCE_MS = 250;
export const DEFAULT_BOUNDED_SCROLLBACK_LINES = 200;

type SessionMode = "worker" | "passthrough";

// The main-thread half of Phase 4 worker parse for ONE terminal. In "worker"
// mode, pty bytes go to the off-thread parse authority and the mirror
// terminal repaints from bounded snapshots at a fixed cadence. Promotion to
// "passthrough" (focus/reveal — interactive latency matters again) takes one
// full-fidelity snapshot, replays any bytes that arrived mid-promotion, then
// feeds the mirror directly. Demotion re-seeds the authority from the
// mirror's serialized state. Zero-loss invariant: every fed byte lands on
// the mirror exactly once — inside a snapshot or replayed after it, never
// both, never dropped.
export class WorkerParseSession {
  private mode: SessionMode = "worker";
  private promoting = false;
  private disposed = false;
  private nextRequestId = 1;
  private pendingSnapshots = new Map<number, (snapshot: AuthoritySnapshot | null) => void>();
  private pendingInteractive: string[] = [];
  private cadenceTimer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;
  private unsubscribe: () => void;
  private readonly cadenceMs: number;
  private readonly boundedScrollbackLines: number;
  private cols: number;
  private rows: number;

  constructor(
    private transport: AuthorityTransport,
    private mirror: MirrorTarget,
    options: WorkerParseSessionOptions
  ) {
    this.cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;
    this.boundedScrollbackLines =
      options.boundedScrollbackLines ?? DEFAULT_BOUNDED_SCROLLBACK_LINES;
    this.cols = options.cols;
    this.rows = options.rows;
    this.unsubscribe = transport.onResponse(this.onResponse);
    transport.send({
      type: "init",
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
    });
    this.startCadence();
  }

  currentMode(): SessionMode {
    return this.mode;
  }

  feed(data: string): void {
    if (this.disposed) return;
    if (this.mode === "passthrough") {
      this.mirror.write(data);
      return;
    }
    if (this.promoting) {
      // The full-fidelity snapshot is already in flight; these bytes are not
      // in it, so they replay onto the mirror right after it applies.
      this.pendingInteractive.push(data);
      return;
    }
    this.transport.send({ type: "write", data });
  }

  // Geometry is tracked in every mode: a passthrough-era resize must reach
  // the authority before demotion re-seeds it, or snapshots reflow at stale
  // cols/rows.
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.cols = cols;
    this.rows = rows;
    if (this.mode !== "worker") return;
    this.transport.send({ type: "resize", cols, rows });
  }

  // Run one cadence step immediately — deterministic tests drive this
  // instead of waiting on the interval.
  async tickNow(): Promise<void> {
    await this.tick();
  }

  /**
   * Switch to interactive passthrough at a sync point: one full snapshot
   * restores complete fidelity (the cadence mirror is bounded), buffered
   * mid-promotion bytes replay behind it (mirror writes are FIFO), and
   * subsequent bytes feed the mirror directly.
   */
  async promoteToInteractive(): Promise<void> {
    if (this.disposed || this.mode === "passthrough" || this.promoting) return;
    this.promoting = true;
    try {
      const snapshot = await this.requestSnapshot(undefined);
      if (snapshot) {
        applySnapshotToMirror(this.mirror, snapshot.serialized);
      }
      const buffered = this.pendingInteractive;
      this.pendingInteractive = [];
      for (const chunk of buffered) this.mirror.write(chunk);
      this.mode = "passthrough";
    } finally {
      this.promoting = false;
    }
    this.stopCadence();
  }

  /**
   * Return to worker parse (the terminal went background again). The
   * authority missed every passthrough byte, so it re-seeds from the
   * mirror's serialized state — the caller owns the mirror's serialize addon.
   */
  demoteToWorker(serializedMirrorState: string): void {
    if (this.disposed || this.mode === "worker") return;
    // Geometry first: the restore must parse at the mirror's current size.
    this.transport.send({ type: "resize", cols: this.cols, rows: this.rows });
    this.transport.send({ type: "restore", serialized: serializedMirrorState });
    this.mode = "worker";
    this.startCadence();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCadence();
    this.unsubscribe();
    // Resolve any in-flight waits so a promote caller never hangs.
    for (const resolve of this.pendingSnapshots.values()) resolve(null);
    this.pendingSnapshots.clear();
    this.transport.dispose();
  }

  private onResponse = (response: AuthorityResponse): void => {
    if (response.type === "snapshot") {
      const resolve = this.pendingSnapshots.get(response.requestId);
      this.pendingSnapshots.delete(response.requestId);
      resolve?.(response.snapshot);
      return;
    }
    logWarn("Worker parse authority error", { message: response.message });
    // A snapshot-specific failure settles its wait (as no-snapshot) so a
    // promotion cannot hang until dispose.
    if (response.requestId !== undefined) {
      const resolve = this.pendingSnapshots.get(response.requestId);
      this.pendingSnapshots.delete(response.requestId);
      resolve?.(null);
    }
  };

  private requestSnapshot(
    boundedScrollbackLines: number | undefined
  ): Promise<AuthoritySnapshot | null> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve) => {
      this.pendingSnapshots.set(requestId, resolve);
      this.transport.send({ type: "snapshot", requestId, boundedScrollbackLines });
    });
  }

  private tick = async (): Promise<void> => {
    if (this.disposed || this.mode !== "worker" || this.promoting || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const snapshot = await this.requestSnapshot(this.boundedScrollbackLines);
      // A promotion may have raced this tick; its full snapshot supersedes.
      if (snapshot && !this.disposed && this.mode === "worker" && !this.promoting) {
        applySnapshotToMirror(this.mirror, snapshot.serialized);
      }
    } finally {
      this.tickInFlight = false;
    }
  };

  private startCadence(): void {
    if (this.cadenceMs <= 0 || this.cadenceTimer !== undefined) return;
    this.cadenceTimer = setInterval(() => void this.tick(), this.cadenceMs);
  }

  private stopCadence(): void {
    if (this.cadenceTimer === undefined) return;
    clearInterval(this.cadenceTimer);
    this.cadenceTimer = undefined;
  }
}
