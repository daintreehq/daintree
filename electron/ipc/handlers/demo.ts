import { ipcMain } from "electron";
import { randomBytes } from "crypto";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  DemoMoveToPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScreenshotResult,
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

  ipcMain.handle(CHANNELS.DEMO_MOVE_TO, handleMoveTo);
  ipcMain.handle(CHANNELS.DEMO_CLICK, handleClick);
  ipcMain.handle(CHANNELS.DEMO_SCREENSHOT, handleScreenshot);
  ipcMain.handle(CHANNELS.DEMO_TYPE, handleType);
  ipcMain.handle(CHANNELS.DEMO_SET_ZOOM, handleSetZoom);
  ipcMain.handle(CHANNELS.DEMO_WAIT_FOR_SELECTOR, handleWaitForSelector);
  ipcMain.handle(CHANNELS.DEMO_PAUSE, handlePause);
  ipcMain.handle(CHANNELS.DEMO_RESUME, handleResume);
  ipcMain.handle(CHANNELS.DEMO_SLEEP, handleSleep);

  return () => {
    ipcMain.removeHandler(CHANNELS.DEMO_MOVE_TO);
    ipcMain.removeHandler(CHANNELS.DEMO_CLICK);
    ipcMain.removeHandler(CHANNELS.DEMO_SCREENSHOT);
    ipcMain.removeHandler(CHANNELS.DEMO_TYPE);
    ipcMain.removeHandler(CHANNELS.DEMO_SET_ZOOM);
    ipcMain.removeHandler(CHANNELS.DEMO_WAIT_FOR_SELECTOR);
    ipcMain.removeHandler(CHANNELS.DEMO_PAUSE);
    ipcMain.removeHandler(CHANNELS.DEMO_RESUME);
    ipcMain.removeHandler(CHANNELS.DEMO_SLEEP);
  };
}
