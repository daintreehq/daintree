import { logWarn } from "@/utils/logger";
import type { MirrorTarget } from "./mirrorApply";
import type { AuthorityResponse, AuthorityTransport } from "./parseTransport";
import { WorkerParseSession } from "./WorkerParseSession";

export interface LiveWorkerIngestDeps {
  id: string;
  /** Mint the dedicated pty-host port (terminalClient.requestWorkerIngestPort). */
  requestPort(): Promise<MessagePort | null>;
  /** Tell Main to close the dedicated pair. */
  releasePort(): void;
  /** Post worker-ingest-engage on the window port. False = port gone. */
  sendEngage(): boolean;
  /** Post worker-ingest-release (with drainId) on the window port. */
  sendRelease(drainId: number): boolean;
  /** Real Worker transport (must support attachIngestPort). */
  createTransport(): AuthorityTransport;
  /** The live xterm instance, written directly — never via TerminalWriteController. */
  mirror: MirrorTarget;
  serializeMirror(): string;
  getGeometry(): { cols: number; rows: number; scrollback: number };
  /**
   * Quiesce the NORMAL ingest pipeline (TerminalOutputIngestService queue +
   * TerminalWriteController pending writes + any serialized-restore deferral)
   * before the engage serialize. Chunks still queued upstream of the mirror
   * would otherwise land on it after the authority seeds — and vanish at the
   * next snapshot apply. Diversion is already on when this runs, so the queue
   * only shrinks. Resolves false if it cannot quiesce (engage falls back).
   */
  drainPendingWrites(): Promise<boolean>;
  /**
   * Settle a diverted chunk's ledgers immediately (one port-ack FIFO entry +
   * the IPC ledger for string chunks). Diverted chunks land on the mirror via
   * session buffering/replay, so TerminalWriteController's ack sites never see
   * them — same immediate-ack precedent as terminalClient's early buffer.
   */
  ackDiverted(data: string | Uint8Array): void;
  /**
   * Re-sync the mirror from the host's canonical serialized state after a
   * worker crash — bytes parsed only by the dead worker never reached the
   * mirror and are unrecoverable renderer-side.
   */
  requestHostRestore(): void;
  onDidFallback?(reason: string): void;
  /** Engage/release barrier timeout (default 5s). */
  barrierTimeoutMs?: number;
  /** Mirror repaint cadence override (deterministic tests pass 0). */
  cadenceMs?: number;
}

const DEFAULT_BARRIER_TIMEOUT_MS = 5000;

/**
 * The live wiring of Phase 4 worker parse for ONE terminal (issue #10960).
 * Owns the dedicated pty-host port, the parse Worker, and the WorkerParseSession
 * mode machine, and converges the actual ingest mode to the tier-driven desired
 * mode through two zero-loss barriers:
 *
 * Engage (BACKGROUND): seed the authority from the mirror, divert the
 * main-thread data path into the session, ask the host to flip routing, and
 * only activate direct port consumption in the worker once the host's
 * engaged marker confirms every window-routed byte has been relayed ahead.
 *
 * Release (FOCUSED/BURST/VISIBLE): ask the host to flip routing back, buffer
 * window-path bytes controller-side until the worker confirms the dedicated
 * port drained (`port-drained`), take the full-fidelity promotion snapshot
 * (FIFO behind every port byte), replay the buffer, un-divert.
 *
 * Transitions run on a serialized chain with desired-state reconciliation, so
 * rapid tier flaps cannot interleave two barriers (#8371). Worker crash, port
 * closure, or a barrier timeout latches fallback: routing returns to the
 * main-thread path and the mirror re-syncs from the host snapshot.
 */
export class LiveWorkerIngest {
  private session: WorkerParseSession | null = null;
  private transport: AuthorityTransport | null = null;
  private unsubTransport: (() => void) | null = null;
  private wantWorker = false;
  private workerActive = false;
  private diverting = false;
  private engaging = false;
  private releasing = false;
  private releasingBuffer: Array<string | Uint8Array> = [];
  private fallbackLatched = false;
  private disposedFlag = false;
  private nextDrainId = 1;
  private engagedWaiter: ((engaged: boolean) => void) | null = null;
  private drainWaiters = new Map<number, (drained: boolean) => void>();
  private chain: Promise<void> = Promise.resolve();
  private readonly barrierTimeoutMs: number;

  constructor(private deps: LiveWorkerIngestDeps) {
    this.barrierTimeoutMs = deps.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  }

  /** Tier-driven desired mode: true = worker ingest, false = main-thread. */
  setDesired(workerMode: boolean): void {
    if (this.disposedFlag || this.fallbackLatched) return;
    this.wantWorker = workerMode;
    this.chain = this.chain
      .then(async () => {
        while (!this.disposedFlag && !this.fallbackLatched && this.wantWorker !== this.workerActive) {
          if (this.wantWorker) {
            await this.engageOnce();
          } else {
            await this.releaseOnce();
          }
        }
      })
      .catch((error) => {
        logWarn("Live worker ingest transition failed", { id: this.deps.id, error });
      });
  }

