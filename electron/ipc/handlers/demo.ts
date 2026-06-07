// eager-import-allow: reads demo fixture files via sync fs while servicing the IPC request
import { ipcMain, session } from "electron";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { DEMO_METHOD_CHANNELS } from "./demo.preload.js";
import type { HandlerDependencies } from "../types.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
  DemoCaptureChunkPayload,
  DemoCaptureStopPayload,
  DemoScrollPayload,
  DemoDragPayload,
  DemoPressKeyPayload,
  DemoSpotlightPayload,
  DemoAnnotatePayload,
  DemoAnnotateResult,
  DemoDismissAnnotationPayload,
  DemoWaitForIdlePayload,
  DemoTypeInTerminalPayload,
  DemoSendKeyToTerminalPayload,
} from "../../../shared/types/ipc/demo.js";

const CAPTURE_MIME_TYPE = "video/webm;codecs=vp9";
const PROJECT_SESSION_PARTITION = "persist:daintree";

export function registerDemoHandlers(deps: HandlerDependencies): () => void {
  if (!deps.isDemoMode) {
    return () => {};
  }

  function getMainWindow() {
    return deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
  }

  function sendCommandAndAwait(execChannel: string, payload?: unknown): Promise<void> {
    const requestId = randomBytes(8).toString("hex");
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeListener(CHANNELS.DEMO_COMMAND_DONE, listener);
        reject(new Error(`Demo command timed out: ${execChannel}`));
      }, 30_000);

      const listener = (
        _event: Electron.IpcMainEvent,
        result: { requestId: string; error?: string }
      ) => {
        if (result.requestId === requestId) {
          clearTimeout(timeout);
          ipcMain.removeListener(CHANNELS.DEMO_COMMAND_DONE, listener);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve();
          }
        }
      };

      ipcMain.on(CHANNELS.DEMO_COMMAND_DONE, listener);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        const wc = getAppWebContents(win);
        if (!wc.isDestroyed()) {
          wc.send(execChannel, { ...((payload as object) ?? {}), requestId });
        }
      }
    });
  }

  // --- MediaRecorder-based capture state ---
  interface CaptureSession {
    captureId: string;
    outputPath: string;
    writeStream: fs.WriteStream;
    chunkCount: number;
    stopping: boolean;
    finalized: boolean;
    finalizePromise: Promise<DemoStopCaptureResult>;
    resolveFinalizeWith: (result: DemoStopCaptureResult) => void;
    rejectFinalizeWith: (err: Error) => void;
  }

  let captureSession: CaptureSession | null = null;

  const displayMediaHandlerSession = session.fromPartition(PROJECT_SESSION_PARTITION);
  displayMediaHandlerSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (request.frame) {
        callback({ video: request.frame });
      } else {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  const onCaptureChunk = (_event: Electron.IpcMainEvent, payload: DemoCaptureChunkPayload) => {
    const active = captureSession;
    if (!active || active.captureId !== payload.captureId || active.finalized) return;
    const buf = Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength);
    active.writeStream.write(buf);
    active.chunkCount += 1;
  };

  const onCaptureStop = (_event: Electron.IpcMainEvent, payload: DemoCaptureStopPayload) => {
    const active = captureSession;
    if (!active || active.captureId !== payload.captureId || active.finalized) return;
    active.chunkCount = payload.chunkCount;
    active.finalized = true;
    const rendererError = payload.error;
    active.writeStream.end(() => {
      if (captureSession === active) captureSession = null;
      if (rendererError) {
        active.rejectFinalizeWith(new Error(`Capture failed: ${rendererError}`));
      } else {
        active.resolveFinalizeWith({
          outputPath: active.outputPath,
          chunkCount: active.chunkCount,
        });
      }
    });
  };

  ipcMain.on(CHANNELS.DEMO_CAPTURE_CHUNK, onCaptureChunk);
  ipcMain.on(CHANNELS.DEMO_CAPTURE_STOP, onCaptureStop);

  const namespace = defineIpcNamespace({
    name: "demo",
    ops: {
      moveTo: op(DEMO_METHOD_CHANNELS.moveTo, async (payload: DemoMoveToPayload): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO, payload);
      }),
      moveToSelector: op(
        DEMO_METHOD_CHANNELS.moveToSelector,
        async (payload: DemoMoveToSelectorPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO_SELECTOR, payload);
        }
      ),
      click: op(DEMO_METHOD_CHANNELS.click, async (): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_CLICK);
      }),
      type: op(DEMO_METHOD_CHANNELS.type, async (payload: DemoTypePayload): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_TYPE, payload);
      }),
      screenshot: op(DEMO_METHOD_CHANNELS.screenshot, async (): Promise<DemoScreenshotResult> => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) {
          throw new Error("No window available for screenshot");
        }
        const image = await getAppWebContents(win).capturePage();
        const pngBuffer = image.toPNG();
        const size = image.getSize();
        return {
          data: new Uint8Array(pngBuffer),
          width: size.width,
          height: size.height,
        };
      }),
      waitForSelector: op(
        DEMO_METHOD_CHANNELS.waitForSelector,
        async (payload: DemoWaitForSelectorPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_SELECTOR, payload);
        }
      ),
      pause: op(DEMO_METHOD_CHANNELS.pause, async (): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PAUSE);
      }),
      resume: op(DEMO_METHOD_CHANNELS.resume, async (): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_RESUME);
      }),
      sleep: op(DEMO_METHOD_CHANNELS.sleep, async (payload: DemoSleepPayload): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SLEEP, payload);
      }),
      scroll: op(DEMO_METHOD_CHANNELS.scroll, async (payload: DemoScrollPayload): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SCROLL, payload);
      }),
      drag: op(DEMO_METHOD_CHANNELS.drag, async (payload: DemoDragPayload): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DRAG, payload);
      }),
      pressKey: op(
        DEMO_METHOD_CHANNELS.pressKey,
        async (payload: DemoPressKeyPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PRESS_KEY, payload);
        }
      ),
      typeInTerminal: op(
        DEMO_METHOD_CHANNELS.typeInTerminal,
        async (payload: DemoTypeInTerminalPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_TYPE_IN_TERMINAL, payload);
        }
      ),
      sendKeyToTerminal: op(
        DEMO_METHOD_CHANNELS.sendKeyToTerminal,
        async (payload: DemoSendKeyToTerminalPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SEND_KEY_TO_TERMINAL, payload);
        }
      ),
      spotlight: op(
        DEMO_METHOD_CHANNELS.spotlight,
        async (payload: DemoSpotlightPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SPOTLIGHT, payload);
        }
      ),
      dismissSpotlight: op(DEMO_METHOD_CHANNELS.dismissSpotlight, async (): Promise<void> => {
        await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_SPOTLIGHT);
      }),
      annotate: op(
        DEMO_METHOD_CHANNELS.annotate,
        async (payload: DemoAnnotatePayload): Promise<DemoAnnotateResult> => {
          const id = payload.id ?? randomBytes(8).toString("hex");
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_ANNOTATE, { ...payload, id });
          return { id };
        }
      ),
      dismissAnnotation: op(
        DEMO_METHOD_CHANNELS.dismissAnnotation,
        async (payload: DemoDismissAnnotationPayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_ANNOTATION, payload);
        }
      ),
      waitForIdle: op(
        DEMO_METHOD_CHANNELS.waitForIdle,
        async (payload: DemoWaitForIdlePayload): Promise<void> => {
          await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_IDLE, payload);
        }
      ),
      startCapture: op(
        DEMO_METHOD_CHANNELS.startCapture,
        async (payload: DemoStartCapturePayload): Promise<DemoStartCaptureResult> => {
          if (captureSession) {
            throw new Error("Capture already in progress");
          }

          const fps = payload.fps ?? 30;
          const { outputPath, width, height } = payload;
          // Default to a very-high-quality bitrate so demo recordings are
          // embeddable masters out of the box (~40 Mbps comfortably covers up
          // to 4K). Callers can override down for smaller files. MediaRecorder's
          // own default is far lower (~2.5 Mbps), which looks blocky at high res.
          const videoBitsPerSecond = payload.videoBitsPerSecond ?? 40_000_000;

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });

          const captureId = randomBytes(8).toString("hex");
          const writeStream = fs.createWriteStream(outputPath);

          let resolveFinalizeWith!: (result: DemoStopCaptureResult) => void;
          let rejectFinalizeWith!: (err: Error) => void;
          const finalizePromise = new Promise<DemoStopCaptureResult>((resolve, reject) => {
            resolveFinalizeWith = resolve;
            rejectFinalizeWith = reject;
          });
          // Suppress unhandled rejection if nothing ever awaits finalize (e.g., handlers
          // torn down before stopCapture is called). Real awaiters still observe the rejection.
          finalizePromise.catch(() => {});

          const newSession: CaptureSession = {
            captureId,
            outputPath,
            writeStream,
            chunkCount: 0,
            stopping: false,
            finalized: false,
            finalizePromise,
            resolveFinalizeWith,
            rejectFinalizeWith,
          };

          writeStream.on("error", (err: Error) => {
            if (captureSession === newSession && !newSession.finalized) {
              newSession.finalized = true;
              captureSession = null;
              rejectFinalizeWith(new Error(`Capture write failed: ${err.message}`));
            }
          });

          captureSession = newSession;

          try {
            await sendCommandAndAwait(CHANNELS.DEMO_EXEC_START_CAPTURE, {
              captureId,
              fps,
              mimeType: CAPTURE_MIME_TYPE,
              videoBitsPerSecond,
              width,
              height,
            });
          } catch (err) {
            captureSession = null;
            writeStream.destroy();
            throw err;
          }

          return { outputPath };
        }
      ),
      stopCapture: op(
        DEMO_METHOD_CHANNELS.stopCapture,
        async (): Promise<DemoStopCaptureResult> => {
          const active = captureSession;
          if (!active) {
            throw new Error("No capture in progress");
          }
          if (active.stopping) {
            return active.finalizePromise;
          }
          active.stopping = true;
          try {
            await sendCommandAndAwait(CHANNELS.DEMO_EXEC_STOP_CAPTURE, {
              captureId: active.captureId,
            });
          } catch (err) {
            if (captureSession === active && !active.finalized) {
              active.finalized = true;
              captureSession = null;
              active.writeStream.destroy();
              active.rejectFinalizeWith(err instanceof Error ? err : new Error(String(err)));
            }
          }
          return active.finalizePromise;
        }
      ),
      getCaptureStatus: op(
        DEMO_METHOD_CHANNELS.getCaptureStatus,
        async (): Promise<DemoCaptureStatus> => {
          return {
            active: captureSession !== null && !captureSession.finalized,
            chunkCount: captureSession?.chunkCount ?? 0,
            outputPath: captureSession?.outputPath ?? null,
          };
        }
      ),
    },
  });

  const cleanups: Array<() => void> = [namespace.register()];

  return () => {
    if (captureSession && !captureSession.finalized) {
      const active = captureSession;
      active.finalized = true;
      active.writeStream.destroy();
      active.rejectFinalizeWith(new Error("Capture aborted: handlers unregistered"));
      captureSession = null;
    }
    ipcMain.removeListener(CHANNELS.DEMO_CAPTURE_CHUNK, onCaptureChunk);
    ipcMain.removeListener(CHANNELS.DEMO_CAPTURE_STOP, onCaptureStop);
    displayMediaHandlerSession.setDisplayMediaRequestHandler(null);
    cleanups.forEach((cleanup) => cleanup());
  };
}
