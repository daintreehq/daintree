import type { MessagePort } from "node:worker_threads";
import { SharedRingBuffer } from "../../../shared/utils/SharedRingBuffer.js";
import { POOL_ENV_EMPTY_HASH, computePoolEnvHash } from "../../services/pty/ptyPoolEnvHash.js";
import { PortBatcher, type PortBatcherFailedBatch } from "../index.js";
import type { HandlerMap, HostContext } from "./types.js";

function batchDataToString(data: Uint8Array): string {
  return Buffer.from(data).toString("utf8");
}

export function createConnectionHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    rendererConnections,
    windowProjectMap,
    disconnectWindow,
    recomputeActivityTiers,
    createPortQueueManager,
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
      recomputeActivityTiers();
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
      recomputeActivityTiers();
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
