import { ipcMain } from "electron";
import { randomBytes } from "crypto";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  DemoMoveToPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
} from "../../../shared/types/ipc/demo.js";

export function registerDemoHandlers(deps: HandlerDependencies): () => void {
  if (!deps.isDemoMode) {
    return () => {};
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
      deps.mainWindow.webContents.send(execChannel, { ...((payload as object) ?? {}), requestId });
    });
  }

  const handleMoveTo = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoMoveToPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO, payload);
  };

  const handleClick = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_CLICK);
  };

  const handleType = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoTypePayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_TYPE, payload);
  };

  const handleSetZoom = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoSetZoomPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SET_ZOOM, payload);
  };

  const handleScreenshot = async (): Promise<DemoScreenshotResult> => {
    const image = await deps.mainWindow.webContents.capturePage();
    const pngBuffer = image.toPNG();
    const size = image.getSize();
    return {
      data: new Uint8Array(pngBuffer),
      width: size.width,
      height: size.height,
    };
  };

  const handleWaitForSelector = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoWaitForSelectorPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_SELECTOR, payload);
  };

  const handlePause = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PAUSE);
  };

  const handleResume = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_RESUME);
  };

  const handleSleep = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoSleepPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SLEEP, payload);
  };

  // --- Frame capture state ---
  let captureActive = false;
  let captureBusy = false;
  let captureFrameCount = 0;
  let captureSessionDir: string | null = null;
  let captureTimer: ReturnType<typeof setTimeout> | null = null;
  let captureToken = 0;
  let captureMaxFrames = 9000;

  function stopCapture(): DemoStopCaptureResult {
    captureActive = false;
    captureToken++;
    if (captureTimer !== null) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    return { outputDir: captureSessionDir ?? "", frameCount: captureFrameCount };
  }

  const handleStartCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoStartCapturePayload
  ): Promise<DemoStartCaptureResult> => {
    if (captureActive) {
      throw new Error("Capture already in progress");
    }

    captureActive = true;
    const fps = payload.fps ?? 30;
    captureMaxFrames = payload.maxFrames ?? 9000;
    const intervalMs = Math.round(1000 / fps);

    try {
      captureSessionDir = payload.outputDir ?? (await mkdtemp(join(tmpdir(), "canopy-capture-")));
    } catch (err) {
      captureActive = false;
      throw err;
    }
    captureFrameCount = 0;
    captureBusy = false;
    const token = ++captureToken;

    function scheduleNext(): void {
      captureTimer = setTimeout(async () => {
        if (!captureActive || token !== captureToken) return;
        if (captureBusy) {
          scheduleNext();
          return;
        }
        captureBusy = true;
        try {
          const image = await deps.mainWindow.webContents.capturePage();
          if (!captureActive || token !== captureToken) return;
          const filename = `frame-${String(captureFrameCount + 1).padStart(6, "0")}.png`;
          await writeFile(join(captureSessionDir!, filename), image.toPNG());
          if (!captureActive || token !== captureToken) return;
          captureFrameCount++;
          if (captureFrameCount >= captureMaxFrames) {
            stopCapture();
          } else {
            scheduleNext();
          }
        } catch {
          if (captureActive && token === captureToken) {
            scheduleNext();
          }
        } finally {
          captureBusy = false;
        }
      }, intervalMs);
    }

    scheduleNext();
    return { outputDir: captureSessionDir };
  };

  const handleStopCapture = async (): Promise<DemoStopCaptureResult> => {
    return stopCapture();
  };

  const handleGetCaptureStatus = async (): Promise<DemoCaptureStatus> => {
    return {
      active: captureActive,
      frameCount: captureFrameCount,
      outputDir: captureSessionDir,
    };
  };

  ipcMain.handle(CHANNELS.DEMO_MOVE_TO, handleMoveTo);
  ipcMain.handle(CHANNELS.DEMO_CLICK, handleClick);
  ipcMain.handle(CHANNELS.DEMO_SCREENSHOT, handleScreenshot);
  ipcMain.handle(CHANNELS.DEMO_TYPE, handleType);
  ipcMain.handle(CHANNELS.DEMO_SET_ZOOM, handleSetZoom);
  ipcMain.handle(CHANNELS.DEMO_WAIT_FOR_SELECTOR, handleWaitForSelector);
  ipcMain.handle(CHANNELS.DEMO_PAUSE, handlePause);
  ipcMain.handle(CHANNELS.DEMO_RESUME, handleResume);
  ipcMain.handle(CHANNELS.DEMO_SLEEP, handleSleep);
  ipcMain.handle(CHANNELS.DEMO_START_CAPTURE, handleStartCapture);
  ipcMain.handle(CHANNELS.DEMO_STOP_CAPTURE, handleStopCapture);
  ipcMain.handle(CHANNELS.DEMO_GET_CAPTURE_STATUS, handleGetCaptureStatus);

  return () => {
    stopCapture();
    ipcMain.removeHandler(CHANNELS.DEMO_MOVE_TO);
    ipcMain.removeHandler(CHANNELS.DEMO_CLICK);
    ipcMain.removeHandler(CHANNELS.DEMO_SCREENSHOT);
    ipcMain.removeHandler(CHANNELS.DEMO_TYPE);
    ipcMain.removeHandler(CHANNELS.DEMO_SET_ZOOM);
    ipcMain.removeHandler(CHANNELS.DEMO_WAIT_FOR_SELECTOR);
    ipcMain.removeHandler(CHANNELS.DEMO_PAUSE);
    ipcMain.removeHandler(CHANNELS.DEMO_RESUME);
    ipcMain.removeHandler(CHANNELS.DEMO_SLEEP);
    ipcMain.removeHandler(CHANNELS.DEMO_START_CAPTURE);
    ipcMain.removeHandler(CHANNELS.DEMO_STOP_CAPTURE);
    ipcMain.removeHandler(CHANNELS.DEMO_GET_CAPTURE_STATUS);
  };
}
