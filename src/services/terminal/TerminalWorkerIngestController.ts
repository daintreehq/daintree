import type { ManagedTerminal } from "./types";
import { TerminalRefreshTier } from "@/types";
import { terminalClient } from "@/clients";
import { LiveWorkerIngest } from "./workerParse/LiveWorkerIngest";
import { createParseWorkerTransport } from "./workerParse/createParseWorkerTransport";
import { isPaintFabricWorkerIngestEnabled } from "./paintFabric/paintFabricConfig";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

// Poll interval while the worker-ingest engage barrier waits for the normal
// pipeline (ingest queue + pending xterm writes) to quiesce (#10960).
const WORKER_INGEST_DRAIN_POLL_MS = 10;

export interface TerminalWorkerIngestControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  getQueuedBytes: (id: string) => number;
  resumeFlush: (id: string) => void;
  incrementUnseen: (id: string, isScrolledBack: boolean) => void;
  fetchAndRestore: (id: string) => Promise<boolean>;
}

/**
 * Owns the live worker-parse ingest (issue #10960), gated by
 * DAINTREE_PAINT_FABRIC_WORKER_INGEST. One controller per terminal that has
 * ever gone BACKGROUND while the gate is on; disposed with the terminal.
 */
export class TerminalWorkerIngestController {
  private workerIngest = new Map<string, LiveWorkerIngest>();
  private unsubWorkerIngestEngaged: (() => void) | null = null;

  constructor(private deps: TerminalWorkerIngestControllerDeps) {}

  // Current diversion state for a terminal, if any — consumed by the onData
  // handler to route main-thread chunks into the worker session's mirror
  // instead of the normal write path while diversion is active.
  getIngest(id: string): LiveWorkerIngest | undefined {
    return this.workerIngest.get(id);
  }

  /**
   * Tier-driven worker-ingest policy (issue #10960): BACKGROUND demotes the
   * terminal's parse into a worker via its dedicated pty-host port; any other
   * tier (FOCUSED/BURST, and VISIBLE — a visible pane repainting at snapshot
   * cadence would be a UX regression) promotes back to the main-thread path
   * through the zero-loss release barrier. No-op unless
   * DAINTREE_PAINT_FABRIC_WORKER_INGEST=1.
   */
  applyWorkerIngestPolicy(id: string, tier: TerminalRefreshTier, managed: ManagedTerminal): void {
    if (!isPaintFabricWorkerIngestEnabled()) return;
    if (tier === TerminalRefreshTier.BACKGROUND) {
      let ingest = this.workerIngest.get(id);
      if (!ingest) {
        ingest = this.createWorkerIngest(id, managed);
        this.workerIngest.set(id, ingest);
      }
      ingest.setDesired(true);
    } else {
      this.workerIngest.get(id)?.setDesired(false);
    }
  }

