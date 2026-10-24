import { selectShard } from "../../shared/utils/shardSelection.js";
import type { PacketFramer, SharedRingBuffer } from "../../shared/utils/SharedRingBuffer.js";
import type {
  PtyHostEvent,
  TerminalReliabilityMetricPayload,
} from "../../shared/types/pty-host.js";
import { isSmokeTestTerminalId } from "../../shared/utils/smokeTestTerminals.js";
import type { PtyManager } from "../services/PtyManager.js";
import {
  PORT_BATCH_INTERACTIVE_INPUT_WINDOW_MS,
  PORT_BATCH_RECENT_INPUT_WINDOW_MS,
} from "../services/pty/types.js";
import { markPerformance } from "../utils/performance.js";
import {
  BACKPRESSURE_SAFETY_TIMEOUT_MS,
  MAX_PACKET_PAYLOAD,
  type BackpressureManager,
} from "./backpressure.js";
import type { IpcQueueManager } from "./ipcQueue.js";
import type { PtyPauseCoordinator } from "./PtyPauseCoordinator.js";
import type { RendererConnection, TerminalWorkerConnection } from "./handlers/types.js";

/**
 * Everything the visual-output fanout reads, owned by the pty-host entry. The
 * maps and sets are the host's live instances (the message handlers mutate
 * them); the SAB buffers are reassigned by `init-buffers`, so they are read
 * through getters at the moment of use.
 */
export interface VisualOutputRouterDeps {
  getTerminal: PtyManager["getTerminal"];
  backpressureManager: BackpressureManager;
  ipcQueueManager: IpcQueueManager;
  rendererConnections: ReadonlyMap<number, RendererConnection>;
  terminalWorkerConnections: ReadonlyMap<number, ReadonlyMap<string, TerminalWorkerConnection>>;
  windowProjectMap: ReadonlyMap<number, string | null>;
  fallbackEligibleProjects: ReadonlySet<string>;
  ipcDataMirrorTerminals: ReadonlySet<string>;
  packetFramer: PacketFramer;
  getVisualBuffers: () => SharedRingBuffer[];
  getVisualSignalView: () => Int32Array | null;
  getAnalysisBuffer: () => SharedRingBuffer | null;
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  getOrCreatePauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  /** Counts dropped bytes toward the data-loss gauge and the per-terminal tally. */
  recordDrop: (terminalId: string, droppedBytes: number) => void;
  emitReliabilityMetric: (
    payload: TerminalReliabilityMetricPayload,
    source: "sab" | null,
    forceEmit?: boolean
  ) => void;
  sendEvent: (event: PtyHostEvent) => void;
  metricsEnabled: () => boolean;
}

export interface VisualOutputRouter {
  routeOutput(id: string, data: string | Uint8Array, streamEnd: number | undefined): void;
  tryReplayAndResume(id: string): void;
  resumePausedTerminal(id: string): void;
  /** Swaps out the per-terminal throughput tally accumulated since the last call. */
  takeThroughputAccumulator(): Map<string, { totalBytes: number; packetCount: number }>;
}

