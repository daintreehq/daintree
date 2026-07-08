import type { MessagePort } from "node:worker_threads";
import { SharedRingBuffer } from "../../../shared/utils/SharedRingBuffer.js";
import { POOL_ENV_EMPTY_HASH, computePoolEnvHash } from "../../services/pty/ptyPoolEnvHash.js";
import { markPerformance } from "../../utils/performance.js";
import { PortBatcher, type PortBatcherFailedBatch } from "../index.js";
import type { HandlerMap, HostContext } from "./types.js";

function batchDataToString(data: Uint8Array): string {
  return Buffer.from(data).toString("utf8");
}

export function createConnectionHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    rendererConnections,
    terminalWorkerConnections,
    windowProjectMap,
    windowFocusedTerminalMap,
    disconnectWindow,
    disconnectTerminalWorkerPort,
    recomputeActivityTiers,
    createPortQueueManager,
    createTerminalWorkerPortQueueManager,
    sendEvent,
  } = ctx;

  return {
    "connect-port": (msg, ports) => {
      const windowId: number | undefined = msg.windowId;
      if (typeof windowId !== "number") {
        console.warn("[PtyHost] connect-port missing windowId, ignoring");
        return;
      }

      if (!ports || ports.length === 0) {
        console.warn("[PtyHost] connect-port message received but no ports provided");
        return;
      }

      const receivedPort = ports[0] as MessagePort;
      const existing = rendererConnections.get(windowId);

      // Duplicate port check
      if (existing?.port === receivedPort) {
        try {
          receivedPort.start();
        } catch {
          // ignore
        }
        console.log(
          `[PtyHost] MessagePort already connected for window ${windowId}, ignoring duplicate`
        );
        return;
      }

      // Replace existing connection for this window
      if (existing) {
        disconnectWindow(windowId, "port-replace");
      }

      const perWindowQueueManager = createPortQueueManager(windowId);
      const perWindowBatcher = new PortBatcher({
        portQueueManager: perWindowQueueManager,
        getFocusedTerminalId: () => windowFocusedTerminalMap.get(windowId) ?? null,
        postMessage: (id, data, bytes) => {
          // Structured-clone the chunk — no transfer list. This port is
          // Electron's utility-process MessagePortMain, whose postMessage
          // transfer array accepts MessagePortMain entries only: passing an
          // ArrayBuffer throws "Port at index 0 is not a valid port", and the
          // onError fallback then tears down the healthy port, severing the
          // window's terminal stream. The zero-copy transfer attempt was
          // never exercised before terminals carried a resolved projectId
          // (the project filter kept this path dormant), so the clone here
          // is the proven behaviour.
          receivedPort.postMessage({ type: "data", id, data, bytes });
        },
        onError: (error: unknown, failedBatches: PortBatcherFailedBatch[]) => {
          console.warn(
            `[PtyHost] Port postMessage failed for window ${windowId}; falling back to IPC and disconnecting the port:`,
            error
          );
          for (const batch of failedBatches) {
            if (batch.bytes <= 0) continue;
            sendEvent({ type: "data", id: batch.id, data: batchDataToString(batch.data) });
          }
          disconnectWindow(windowId, "postMessage-error");
        },
      });
      receivedPort.start();
      console.log(
        `[PtyHost] MessagePort received from Main for window ${windowId}, starting listener...`
      );

      const handler = (event: MessageEvent) => {
        const portMsg = event?.data ? event.data : event;

        if (!portMsg || typeof portMsg !== "object") {
          console.warn("[PtyHost] Invalid MessagePort message:", portMsg);
          return;
        }

        try {
          if (
            portMsg.type === "write" &&
            typeof portMsg.id === "string" &&
            typeof portMsg.data === "string"
          ) {
            ptyManager.write(portMsg.id, portMsg.data, portMsg.traceId);
            // PERF-120 T2 attribution mark (no-op unless DAINTREE_PERF_CAPTURE):
            // paired with terminal_interactive_echo_dispatched to expose the
            // host-internal slice of the keystroke round trip.
            markPerformance("terminal_port_input_written", {
              terminalId: portMsg.id,
              bytes: portMsg.data.length,
            });
          } else if (
            portMsg.type === "resize" &&
            typeof portMsg.id === "string" &&
            typeof portMsg.cols === "number" &&
            typeof portMsg.rows === "number"
          ) {
            ptyManager.resize(portMsg.id, portMsg.cols, portMsg.rows);
          } else if (
            portMsg.type === "ack" &&
            typeof portMsg.id === "string" &&
            typeof portMsg.bytes === "number"
          ) {
            perWindowQueueManager.removeBytes(portMsg.id, portMsg.bytes);
            perWindowQueueManager.tryResume(portMsg.id);
          } else if (portMsg.type === "worker-ingest-engage" && typeof portMsg.id === "string") {
            const workerConn = terminalWorkerConnections.get(windowId)?.get(portMsg.id);
            if (workerConn) {
              workerConn.engaged = true;
              // The engaged marker must land FIFO behind the final
              // window-routed chunk — flush what the window batcher still
              // holds for this terminal before posting it.
              perWindowBatcher.flushTerminal(portMsg.id);
              receivedPort.postMessage({ type: "worker-ingest-engaged", id: portMsg.id });
            } else {
              // No dedicated port connected — never engage. The renderer's
              // engage timeout falls the terminal back to the main-thread path.
              console.warn(
                `[PtyHost] worker-ingest-engage without a dedicated port for terminal ${portMsg.id} (window ${windowId})`
              );
            }
          } else if (
            portMsg.type === "worker-ingest-release" &&
            typeof portMsg.id === "string" &&
            typeof portMsg.drainId === "number"
          ) {
            const workerConn = terminalWorkerConnections.get(windowId)?.get(portMsg.id);
            if (workerConn) {
              workerConn.engaged = false;
              // Sentinel rides the dedicated port FIFO behind the final
              // worker-routed chunk (dedicated batcher flushed first).
              workerConn.batcher.flushTerminal(portMsg.id);
              try {
                workerConn.port.postMessage({
                  type: "ingest-detached",
                  drainId: portMsg.drainId,
                });
              } catch {
                // Dedicated port closing — the worker's port-close signal
                // drives the renderer's fallback instead.
              }
            }
          } else {
            console.warn("[PtyHost] Unknown or invalid MessagePort message type:", portMsg.type);
          }
        } catch (error) {
          console.error("[PtyHost] Error handling MessagePort message:", error);
        }
      };

      receivedPort.on("message", handler);

      receivedPort.on("close", () => {
        // Guard: only disconnect if this port is still the active one for this window
        const current = rendererConnections.get(windowId);
        if (current?.port === receivedPort) {
          disconnectWindow(windowId, "port-close");
        }
      });

      rendererConnections.set(windowId, {
        port: receivedPort,
        handler,
        portQueueManager: perWindowQueueManager,
        batcher: perWindowBatcher,
      });
      console.log(`[PtyHost] MessagePort listener installed for window ${windowId}`);
    },

    // Dedicated worker-ingest port for one (window, terminal) pair (issue
    // #10960). Mirrors connect-port's queue/batcher machinery at per-terminal
    // scope; starts disengaged — routing flips only on the renderer's
    // worker-ingest-engage, once the far end is already attached to the worker.
    "connect-terminal-port": (msg, ports) => {
      const windowId: number | undefined = msg.windowId;
      const terminalId: string | undefined = msg.id;
      if (typeof windowId !== "number" || typeof terminalId !== "string") {
        console.warn("[PtyHost] connect-terminal-port missing windowId/id, ignoring");
        return;
      }
      if (!ports || ports.length === 0) {
        console.warn("[PtyHost] connect-terminal-port message received but no ports provided");
        return;
      }

      const receivedPort = ports[0] as MessagePort;
      const existing = terminalWorkerConnections.get(windowId)?.get(terminalId);
      if (existing?.port === receivedPort) {
        try {
          receivedPort.start();
        } catch {
          // ignore
        }
        return;
      }
      if (existing) {
        disconnectTerminalWorkerPort(windowId, terminalId, "port-replace");
      }

      const queueManager = createTerminalWorkerPortQueueManager(windowId, terminalId);
      const batcher = new PortBatcher({
        portQueueManager: queueManager,
        // A worker-ingested terminal is BACKGROUND-tier by definition — no
        // focused-terminal acceleration on this port.
        getFocusedTerminalId: () => null,
        postMessage: (id, data, bytes) => {
          // Structured clone, no transfer list — same MessagePortMain
          // constraint as the per-window batcher above.
          receivedPort.postMessage({ type: "data", id, data, bytes });
        },
        onError: (error: unknown, failedBatches: PortBatcherFailedBatch[]) => {
          console.warn(
            `[PtyHost] Worker-ingest port postMessage failed for terminal ${terminalId} (window ${windowId}); falling back to IPC and disconnecting:`,
            error
          );
          for (const batch of failedBatches) {
            if (batch.bytes <= 0) continue;
            sendEvent({ type: "data", id: batch.id, data: batchDataToString(batch.data) });
          }
          disconnectTerminalWorkerPort(windowId, terminalId, "postMessage-error");
        },
      });
      receivedPort.start();

      const handler = (event: MessageEvent) => {
        const portMsg = event?.data ? event.data : event;
        if (!portMsg || typeof portMsg !== "object") return;
        try {
          // The worker only ever acks on this port (after the authority
          // parses the chunk) — writes/resizes stay on the window port.
          if (
            portMsg.type === "ack" &&
            typeof portMsg.id === "string" &&
            typeof portMsg.bytes === "number"
          ) {
            queueManager.removeBytes(portMsg.id, portMsg.bytes);
            queueManager.tryResume(portMsg.id);
          }
        } catch (error) {
          console.error("[PtyHost] Error handling worker-ingest port message:", error);
        }
      };
      receivedPort.on("message", handler);

      receivedPort.on("close", () => {
        const current = terminalWorkerConnections.get(windowId)?.get(terminalId);
        if (current?.port === receivedPort) {
          disconnectTerminalWorkerPort(windowId, terminalId, "port-close");
        }
      });

      let perWindow = terminalWorkerConnections.get(windowId);
      if (!perWindow) {
        perWindow = new Map();
        terminalWorkerConnections.set(windowId, perWindow);
      }
      perWindow.set(terminalId, {
        port: receivedPort,
        handler,
        portQueueManager: queueManager,
        batcher,
        engaged: false,
      });
    },

    "disconnect-terminal-port": (msg) => {
      if (typeof msg.windowId !== "number" || typeof msg.id !== "string") return;
      disconnectTerminalWorkerPort(msg.windowId, msg.id, "explicit-disconnect");
    },

    "set-focused-terminal": (msg) => {
      // Per-window focused terminal id from the renderer. Read by this window's
      // PortQueueManager (aggregate-pause exemption + resume-first) and
      // PortBatcher (flush-first). Keyed by windowId — never global — so each
      // WebContentsView/project view keeps its own focus.
      windowFocusedTerminalMap.set(msg.windowId, msg.id);
    },

    "disconnect-port": (msg) => {
      disconnectWindow(msg.windowId, "explicit-disconnect");
    },

    // FUTURE_SAB: This handler is unreachable in production — the only caller
    // is the adversarial test suite. SharedArrayBuffer is unsupported in
    // Electron UtilityProcess, so PtyClient.getSharedBuffers() returns empty
    // arrays and the init-buffers message is never sent outside tests.
    "init-buffers": (msg) => {
      const visualOk =
        Array.isArray(msg.visualBuffers) &&
        msg.visualBuffers.every((b: unknown) => b instanceof SharedArrayBuffer);
      const analysisOk = msg.analysisBuffer instanceof SharedArrayBuffer;
      const signalOk = msg.visualSignalBuffer instanceof SharedArrayBuffer;

      if (visualOk) {
        ctx.visualBuffers = msg.visualBuffers.map(
          (buf: SharedArrayBuffer) => new SharedRingBuffer(buf)
        );
        ptyManager.setSabMode(true);
      } else {
        console.warn("[PtyHost] init-buffers: visualBuffers missing or invalid (IPC mode)");
      }

      if (signalOk) {
        ctx.visualSignalView = new Int32Array(msg.visualSignalBuffer);
      } else {
        console.warn("[PtyHost] init-buffers: visualSignalBuffer missing or invalid");
      }

      if (analysisOk) {
        ctx.analysisBuffer = new SharedRingBuffer(msg.analysisBuffer);
      } else {
        console.warn("[PtyHost] init-buffers: analysisBuffer is not SharedArrayBuffer");
      }

      console.log(
        `[PtyHost] Buffers initialized: visual=${
          visualOk ? `${ctx.visualBuffers.length} shards` : "IPC"
        } signal=${signalOk ? "SAB" : "disabled"} analysis=${
          analysisOk ? "SAB" : "disabled"
        } sabMode=${ptyManager.isSabMode()}`
      );
    },

    "set-active-project": (msg) => {
      windowProjectMap.set(msg.windowId, msg.projectId);
      recomputeActivityTiers(msg.projectId);
      const pool = ctx.ptyPool;
      if (!msg.projectPath && pool && ctx.initialPoolWarmDeferred) {
        // The boot-time homedir warm was deferred for a project restore that
        // fell through (e.g. the saved project no longer exists) — run it now
        // at the pool's default cwd (still homedir).
        ctx.initialPoolWarmDeferred = false;
        pool.warmPool().catch((err) => {
          console.error("[PtyHost] Deferred pool warm failed:", err);
        });
      }
      if (msg.projectPath && pool) {
        ctx.initialPoolWarmDeferred = false;
        // Bound the warm set to what the pool can hold alongside the root entry
        // without LRU-evicting the entries we just warmed. The root drain/refill
        // takes poolSize slots; each panel cwd takes up to poolSize more. Cap
        // the distinct panel cwds so root + panels never exceed maxEntries —
        // otherwise warming a low-priority cwd would evict the oldest entry,
        // which is the high-priority (active-worktree) cwd warmed first (#9774).
        const maxPanelKeys = Math.max(
          0,
          Math.floor(pool.getMaxEntries() / pool.getMaxPoolSize()) - 1
        );
        const panelCwds = (msg.panelCwds ?? []).slice(0, maxPanelKeys);
        // Compute the envHash here (not in Main) so the warm key is guaranteed
        // to match the `acquireByKey` lookup at spawn time — the same
        // `computePoolEnvHash` over the same merged env produces both (#9810).
        // When `projectEnv` is null/empty, `computePoolEnvHash` collapses to
        // POOL_ENV_EMPTY_HASH and the warm path is identical to the pre-#9810
        // behaviour.
        const projectEnvHash = computePoolEnvHash(msg.projectEnv ?? undefined);
        const warmCallerEnv =
          projectEnvHash === POOL_ENV_EMPTY_HASH ? undefined : (msg.projectEnv ?? undefined);
        pool
          .drainAndRefill(msg.projectPath)
          .then(() => {
            // Warm the restored panels' own cwds AFTER the root drain/refill
            // resolves. drainAndRefill bumps the drain epoch synchronously and
            // clears stale entries; warming here (not before) guarantees these
            // entries are tagged with the current epoch and survive (#9774).
            // warmForKey is idempotent, per-key capacity-capped, and circuit-
            // broken, so stale/deleted worktree paths self-limit.
            for (const cwd of panelCwds) {
              pool.warmForKey(cwd, warmCallerEnv, projectEnvHash);
            }
          })
          .catch((err) => {
            console.error("[PtyHost] drainAndRefill failed:", err);
          });
      }
    },

    "project-switch": (msg) => {
      windowProjectMap.set(msg.windowId, msg.projectId);
      recomputeActivityTiers(msg.projectId);
      const pool = ctx.ptyPool;
      if (!msg.projectPath && pool && ctx.initialPoolWarmDeferred) {
        // Restart replay can carry a switch context with no recorded path —
        // consume the deferral so the pool doesn't stay cold indefinitely.
        ctx.initialPoolWarmDeferred = false;
        pool.warmPool().catch((err) => {
          console.error("[PtyHost] Deferred pool warm failed:", err);
        });
      }
      if (msg.projectPath && pool) {
        ctx.initialPoolWarmDeferred = false;
        pool.drainAndRefill(msg.projectPath).catch((err) => {
          console.error("[PtyHost] drainAndRefill failed:", err);
        });
      }
    },
  };
}
