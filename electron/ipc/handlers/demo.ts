import { ipcMain, session } from "electron";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import { typedHandle } from "../utils.js";
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

  const handleMoveTo = async (payload: DemoMoveToPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO, payload);
  };

  const handleMoveToSelector = async (payload: DemoMoveToSelectorPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO_SELECTOR, payload);
  };

  const handleClick = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_CLICK);
  };

  const handleType = async (payload: DemoTypePayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_TYPE, payload);
  };

  const handleScreenshot = async (): Promise<DemoScreenshotResult> => {
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
  };

  const handleWaitForSelector = async (payload: DemoWaitForSelectorPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_SELECTOR, payload);
  };

  const handlePause = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PAUSE);
  };

  const handleResume = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_RESUME);
  };

  const handleSleep = async (payload: DemoSleepPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SLEEP, payload);
  };

  const handleScroll = async (payload: DemoScrollPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SCROLL, payload);
  };

  const handleDrag = async (payload: DemoDragPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DRAG, payload);
  };

  const handlePressKey = async (payload: DemoPressKeyPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PRESS_KEY, payload);
  };

  const handleSpotlight = async (payload: DemoSpotlightPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SPOTLIGHT, payload);
  };

  const handleDismissSpotlight = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_SPOTLIGHT);
  };

  const handleAnnotate = async (payload: DemoAnnotatePayload): Promise<DemoAnnotateResult> => {
    const id = payload.id ?? randomBytes(8).toString("hex");
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_ANNOTATE, { ...payload, id });
    return { id };
  };

  const handleDismissAnnotation = async (payload: DemoDismissAnnotationPayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_ANNOTATION, payload);
  };

  const handleWaitForIdle = async (payload: DemoWaitForIdlePayload): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_IDLE, payload);
  };

  // --- MediaRecorder-based capture state ---
  interface CaptureSession {
    captureId: string;
    outputPath: string;
    writeStream: fs.WriteStream;
    frameCount: number;
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
  };

  const onCaptureStop = (_event: Electron.IpcMainEvent, payload: DemoCaptureStopPayload) => {
    const active = captureSession;
    if (!active || active.captureId !== payload.captureId || active.finalized) return;
    active.frameCount = payload.frameCount;
    active.finalized = true;
    const rendererError = payload.error;
    active.writeStream.end(() => {
      if (captureSession === active) captureSession = null;
      if (rendererError) {
        active.rejectFinalizeWith(new Error(`Capture failed: ${rendererError}`));
      } else {
        active.resolveFinalizeWith({
          outputPath: active.outputPath,
          frameCount: active.frameCount,
        });
      }
    });
  };

  ipcMain.on(CHANNELS.DEMO_CAPTURE_CHUNK, onCaptureChunk);
  ipcMain.on(CHANNELS.DEMO_CAPTURE_STOP, onCaptureStop);

  const handleStartCapture = async (
    payload: DemoStartCapturePayload
  ): Promise<DemoStartCaptureResult> => {
    if (captureSession) {
      throw new Error("Capture already in progress");
    }

    const fps = payload.fps ?? 30;
    const { outputPath } = payload;

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
      frameCount: 0,
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
      });
    } catch (err) {
      captureSession = null;
      writeStream.destroy();
      throw err;
    }

    return { outputPath };
  };

  const handleStopCapture = async (): Promise<DemoStopCaptureResult> => {
    const active = captureSession;
    if (!active) {
      throw new Error("No capture in progress");
    }
    if (active.stopping) {
      return active.finalizePromise;
    }
    active.stopping = true;
    try {
      await sendCommandAndAwait(CHANNELS.DEMO_EXEC_STOP_CAPTURE, { captureId: active.captureId });
    } catch (err) {
      if (captureSession === active && !active.finalized) {
        active.finalized = true;
        captureSession = null;
        active.writeStream.destroy();
        active.rejectFinalizeWith(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return active.finalizePromise;
  };

  const handleGetCaptureStatus = async (): Promise<DemoCaptureStatus> => {
    return {
      active: captureSession !== null && !captureSession.finalized,
      frameCount: captureSession?.frameCount ?? 0,
      outputPath: captureSession?.outputPath ?? null,
    };
  };

  const cleanups: Array<() => void> = [
    typedHandle(CHANNELS.DEMO_MOVE_TO, handleMoveTo),
    typedHandle(CHANNELS.DEMO_MOVE_TO_SELECTOR, handleMoveToSelector),
    typedHandle(CHANNELS.DEMO_CLICK, handleClick),
    typedHandle(CHANNELS.DEMO_SCREENSHOT, handleScreenshot),
    typedHandle(CHANNELS.DEMO_TYPE, handleType),
    typedHandle(CHANNELS.DEMO_WAIT_FOR_SELECTOR, handleWaitForSelector),
    typedHandle(CHANNELS.DEMO_PAUSE, handlePause),
    typedHandle(CHANNELS.DEMO_RESUME, handleResume),
    typedHandle(CHANNELS.DEMO_SLEEP, handleSleep),
    typedHandle(CHANNELS.DEMO_SCROLL, handleScroll),
    typedHandle(CHANNELS.DEMO_DRAG, handleDrag),
    typedHandle(CHANNELS.DEMO_PRESS_KEY, handlePressKey),
    typedHandle(CHANNELS.DEMO_SPOTLIGHT, handleSpotlight),
    typedHandle(CHANNELS.DEMO_DISMISS_SPOTLIGHT, handleDismissSpotlight),
    typedHandle(CHANNELS.DEMO_ANNOTATE, handleAnnotate),
    typedHandle(CHANNELS.DEMO_DISMISS_ANNOTATION, handleDismissAnnotation),
    typedHandle(CHANNELS.DEMO_WAIT_FOR_IDLE, handleWaitForIdle),
    typedHandle(CHANNELS.DEMO_START_CAPTURE, handleStartCapture),
    typedHandle(CHANNELS.DEMO_STOP_CAPTURE, handleStopCapture),
    typedHandle(CHANNELS.DEMO_GET_CAPTURE_STATUS, handleGetCaptureStatus),
  ];

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
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