export function createVisualOutputRouter(deps: VisualOutputRouterDeps): VisualOutputRouter {
  const {
    getTerminal,
    backpressureManager,
    ipcQueueManager,
    rendererConnections,
    terminalWorkerConnections,
    windowProjectMap,
    fallbackEligibleProjects,
    ipcDataMirrorTerminals,
    packetFramer,
    getVisualBuffers,
    getVisualSignalView,
    getAnalysisBuffer,
    getPauseCoordinator,
    getOrCreatePauseCoordinator,
    recordDrop,
    emitReliabilityMetric: emitReliabilityMetricWithTracking,
    sendEvent,
    metricsEnabled,
  } = deps;

  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  // Throughput-rate gauge: accumulates per-terminal raw PTY byte/packet counts
  // between ResourceGovernor ticks. Double-buffer swap at tick boundary avoids
  // iterator invalidation during Map iteration.
  let throughputAccumulator = new Map<string, { totalBytes: number; packetCount: number }>();

  // Helper to convert data to string for IPC fallback (IPC events expect string)
  function toStringForIpc(data: string | Uint8Array): string {
    return typeof data === "string" ? data : textDecoder.decode(data);
  }

  function routeOutput(id: string, data: string | Uint8Array, streamEnd: number | undefined): void {
    // Throughput-rate gauge accumulation — raw PTY byte/packet counts before
    // any path routing, suspension gating, or chunk wrapping. Gated so the hot
    // path is untouched when metrics are disabled (the default).
    if (metricsEnabled()) {
      const rawByteCount =
        typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
      let acc = throughputAccumulator.get(id);
      if (!acc) {
        acc = { totalBytes: 0, packetCount: 0 };
        throughputAccumulator.set(id, acc);
      }
      acc.totalBytes += rawByteCount;
      acc.packetCount += 1;
    }

    // Terminal output always updates headless state; visual streaming can be suspended under backpressure.
    const isSuspended = backpressureManager.isSuspended(id);
    const terminalInfo = getTerminal(id);

    // Every chunk mutates the headless buffer regardless of routing — bump the
    // epoch unconditionally so a suppressed/suspended/dropped chunk invalidates
    // the wake no-change skip for every window.
    if (terminalInfo) {
      terminalInfo.contentEpoch++;
    }

    // EXPERIMENT (hibernation teardown step 1 — #10807): visual streaming is
    // unconditional with respect to the background tier. recomputeActivityTiers no
    // longer demotes terminals to "background", and as belt-and-suspenders we hard-
    // pin this gate off so a stray "background" tier from any other path can never
    // suppress the live visual byte stream. The isSuspended (backpressure) gate and
    // the project-routing filter below are unchanged; analysis/headless buffer
    // writes and agent-state detection still run. Landed in `eb9cd64a7`.
    const isBackgrounded = false;
    // PRIORITY 1: MESSAGEPORT (Per-Window Routed Path)
    // Send data directly to renderer windows via MessagePort with per-window project filtering.
    // MessagePort is primary because SharedArrayBuffer ring buffers use a single shared read pointer
    // (single-consumer design). With per-project WebContentsViews, multiple SAB workers race on the
    // same read pointer, causing data meant for one view to be consumed by another view's worker
    // and silently dropped. MessagePort avoids this by routing data to the correct project view.
    // Skip MessagePort for smoke test terminals — the smoke test monitors data via PtyClient
    // (IPC events in the main process), so these must always use the IPC fallback path.
    let visualWritten = isSuspended;
    // A view of this terminal's project that holds no port is reachable only over
    // the IPC fallback, so the fallback must run even when a sibling window's
    // port accepted the chunk. Main filters the delivered windows back out.
    const termProjectId = terminalInfo?.projectId ?? null;
    const needsEligibleFallback =
      termProjectId !== null && fallbackEligibleProjects.has(termProjectId);
    const portDeliveredWebContentsIds: number[] = [];

    if (
      !isSuspended &&
      !isBackgrounded &&
      rendererConnections.size > 0 &&
      !isSmokeTestTerminalId(id)
    ) {
      const targets: Array<{ windowId: number; conn: RendererConnection }> = [];
      for (const [windowId, conn] of rendererConnections) {
        const windowProject = windowProjectMap.get(windowId) ?? null;
        const filtered = windowProject !== null && termProjectId !== windowProject;
        if (filtered) continue;
        targets.push({ windowId, conn });
      }

      // Encode only when a target window remains after project filtering — a
      // fully-filtered chunk falls through to the IPC fallback's original string.
      if (targets.length > 0) {
        // Carry raw bytes on the hot MessagePort path so the renderer receives a
        // transferred ArrayBuffer instead of a structured-cloned UTF-8 string.
        // TextEncoder encodes strings into a standalone, exactly-sized buffer in
        // one pass; the `new Uint8Array(...)` wrap on the bytes branch escapes
        // node-pty's Buffer pool slab — each batcher will copy these chunks into
        // a fresh isolated buffer at flush time before they land in the
        // postMessage transfer list.
        const chunk = typeof data === "string" ? textEncoder.encode(data) : new Uint8Array(data);
        const byteCount = chunk.byteLength;

        // The chunk's ArrayBuffer can only be transferred zero-copy when exactly one
        // batcher receives it: a transfer detaches the buffer, and per-batcher flush
        // timing is independent, so with 2+ targets any flush would neuter the chunk
        // out from under siblings still waiting to copy it. Sole target → owned.
        const owned = targets.length === 1;
        // Output landing within the input window is likely keystroke echo — let
        // the batcher accelerate a pending throughput flush so typing into a
        // flooding terminal isn't held a frame behind the flood.
        const sinceInputMs =
          terminalInfo !== undefined ? Date.now() - terminalInfo.lastInputTime : Infinity;
        const interactive = sinceInputMs < PORT_BATCH_INTERACTIVE_INPUT_WINDOW_MS;
        // A wheel over a mouse-reporting TUI is PTY input too, so its redraws
        // ride this per-terminal tail instead of a global profile lift (#12518).
        const recentInput = sinceInputMs < PORT_BATCH_RECENT_INPUT_WINDOW_MS;
        if (interactive) {
          // PERF-120 T3 attribution mark (no-op unless DAINTREE_PERF_CAPTURE):
          // echo output for a just-typed terminal is leaving the host. Paired
          // with terminal_port_input_written for the host-internal slice.
          markPerformance("terminal_interactive_echo_dispatched", {
            terminalId: id,
            bytes: byteCount,
          });
        }
        const saturated: RendererConnection[] = [];
        for (const { windowId, conn } of targets) {
          // An engaged worker-ingest terminal routes to its dedicated port —
          // bytes land in the renderer's parse worker without touching its main
          // thread. Exactly one sink per (window, terminal): the window port is
          // never written for an engaged terminal, so nothing double-delivers.
          const workerConn = terminalWorkerConnections.get(windowId)?.get(id);
          const sink = workerConn?.engaged ? workerConn : conn;
          const accepted =
            streamEnd === undefined
              ? sink.batcher.write(id, chunk, byteCount, owned, interactive, recentInput)
              : sink.batcher.write(
                  id,
                  chunk,
                  byteCount,
                  owned,
                  interactive,
                  recentInput,
                  streamEnd
                );
          if (accepted) {
            visualWritten = true;
            // Identified by the view Main brokered the port to, not by window:
            // the window's holder can change between here and Main routing the
            // fallback, and only the identity survives that (#12557).
            if (conn.holderWebContentsId !== undefined) {
              portDeliveredWebContentsIds.push(conn.holderWebContentsId);
            }
          } else {
            // The data-loss pulse rides the WINDOW port either way — the
            // renderer's terminal-status subscribers only listen there.
            saturated.push(conn);
          }
        }

        // A window whose batcher rejected this chunk only truly loses it when a
        // SIBLING window's batcher accepted it — i.e. `visualWritten` is now true,
        // which suppresses the shared SAB/IPC fallback below. If NO window accepted,
        // `visualWritten` stays false and the IPC fallback broadcasts the chunk to
        // every window (the renderer's onData subscribes to both the MessagePort and
        // the IPC path), so nothing is actually lost — no pulse needed there.
        //
        // For the genuinely-starved windows we can't lean on the IPC fallback:
        // `sendEvent` broadcasts to every window and would falsely flag the ones
        // that received the data on their own port (issue #9891). So account the
        // loss and deliver a `data-loss` pulse on each starved window's own port,
        // FIFO-ordered with its data, letting the next wake snapshot resync it.
        //
        // Mirrored terminals are no exception: the IPC data mirror below is
        // Main-process-only (`data-mirror` is never re-broadcast to renderers),
        // so a starved window really does lose the chunk and needs the pulse.
        //
        // `needsEligibleFallback` exempts the whole loop: the fallback below is
        // about to run for the port-less view's sake, and it is project-scoped
        // rather than port-scoped, so a saturated window's view receives the
        // chunk on the IPC path after all. Pulsing data-loss there would paint a
        // yellow discontinuity marker over bytes that did arrive.
        if (visualWritten && !needsEligibleFallback && saturated.length > 0) {
          for (const conn of saturated) {
            // Counter is unconditional — regression detection must work even when
            // metrics are gated off (mirrors the IPC at-capacity path).
            recordDrop(id, byteCount);
            try {
              conn.port.postMessage({
                type: "terminal-status",
                id,
                status: "data-loss",
                droppedBytes: byteCount,
                timestamp: Date.now(),
              });
            } catch {
              // Port closing between iteration and post — disconnect handles cleanup.
            }
          }
        }
      }
      // If at capacity on all ports, fall through to SAB or IPC fallback
    }

    // PRIORITY 2: SHARED ARRAY BUFFER (Zero-Copy Fallback)
    // FUTURE_SAB: This entire branch is unreachable in production. SharedArrayBuffer
    // is not supported in Electron UtilityProcess (PtyClient.getSharedBuffers()
    // returns empty arrays, isSharedBufferEnabled() returns false). The init-buffers
    // message that populates visualBuffers is only sent from adversarial tests.
    // Production always routes through the MessagePort path (Priority 1).
    //
    // The skeleton is preserved for a potential Worker-thread migration that could
    // revive the SAB zero-copy data path with per-consumer isolation.
    //
    // Original design intent: Used when no MessagePort renderer connections are
    // available (e.g., during startup before port handshake completes). SAB is
    // single-consumer — safe only when one view is reading. SAB has one shared
    // read pointer, so it is only safe before the app enters project-view routing.
    const visualBuffers = getVisualBuffers();
    const sabFallbackSafe = windowProjectMap.size === 0;
    if (
      !visualWritten &&
      !isSuspended &&
      !isBackgrounded &&
      visualBuffers.length > 0 &&
      sabFallbackSafe
    ) {
      const shardIndex = selectShard(id, visualBuffers.length);
      const shard = visualBuffers[shardIndex];

      const dataBytes = typeof data === "string" ? Buffer.from(data) : data;
      let wroteAny = false;
      let offset = 0;

      while (offset < dataBytes.length) {
        const nextOffset = Math.min(offset + MAX_PACKET_PAYLOAD, dataBytes.length);
        const chunk = dataBytes.subarray(offset, nextOffset);
        const packet = packetFramer.frame(id, chunk);

        if (!packet) {
          break;
        }

        const bytesWritten = shard.write(packet);

        if (bytesWritten === 0) {
          // Ring buffer is full - apply backpressure by pausing the PTY
          const queued = backpressureManager.enqueuePendingSegment(id, { data: dataBytes, offset });
          visualWritten = true; // partial write counts as handled

          if (!queued) {
            const utilization = shard.getUtilization();
            const pauseStart = backpressureManager.getPauseStartTime(id);
            const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
            backpressureManager.suspendVisualStream(
              id,
              "pending cap exceeded",
              utilization,
              pauseDuration,
              shardIndex
            );
          } else if (!backpressureManager.isPaused(id)) {
            const utilization = shard.getUtilization();
            console.warn(
              `[PtyHost] Visual buffer full (${utilization.toFixed(1)}% utilized). Pausing PTY ${id} for backpressure.`
            );

            const bpCoordinator = getOrCreatePauseCoordinator(id);
            if (!bpCoordinator) {
              console.warn(
                `[PtyHost] Cannot apply backpressure: missing PTY process for ${id}. Falling back to IPC.`
              );
              break;
            }

            let safetyTimeout: ReturnType<typeof setTimeout> | undefined;
            let committed = false;
            try {
              bpCoordinator.pause("backpressure");

              // Track when we started pausing for timeout safety
              const pauseStartTime = Date.now();
              backpressureManager.setPauseStartTime(id, pauseStartTime);

              // Emit status event for UI
              backpressureManager.emitTerminalStatus(id, "paused-backpressure", utilization);

              // Emit metrics for pause-start
              emitReliabilityMetricWithTracking(
                {
                  terminalId: id,
                  metricType: "pause-start",
                  timestamp: pauseStartTime,
                  bufferUtilization: utilization,
                  shardIndex,
                },
                "sab"
              );

              // Safety timeout: if ack-driven resume doesn't clear backpressure in time,
              // suspend the stream and rely on wake to restore state.
              safetyTimeout = setTimeout(() => {
                backpressureManager.deletePausedInterval(id);
                backpressureManager.deletePauseStartTime(id);

                const liveBuffers = getVisualBuffers();
                const si = liveBuffers.length > 0 ? selectShard(id, liveBuffers.length) : 0;
                const s = liveBuffers[si];
                const util = s ? s.getUtilization() : 0;
                const dur = Date.now() - pauseStartTime;

                if (backpressureManager.hasPendingSegments(id)) {
                  backpressureManager.suspendVisualStream(
                    id,
                    `${dur}ms ack timeout`,
                    util,
                    dur,
                    si
                  );
                } else {
                  // No pending segments — just resume via coordinator
                  const timeoutCoord = getPauseCoordinator(id);
                  timeoutCoord?.resume("backpressure");
                  if (!timeoutCoord?.isPaused) {
                    backpressureManager.emitTerminalStatus(id, "running", util, dur);
                  }
                  emitReliabilityMetricWithTracking(
                    {
                      terminalId: id,
                      metricType: "pause-end",
                      timestamp: Date.now(),
                      durationMs: dur,
                      bufferUtilization: util,
                    },
                    "sab"
                  );
                }
              }, BACKPRESSURE_SAFETY_TIMEOUT_MS);

              backpressureManager.setPausedInterval(id, safetyTimeout);
              committed = true;
            } catch (error) {
              console.error(`[PtyHost] Failed to pause SAB PTY ${id}:`, error);
            } finally {
              // If we threw between bpCoordinator.pause() and the final
              // setPausedInterval, release the token and any orphaned bookkeeping
              // so the PTY is not permanently held with no recovery path. See #7641.
              if (!committed) {
                if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
                backpressureManager.deletePauseStartTime(id);
                bpCoordinator.resume("backpressure");
              }
            }
          }
          break; // Stop writing packets
        }

        wroteAny = true;
        offset = nextOffset;
      }

      if (wroteAny) {
        visualWritten = true;
        const visualSignalView = getVisualSignalView();
        if (visualSignalView) {
          Atomics.add(visualSignalView, 0, 1);
          Atomics.notify(visualSignalView, 0, 1);
        }
      }
    }

    // A view with no MessagePort (#12557) keeps the project-scoped fallback
    // running even though a sibling window's port took the chunk. Main strips the
    // delivered windows' port holders out of the fan-out, so the only views that
    // parse it are the ones that never saw it.
    const sendIpcFallback =
      (!visualWritten || needsEligibleFallback) && !isBackgrounded && !isSuspended;
    // ...but that copy is SUPPLEMENTARY: the view actually being looked at was
    // already fed on its port. It must not be able to hold the terminal back.
    // The IPC ledger is drained by whoever receives the IPC copy, and a cached
    // consumer may be frozen (`ProjectViewLifecycleController` only spares views
    // with a live agent or MCP binding), so its acks can stop arriving
    // indefinitely. Letting that reach `applyBackpressure` would pause the PTY
    // and stall the healthy primary window on a background view's progress.
    const isSupplementaryFallback = sendIpcFallback && visualWritten;

    // Fallback: If ring buffer failed or isn't set up, use IPC with backpressure
    // Skip IPC fallback for backgrounded or suspended terminals (wake will resync via snapshot)
    let ipcDataEmitted = false;
    if (sendIpcFallback) {
      const dataString = toStringForIpc(data);
      const dataBytes = Buffer.byteLength(dataString, "utf8");

      // Enforce hard cap: drop data if adding it would exceed max queue size
      // This prevents unbounded memory growth when renderer is stalled
      if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
        const utilization = ipcQueueManager.getUtilization(id);
        console.warn(
          `[PtyHost] IPC queue full (${utilization.toFixed(1)}%). Dropping ${dataBytes} bytes for terminal ${id}`
        );
        // Counter is unconditional — regression detection must work even
        // when metrics are gated off. The wire emission of the gauge is
        // gated separately in ResourceGovernor.emitDataLossCount.
        recordDrop(id, dataBytes);
        // `ipc-cap-drop` is a data-path telemetry pulse, not a pause-source
        // transition — the funnel forwards it to the wire without touching
        // the per-source tracking map (a `suspend`/`pause-end` with `null`
        // source would be read as a force-resume and wipe the terminal's
        // entry while the IPC backpressure pause is still held; #9902).
        // The map entry is removed by the corresponding `pause-end` from
        // the IPC queue's own backpressure path. `forceEmit` bypasses the
        // metric gate — data-loss pulses must reach the wire even when
        // metrics are gated off.
        emitReliabilityMetricWithTracking(
          {
            terminalId: id,
            metricType: "ipc-cap-drop",
            timestamp: Date.now(),
            bufferUtilization: utilization,
          },
          null,
          true
        );
        // Surface the drop to the renderer so a discontinuity marker is shown.
        // Bypasses BackpressureManager.emitTerminalStatus() because each drop
        // is a distinct pulse — the dedup guard there would silently swallow
        // repeated data-loss events on the same terminal.
        // A supplementary copy losing its slot is not a terminal-wide
        // discontinuity: the pane on screen read this chunk off its port. The
        // pulse is project-scoped, so it would paint a yellow marker on that
        // pane too (#9891), and the early return would skip semantic analysis
        // for a terminal that is streaming perfectly well. Only the cached
        // duplicate misses these bytes, and the counters above record that.
        if (!isSupplementaryFallback) {
          sendEvent({
            type: "terminal-status",
            id,
            status: "data-loss",
            bufferUtilization: utilization,
            droppedBytes: dataBytes,
            timestamp: Date.now(),
          });
          return; // Drop this chunk to prevent OOM
        }
      } else {
        ipcQueueManager.addBytes(id, dataBytes);
        const utilization = ipcQueueManager.getUtilization(id);

        // Send the data via IPC. The delivered-view list is omitted entirely in
        // the ordinary case so the wire shape and Main's fan-out are untouched
        // whenever no port-less view forced the fallback open.
        sendEvent(
          portDeliveredWebContentsIds.length > 0
            ? { type: "data", id, data: dataString, portDeliveredWebContentsIds, streamEnd }
            : { type: "data", id, data: dataString, streamEnd }
        );
        ipcDataEmitted = true;

        // Apply backpressure if queue exceeds high watermark — but never on a
        // supplementary copy, per the comment on `isSupplementaryFallback`.
        if (!isSupplementaryFallback) {
          ipcQueueManager.applyBackpressure(id, utilization);
        }
      }
    }

    // IPC Data Mirror: send a Main-process-only copy for terminals that need
    // main-process monitoring (e.g., UrlDetector for dev preview URL detection),
    // even when the visual path already delivered the chunk. Background
    // terminals still need this mirror because their visual stream is
    // intentionally suppressed. Sent as `data-mirror`, not `data`: the renderer
    // already has the chunk (or the background gate suppressed it on purpose),
    // so a `data` event here would be re-broadcast to every WebContents and
    // dispatched into the same xterm a second time.
    //
    // Keyed off whether a `data` event was ACTUALLY emitted, not off whether the
    // fallback was selected — UrlDetector reads `data` too, so emitting both
    // would hand it the chunk twice, while a fallback that selected itself and
    // then lost its slot to a full IPC queue would hand it neither. Runs after
    // the fallback for that reason, and the early return above deliberately
    // skips it: that path is the pre-existing full-queue drop, where nothing
    // reaches Main at all.
    if (ipcDataMirrorTerminals.has(id) && !isSuspended && !ipcDataEmitted) {
      sendEvent(
        streamEnd === undefined
          ? { type: "data-mirror", id, data: toStringForIpc(data) }
          : { type: "data-mirror", id, data: toStringForIpc(data), streamEnd }
      );
    }

    // PRIORITY 2: BACKGROUND TASKS (Deferred Processing)
    // Now that pixels are on their way to the screen, we can do heavy work.

    // Semantic Analysis (Worker) - best-effort, can drop frames
    // Only write to analysis buffer if terminal has analysis enabled (agent terminals)
    const analysisBuffer = getAnalysisBuffer();
    if (analysisBuffer && terminalInfo?.analysisEnabled) {
      const analysisPacket = packetFramer.frame(id, data);
      if (analysisPacket) {
        const analysisWritten = analysisBuffer.write(analysisPacket);
        if (analysisWritten === 0 && process.env.DAINTREE_VERBOSE) {
          console.log(`[PtyHost] Analysis buffer full - dropping frame for terminal ${id}`);
        }
      }
    }
  }

  // Ack-driven backpressure helpers for SAB path
  function tryReplayAndResume(id: string): void {
    const segments = backpressureManager.getPendingSegments(id);
    if (!segments || segments.length === 0) {
      resumePausedTerminal(id);
      return;
    }

    const visualBuffers = getVisualBuffers();
    if (visualBuffers.length === 0) return;

    const shardIndex = selectShard(id, visualBuffers.length);
    const shard = visualBuffers[shardIndex];
    if (!shard) return;

    let wroteAny = false;
    while (segments.length > 0) {
      const segment = segments[0];
      const remaining = segment.data.length - segment.offset;
      if (remaining <= 0) {
        segments.shift();
        continue;
      }

      const nextOffset = Math.min(segment.offset + MAX_PACKET_PAYLOAD, segment.data.length);
      const chunk = segment.data.subarray(segment.offset, nextOffset);
      const packet = packetFramer.frame(id, chunk);
      if (!packet) break;

      const bytesWritten = shard.write(packet);
      if (bytesWritten === 0) {
        return; // Still full, wait for more acks
      }

      wroteAny = true;
      const consumed = nextOffset - segment.offset;
      backpressureManager.consumePendingBytes(id, consumed);
      segment.offset = nextOffset;

      if (segment.offset >= segment.data.length) {
        segments.shift();
      }
    }

    const visualSignalView = getVisualSignalView();
    if (wroteAny && visualSignalView) {
      Atomics.add(visualSignalView, 0, 1);
      Atomics.notify(visualSignalView, 0, 1);
    }

    // All pending segments drained — resume the PTY
    if (segments.length === 0) {
      backpressureManager.clearPendingVisual(id);
      resumePausedTerminal(id);
    }
  }

  function resumePausedTerminal(id: string): void {
    const safetyTimeout = backpressureManager.getPausedInterval(id);
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      backpressureManager.deletePausedInterval(id);
    }

    const pauseStart = backpressureManager.getPauseStartTime(id);
    const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
    backpressureManager.deletePauseStartTime(id);

    const coordinator = getPauseCoordinator(id);
    coordinator?.resume("backpressure");

    const visualBuffers = getVisualBuffers();
    const shardIndex = visualBuffers.length > 0 ? selectShard(id, visualBuffers.length) : 0;
    const s = visualBuffers[shardIndex];
    const utilization = s ? s.getUtilization() : 0;

    // Only emit "running" if no other subsystem still holds a pause
    if (!coordinator?.isPaused) {
      backpressureManager.emitTerminalStatus(id, "running", utilization, pauseDuration);
    }
    emitReliabilityMetricWithTracking(
      {
        terminalId: id,
        metricType: "pause-end",
        timestamp: Date.now(),
        durationMs: pauseDuration,
        bufferUtilization: utilization,
      },
      "sab"
    );

    backpressureManager.stats.resumeCount++;
  }

  return {
    routeOutput,
    tryReplayAndResume,
    resumePausedTerminal,
    takeThroughputAccumulator: () => {
      const acc = throughputAccumulator;
      throughputAccumulator = new Map();
      return acc;
    },
  };
}