  /** True while the main-thread data path must route into feedDiverted. */
  shouldDivert(): boolean {
    return this.diverting && !this.disposedFlag;
  }

  /**
   * A chunk from the window port / IPC fallback while diverted. Acked
   * immediately (it never reaches TerminalWriteController); during a release
   * barrier it buffers controller-side and replays after the promotion
   * snapshot — the snapshot already contains every dedicated-port byte, and
   * these chunks are strictly newer.
   */
  feedDiverted(data: string | Uint8Array): void {
    if (this.disposedFlag) return;
    this.deps.ackDiverted(data);
    if (this.releasing || this.engaging || !this.session) {
      this.releasingBuffer.push(data);
      return;
    }
    this.session.feed(data);
  }

  resize(cols: number, rows: number): void {
    this.session?.resize(cols, rows);
  }

  /** Router entry for the host's worker-ingest-engaged marker. */
  handleEngaged(): void {
    this.engagedWaiter?.(true);
  }

  hasFallenBack(): boolean {
    return this.fallbackLatched;
  }

  /** True once the host routes this terminal's bytes to the dedicated port. */
  isWorkerActive(): boolean {
    return this.workerActive;
  }

  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    // Best-effort: return routing to the window port before the port-close
    // event lands host-side. Harmless if the host already tore down.
    if (this.workerActive) {
      this.deps.sendRelease(this.nextDrainId++);
    }
    this.engagedWaiter?.(false);
    for (const settle of this.drainWaiters.values()) settle(false);
    this.drainWaiters.clear();
    this.teardownSession();
    this.deps.releasePort();
    this.releasingBuffer = [];
    this.diverting = false;
    this.workerActive = false;
  }

  private async engageOnce(): Promise<void> {
    if (this.disposedFlag || this.fallbackLatched) return;
    // Divert-and-buffer BEFORE any await: from here on, no new byte can enter
    // the mirror's write queue behind our back. Then drain what is already
    // queued — the serialize below must capture bytes the mirror accepted but
    // has not parsed yet, or they exist only in the mirror and the next
    // promotion's snapshot apply (a reset + rewrite) would erase them.
    this.diverting = true;
    this.engaging = true;
    try {
      if (!this.session) {
        const transport = this.deps.createTransport();
        if (!transport.attachIngestPort) {
          transport.dispose();
          await this.fallbackNow("transport lacks ingest port support");
          return;
        }
        const port = await this.deps.requestPort();
        if (this.disposedFlag) {
          try {
            port?.close();
          } catch {
            // already closed
          }
          transport.dispose();
          return;
        }
        if (!port) {
          transport.dispose();
          await this.fallbackNow("no dedicated port");
          return;
        }
        const quiesced = await this.deps.drainPendingWrites();
        if (!quiesced && !this.disposedFlag) {
          try {
            port.close();
          } catch {
            // already closed
          }
          transport.dispose();
          await this.fallbackNow("pre-engage ingest drain timeout");
          return;
        }
        await this.drainMirror();
        if (this.disposedFlag) {
          try {
            port.close();
          } catch {
            // already closed
          }
          transport.dispose();
          return;
        }
        // Synchronous block: serialize and construct — nothing can interleave
        // between the (now complete) serialize and the restore being queued.
        const geometry = this.deps.getGeometry();
        const session = new WorkerParseSession(transport, this.deps.mirror, {
          cols: geometry.cols,
          rows: geometry.rows,
          scrollback: geometry.scrollback,
          cadenceMs: this.deps.cadenceMs,
          initialSerializedState: this.deps.serializeMirror(),
        });
        this.unsubTransport = transport.onResponse(this.onTransportResponse);
        transport.attachIngestPort(port);
        this.transport = transport;
        this.session = session;
      } else {
        // Re-engage: same quiesce-then-drain-then-serialize discipline before
        // the authority re-seeds from the mirror.
        const quiesced = await this.deps.drainPendingWrites();
        if (this.disposedFlag) return;
        if (!quiesced) {
          await this.fallbackNow("pre-engage ingest drain timeout");
          return;
        }
        await this.drainMirror();
        if (this.disposedFlag) return;
        this.session.demoteToWorker(this.deps.serializeMirror());
      }
    } finally {
      this.engaging = false;
    }
    // Bytes diverted during the awaits above were buffered (pre-acked); they
    // ride the control FIFO behind the restore, ahead of activate.
    this.flushReleasingBuffer();

    const engaged = await this.waitForEngaged();
    if (this.disposedFlag) return;
    if (!engaged) {
      await this.fallbackNow("engage barrier timeout");
      return;
    }
    // Barrier complete: every pre-flip byte was relayed through the control
    // FIFO ahead of this activate — the worker may now consume held port
    // chunks and go live.
    this.transport?.send({ type: "activate-port-ingest" });
    this.workerActive = true;
  }

  private async releaseOnce(): Promise<void> {
    if (this.disposedFlag || this.fallbackLatched) return;
    if (!this.session || !this.workerActive) {
      this.flushReleasingBuffer();
      this.diverting = false;
      this.workerActive = false;
      return;
    }
    this.workerActive = false;
    this.releasing = true;
    try {
      const drainId = this.nextDrainId++;
      const drained = this.deps.sendRelease(drainId) ? await this.waitForDrain(drainId) : false;
      if (this.disposedFlag) return;
      if (!drained) {
        await this.fallbackNow("release barrier timeout");
        return;
      }
      // Every dedicated-port byte is queued in the worker ahead of this full
      // snapshot; buffered window-path bytes are strictly newer and replay
      // behind the apply.
      await this.session.promoteToInteractive();
      if (this.disposedFlag) return;
    } finally {
      this.releasing = false;
    }
    this.flushReleasingBuffer();
    this.diverting = false;
  }

  // Resolves once every write already queued on the mirror has parsed —
  // xterm's write buffer is FIFO, so a zero-length write's callback is the
  // "everything before me landed" signal (same trick as ParseAuthority.drain).
  private drainMirror(): Promise<void> {
    return new Promise((resolve) => this.deps.mirror.write("", resolve));
  }

  private flushReleasingBuffer(): void {
    if (this.releasingBuffer.length === 0) return;
    const buffered = this.releasingBuffer;
    this.releasingBuffer = [];
    if (this.session && !this.releasing) {
      for (const chunk of buffered) this.session.feed(chunk);
    } else {
      for (const chunk of buffered) this.deps.mirror.write(chunk);
    }
  }

  private waitForEngaged(): Promise<boolean> {
    if (!this.deps.sendEngage()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.engagedWaiter = null;
        resolve(false);
      }, this.barrierTimeoutMs);
      this.engagedWaiter = (engaged) => {
        clearTimeout(timeout);
        this.engagedWaiter = null;
        resolve(engaged);
      };
    });
  }

  private waitForDrain(drainId: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(drainId);
        resolve(false);
      }, this.barrierTimeoutMs);
      this.drainWaiters.set(drainId, (drained) => {
        clearTimeout(timeout);
        this.drainWaiters.delete(drainId);
        resolve(drained);
      });
    });
  }

  private onTransportResponse = (response: AuthorityResponse): void => {
    if (response.type === "port-drained") {
      this.drainWaiters.get(response.drainId)?.(true);
      return;
    }
    if (response.type === "ingest-port-closed") {
      // Host teardown (project switch, window port replacement) — not a
      // crash, but the byte path is gone either way.
      this.enqueueFallback("ingest port closed");
      return;
    }
    if (response.type === "error" && response.requestId === undefined) {
      // Whole-worker crash (same signal WorkerParseSession uses to settle
      // pending snapshots).
      this.enqueueFallback(`worker error: ${response.message}`);
    }
  };

  private enqueueFallback(reason: string): void {
    if (this.disposedFlag || this.fallbackLatched) return;
    // Ride the transition chain so a fallback never interleaves a barrier
    // that is mid-flight; barrier waits are timeout-bounded.
    this.chain = this.chain
      .then(() => this.fallbackNow(reason))
      .catch((error) => {
        logWarn("Live worker ingest fallback failed", { id: this.deps.id, error });
      });
  }

  private async fallbackNow(reason: string): Promise<void> {
    if (this.disposedFlag || this.fallbackLatched) return;
    this.fallbackLatched = true;
    this.wantWorker = false;
    logWarn("Live worker ingest falling back to main-thread parse", {
      id: this.deps.id,
      reason,
    });
    // Best-effort routing flip; the host's port-close handler is the backstop.
    this.deps.sendRelease(this.nextDrainId++);
    this.teardownSession();
    this.deps.releasePort();
    // Whatever was buffered mid-transition still lands on the mirror (already
    // acked), then the host snapshot re-syncs canonical state over it.
    const buffered = this.releasingBuffer;
    this.releasingBuffer = [];
    for (const chunk of buffered) this.deps.mirror.write(chunk);
    this.releasing = false;
    this.engaging = false;
    this.diverting = false;
    this.workerActive = false;
    this.deps.requestHostRestore();
    this.deps.onDidFallback?.(reason);
  }

  private teardownSession(): void {
    this.unsubTransport?.();
    this.unsubTransport = null;
    // Session dispose settles in-flight snapshot waits and disposes the
    // transport, which terminates the Worker — the transferred port dies with
    // it and the host cleans up on its close event.
    this.session?.dispose();
    this.session = null;
    this.transport = null;
  }
}