  private createWorkerIngest(id: string, managed: ManagedTerminal): LiveWorkerIngest {
    if (!this.unsubWorkerIngestEngaged) {
      this.unsubWorkerIngestEngaged = terminalClient.onWorkerIngestEngaged((terminalId) => {
        this.workerIngest.get(terminalId)?.handleEngaged();
      });
    }

    const utf8ByteLength = (data: string): number => new TextEncoder().encode(data).byteLength;

    const ingest = new LiveWorkerIngest({
      id,
      requestPort: () => terminalClient.requestWorkerIngestPort(id),
      releasePort: () => terminalClient.releaseWorkerIngestPort(id),
      sendEngage: () => terminalClient.sendWorkerIngestEngage(id),
      sendRelease: (drainId) => terminalClient.sendWorkerIngestRelease(id, drainId),
      createTransport: () => createParseWorkerTransport(),
      mirror: {
        write: (data, callback) => {
          const current = this.deps.getInstance(id);
          if (!current) {
            callback?.();
            return;
          }
          // Direct write — snapshot applies and replays are pre-acked, so the
          // write controller's ack bookkeeping must never see them. Unseen
          // tracking still counts each repaint as output activity.
          this.deps.incrementUnseen(id, current.isUserScrolledBack);
          current.terminal.write(data, callback);
        },
      },
      serializeMirror: () => {
        const current = this.deps.getInstance(id);
        return current?.serializeAddon.serialize() ?? "";
      },
      getGeometry: () => {
        const current = this.deps.getInstance(id);
        return {
          cols: current?.terminal.cols ?? 80,
          rows: current?.terminal.rows ?? 24,
          scrollback: current?.terminal.options.scrollback ?? 1000,
        };
      },
      ackDiverted: (data) => {
        // Delivery source is encoded in the chunk type (the same invariant
        // TerminalWriteController's ackBytes rule rests on): port chunks are
        // always Uint8Array, IPC chunks always strings. Settle exactly one
        // port-ack FIFO entry per port chunk; never let an IPC chunk shift a
        // port entry — that would prematurely ack a port chunk still queued.
        if (typeof data === "string") {
          terminalClient.acknowledgeData(id, utf8ByteLength(data));
        } else {
          terminalClient.acknowledgePortData(id, data.byteLength, 1);
        }
      },
      drainPendingWrites: async () => {
        // Quiesce the normal pipeline before the engage serialize: queued
        // ingest chunks, in-flight xterm writes, and serialized-restore
        // deferrals all still land on the mirror through the write controller
        // — the serialize must happen after them or they vanish at the next
        // snapshot apply. Diversion is already on, so no new inflow.
        const deadline = Date.now() + 5000;
        for (;;) {
          const current = this.deps.getInstance(id);
          if (!current) return false;
          if (
            this.deps.getQueuedBytes(id) === 0 &&
            (current.pendingWrites ?? 0) === 0 &&
            !current.isSerializedRestoreInProgress
          ) {
            return true;
          }
          if (Date.now() > deadline) return false;
          this.deps.resumeFlush(id);
          await new Promise((resolve) => setTimeout(resolve, WORKER_INGEST_DRAIN_POLL_MS));
        }
      },
      requestHostRestore: () => {
        safeFireAndForget(this.deps.fetchAndRestore(id), {
          context: "worker-ingest fallback restore",
        });
      },
      onDidFallback: (reason) => {
        logWarn("Worker ingest fell back to main-thread parse", { id, reason });
      },
    });

    this.bindTerminalResize(managed, ingest);

    return ingest;
  }

  /**
   * Geometry follows the mirror in every mode so demotion re-seeds at the right
   * size (the session forwards resizes only while in worker mode).
   *
   * Extracted so the #11776 rebuild can re-establish it: this is an
   * xterm-bound listener, so a terminal swap disposes it along with the rest of
   * the tail, but it is owned here rather than by
   * `installTerminalBoundListeners` — nothing in the shared installer would put
   * it back.
   */
  private bindTerminalResize(managed: ManagedTerminal, ingest: LiveWorkerIngest): void {
    const resizeDisposable = managed.terminal.onResize(({ cols, rows }) =>
      ingest.resize(cols, rows)
    );
    managed.listeners.push(() => resizeDisposable.dispose());
  }

  /**
   * Re-attach this controller's terminal-bound listener after the xterm
   * instance behind `id` was replaced (#11776). No-op when the terminal never
   * had a worker ingest.
   *
   * Binding only. The geometry re-seed is a separate call because the
   * replacement terminal is still on its construction grid at this point —
   * seeding here would park the headless mirror at xterm's 80x24 default and
   * every subsequent snapshot would come back at that width. See
   * {@link reseedMirrorGeometry}.
   */
  rebindTerminal(id: string, managed: ManagedTerminal): void {
    const ingest = this.workerIngest.get(id);
    if (!ingest) return;
    this.bindTerminalResize(managed, ingest);
  }

  /**
   * Point the mirror at the replacement terminal's real grid (#11776). Called
   * once the rebuilt terminal has actually opened and been sized, since only
   * then does `terminal.cols/rows` describe the grid the pane is on — the
   * `onResize` listener {@link rebindTerminal} installed reports later changes,
   * but never the one the open itself applied.
   */
  reseedMirrorGeometry(id: string, managed: ManagedTerminal): void {
    const ingest = this.workerIngest.get(id);
    if (!ingest) return;
    ingest.resize(managed.terminal.cols, managed.terminal.rows);
  }

  // Worker ingest dies with the terminal: dispose terminates the Worker and
  // closes the dedicated port on every teardown path (kill/trash/project
  // close/LRU eviction) — a leaked producer port queues unboundedly (#6283).
  // Called from `TerminalInstanceService.destroy()`.
  destroy(id: string): void {
    const ingest = this.workerIngest.get(id);
    if (ingest) {
      ingest.dispose();
      this.workerIngest.delete(id);
    }
  }

  dispose(): void {
    this.unsubWorkerIngestEngaged?.();
    this.unsubWorkerIngestEngaged = null;
  }
}
