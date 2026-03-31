import { ipcMain } from "electron";
import { randomBytes } from "crypto";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
  DemoEncodePayload,
  DemoEncodeProgressEvent,
  DemoEncodeResult,
} from "../../../shared/types/ipc/demo.js";

export function resolveFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("ffmpeg-static") as string;
}

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

  const handleMoveTo = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoMoveToPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO, payload);
  };

  const handleMoveToSelector = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoMoveToSelectorPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_MOVE_TO_SELECTOR, payload);
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
          const captureWin = getMainWindow();
          if (!captureWin || captureWin.isDestroyed()) return;
          const image = await getAppWebContents(captureWin).capturePage();
          if (!captureActive || token !== captureToken) return;
          const filename = `frame-${String(captureFrameCount + 1).padStart(6, "0")}.png`;
          await writeFile(`${captureSessionDir}/${filename}`, image.toPNG());
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

  // --- Video encoding ---

  const ENCODE_PRESETS = {
    "youtube-4k": {
      outputOptions: [
        "-s",
        "3840x2160",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "slow",
        "-g",
        "15",
        "-bf",
        "2",
        "-movflags",
        "+faststart",
        "-an",
      ],
    },
    "youtube-1080p": {
      outputOptions: [
        "-s",
        "1920x1080",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "slow",
        "-g",
        "15",
        "-bf",
        "2",
        "-movflags",
        "+faststart",
        "-an",
      ],
    },
    "web-webm": {
      outputOptions: [
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "30",
        "-b:v",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-an",
      ],
    },
  } as const;

  let activeEncode: { kill: () => void } | null = null;

  const handleEncode = async (
    event: Electron.IpcMainInvokeEvent,
    payload: DemoEncodePayload
  ): Promise<DemoEncodeResult> => {
    if (activeEncode) {
      throw new Error("An encode is already in progress");
    }

    const ffmpegBin = resolveFfmpegPath();
    const { framesDir, outputPath, preset, fps = 30 } = payload;
    const presetConfig = ENCODE_PRESETS[preset];

    const framePattern = /^frame_\d{4}\.png$/;
    const pngFiles = fs
      .readdirSync(framesDir)
      .filter((f) => framePattern.test(f))
      .sort();
    if (pngFiles.length === 0) {
      throw new Error(`No PNG frames matching frame_NNNN.png found in ${framesDir}`);
    }
    const totalFrames = pngFiles.length;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const startTime = Date.now();
    const inputPattern = path.join(framesDir, "frame_%04d.png");

    const args = [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      inputPattern,
      ...presetConfig.outputOptions,
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ];

    return new Promise<DemoEncodeResult>((resolve, reject) => {
      const proc: ChildProcess = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

      activeEncode = {
        kill: () => {
          proc.kill("SIGKILL");
        },
      };

      let stdoutBuffer = "";
      let currentFrame = 0;
      let currentFps = 0;

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const eqIdx = line.indexOf("=");
          if (eqIdx === -1) continue;
          const key = line.slice(0, eqIdx).trim();
          const value = line.slice(eqIdx + 1).trim();

          if (key === "frame") {
            currentFrame = parseInt(value, 10) || 0;
          } else if (key === "fps") {
            currentFps = parseFloat(value) || 0;
          } else if (key === "progress") {
            if (currentFrame > 0 && !event.sender.isDestroyed()) {
              const percentComplete = Math.min((currentFrame / totalFrames) * 100, 100);
              const etaSeconds = currentFps > 0 ? (totalFrames - currentFrame) / currentFps : 0;

              const progressEvent: DemoEncodeProgressEvent = {
                frame: currentFrame,
                fps: currentFps,
                percentComplete: Math.round(percentComplete * 100) / 100,
                etaSeconds: Math.round(etaSeconds * 10) / 10,
              };
              event.sender.send(CHANNELS.DEMO_ENCODE_PROGRESS, progressEvent);
            }
          }
        }
      });

      let stderrOutput = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.on("error", (err: Error) => {
        activeEncode = null;
        reject(new Error(`Encode failed: ${err.message}`));
      });

      proc.on("close", (code) => {
        activeEncode = null;
        if (code === 0) {
          resolve({ outputPath, durationMs: Date.now() - startTime });
        } else {
          const lastLines = stderrOutput.trim().split("\n").slice(-3).join("\n");
          reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`));
        }
      });
    });
  };

  ipcMain.handle(CHANNELS.DEMO_MOVE_TO, handleMoveTo);
  ipcMain.handle(CHANNELS.DEMO_MOVE_TO_SELECTOR, handleMoveToSelector);
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
  ipcMain.handle(CHANNELS.DEMO_ENCODE, handleEncode);

  return () => {
    stopCapture();
    ipcMain.removeHandler(CHANNELS.DEMO_MOVE_TO);
    ipcMain.removeHandler(CHANNELS.DEMO_MOVE_TO_SELECTOR);
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
    ipcMain.removeHandler(CHANNELS.DEMO_ENCODE);
    if (activeEncode) {
      activeEncode.kill();
      activeEncode = null;
    }
  };
}
