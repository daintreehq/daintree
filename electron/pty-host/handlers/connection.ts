import type { MessagePort } from "node:worker_threads";
import { SharedRingBuffer } from "../../../shared/utils/SharedRingBuffer.js";
import { PortBatcher } from "../index.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createConnectionHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    rendererConnections,
    windowProjectMap,
    disconnectWindow,
    recomputeActivityTiers,
    createPortQueueManager,
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
          // Transfer the backing ArrayBuffer to the renderer instead of
          // structured-cloning. The batcher allocates `data` fresh per
          // flush, so it is safe to detach here.
          receivedPort.postMessage({ type: "data", id, data, bytes }, [data.buffer as ArrayBuffer]);
        },
        onError: () => {
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
      if (msg.projectPath && pool) {
        pool.drainAndRefill(msg.projectPath).catch((err) => {
          console.error("[PtyHost] drainAndRefill failed:", err);
        });
      }
    },

    "project-switch": (msg) => {
      windowProjectMap.set(msg.windowId, msg.projectId);
      recomputeActivityTiers();
      const pool = ctx.ptyPool;
      if (msg.projectPath && pool) {
        pool.drainAndRefill(msg.projectPath).catch((err) => {
          console.error("[PtyHost] drainAndRefill failed:", err);
        });
      }
    },
  };
}
