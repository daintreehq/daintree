import { ipcMain } from "electron";
import { randomBytes } from "crypto";
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
  DemoEncodePreset,
  DemoScrollPayload,
  DemoDragPayload,
  DemoPressKeyPayload,
  DemoSpotlightPayload,
  DemoAnnotatePayload,
  DemoAnnotateResult,
  DemoDismissAnnotationPayload,
  DemoWaitForIdlePayload,
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

  const handleScroll = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoScrollPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SCROLL, payload);
  };

  const handleDrag = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoDragPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DRAG, payload);
  };

  const handlePressKey = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoPressKeyPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_PRESS_KEY, payload);
  };

  const handleSpotlight = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoSpotlightPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_SPOTLIGHT, payload);
  };

  const handleDismissSpotlight = async (): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_SPOTLIGHT);
  };

  const handleAnnotate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoAnnotatePayload
  ): Promise<DemoAnnotateResult> => {
    const id = payload.id ?? randomBytes(8).toString("hex");
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_ANNOTATE, { ...payload, id });
    return { id };
  };

  const handleDismissAnnotation = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoDismissAnnotationPayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_DISMISS_ANNOTATION, payload);
  };

  const handleWaitForIdle = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoWaitForIdlePayload
  ): Promise<void> => {
    await sendCommandAndAwait(CHANNELS.DEMO_EXEC_WAIT_FOR_IDLE, payload);
  };

  // --- Frame capture state ---
  interface CaptureSession {
    ffmpegProc: ChildProcess;
    ticker: ReturnType<typeof setInterval> | null;
    captureToken: number;
    lastFrameBuffer: Buffer | null;
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    maxFrames: number;
    outputPath: string;
    draining: boolean;
    stopping: boolean;
    fps: number;
    finalizePromise: Promise<DemoStopCaptureResult>;
    resolveFinalizeWith: (result: DemoStopCaptureResult) => void;
    rejectFinalizeWith: (err: Error) => void;
  }

  let captureSession: CaptureSession | null = null;
  let captureTokenCounter = 0;

  function writeFrameToStdin(session: CaptureSession): void {
    if (!session.lastFrameBuffer || session.stopping) return;
    const ok = session.ffmpegProc.stdin!.write(session.lastFrameBuffer);
    session.frameCount++;
    if (session.frameCount >= session.maxFrames) {
      stopCaptureSession();
      return;
    }
    if (!ok) {
      session.draining = true;
      if (session.ticker !== null) {
        clearInterval(session.ticker);
        session.ticker = null;
      }
      session.ffmpegProc.stdin!.once("drain", () => {
        if (session !== captureSession || session.stopping) return;
        session.draining = false;
        session.ticker = setInterval(
          () => writeFrameToStdin(session),
          Math.round(1000 / session.fps)
        );
      });
    }
  }

  function stopCaptureSession(): Promise<DemoStopCaptureResult> | null {
    const session = captureSession;
    if (!session || session.stopping) return session?.finalizePromise ?? null;
    session.stopping = true;
    captureTokenCounter++;
    if (session.ticker !== null) {
      clearInterval(session.ticker);
      session.ticker = null;
    }
    session.ffmpegProc.stdin!.end();
    return session.finalizePromise;
  }

  function startCaptureLoop(session: CaptureSession, token: number): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const wc = getAppWebContents(win);

    void (async () => {
      while (captureSession === session && session.captureToken === token && !session.stopping) {
        try {
          const image = await wc.capturePage();
          if (captureSession !== session || session.captureToken !== token || session.stopping)
            break;
          const resized = image.resize({
            width: session.frameWidth,
            height: session.frameHeight,
            quality: "best",
          });
          session.lastFrameBuffer = resized.toBitmap();
        } catch {
          // Keep lastFrameBuffer unchanged — ticker will duplicate
        }
        // Yield to event loop between captures to avoid starving the ticker
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })();
  }

  const handleStartCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoStartCapturePayload
  ): Promise<DemoStartCaptureResult> => {
    if (captureSession) {
      throw new Error("Capture already in progress");
    }

    const fps = payload.fps ?? 30;
    const maxFrames = payload.maxFrames ?? 9000;
    const { outputPath, preset } = payload;
    const presetConfig = CAPTURE_PRESETS[preset];
    if (!presetConfig) {
      throw new Error(`Unknown capture preset: ${preset}`);
    }

    // Capture first frame to determine dimensions
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      throw new Error("No window available for capture");
    }
    const firstImage = await getAppWebContents(win).capturePage();
    const logicalSize = firstImage.getSize();
    const frameWidth = logicalSize.width;
    const frameHeight = logicalSize.height;
    const resizedFirst = firstImage.resize({
      width: frameWidth,
      height: frameHeight,
      quality: "best",
    });
    const firstBitmap = resizedFirst.toBitmap();

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const ffmpegBin = resolveFfmpegPath();
    const args = [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-video_size",
      `${frameWidth}x${frameHeight}`,
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
      ...presetConfig.outputOptions,
      "-fps_mode",
      "cfr",
      outputPath,
    ];

    const ffmpegProc = spawn(ffmpegBin, args, { stdio: ["pipe", "pipe", "pipe"] });

    const token = ++captureTokenCounter;

    let resolveFinalizeWith!: (result: DemoStopCaptureResult) => void;
    let rejectFinalizeWith!: (err: Error) => void;
    const finalizePromise = new Promise<DemoStopCaptureResult>((resolve, reject) => {
      resolveFinalizeWith = resolve;
      rejectFinalizeWith = reject;
    });

    const session: CaptureSession = {
      ffmpegProc,
      ticker: null,
      captureToken: token,
      lastFrameBuffer: firstBitmap,
      frameWidth,
      frameHeight,
      frameCount: 0,
      maxFrames,
      outputPath,
      draining: false,
      stopping: false,
      fps,
      finalizePromise,
      resolveFinalizeWith,
      rejectFinalizeWith,
    };

    captureSession = session;

    ffmpegProc.on("error", (err: Error) => {
      if (captureSession === session) {
        session.stopping = true;
        if (session.ticker !== null) {
          clearInterval(session.ticker);
          session.ticker = null;
        }
        captureSession = null;
        session.rejectFinalizeWith(new Error(`Capture encode failed: ${err.message}`));
      }
    });

    ffmpegProc.on("close", (code) => {
      session.stopping = true;
      if (session.ticker !== null) {
        clearInterval(session.ticker);
        session.ticker = null;
      }
      if (captureSession === session) {
        captureSession = null;
      }
      if (code === 0) {
        session.resolveFinalizeWith({
          outputPath: session.outputPath,
          frameCount: session.frameCount,
        });
      } else {
        session.rejectFinalizeWith(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    // Start the ticker and capture loop
    session.ticker = setInterval(() => writeFrameToStdin(session), Math.round(1000 / fps));
    startCaptureLoop(session, token);

    return { outputPath };
  };

  const handleStopCapture = async (): Promise<DemoStopCaptureResult> => {
    const promise = stopCaptureSession();
    if (!promise) {
      throw new Error("No capture in progress");
    }
    return promise;
  };

  const handleGetCaptureStatus = async (): Promise<DemoCaptureStatus> => {
    return {
      active: captureSession !== null && !captureSession.stopping,
      frameCount: captureSession?.frameCount ?? 0,
      outputPath: captureSession?.outputPath ?? null,
    };
  };

  // --- Encode presets for live capture (raw BGRA stdin → output file) ---

  const CAPTURE_PRESETS: Record<DemoEncodePreset, { outputOptions: string[] }> = {
    "youtube-4k": {
      outputOptions: [
        "-vf",
        "scale=3840:2160:flags=lanczos",
        "-c:v",
        "libx264",
        "-profile:v",
        "high444",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv444p",
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
        "-vf",
        "scale=1920:1080:flags=lanczos",
        "-c:v",
        "libx264",
        "-profile:v",
        "high444",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv444p",
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
        "20",
        "-b:v",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "1",
        "-row-mt",
        "1",
        "-pix_fmt",
        "yuv444p",
        "-an",
      ],
    },
  };

  // --- Encode presets for offline re-encode (PNG files from disk) ---

  const ENCODE_PRESETS = {
    "youtube-4k": {
      outputOptions: [
        "-vf",
        "scale=3840:2160:flags=lanczos",
        "-c:v",
        "libx264",
        "-profile:v",
        "high444",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv444p",
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
        "-vf",
        "scale=1920:1080:flags=lanczos",
        "-c:v",
        "libx264",
        "-profile:v",
        "high444",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv444p",
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
        "20",
        "-b:v",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "1",
        "-row-mt",
        "1",
        "-pix_fmt",
        "yuv444p",
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

    const framePattern = /^frame-\d{6}\.png$/;
    const pngFiles = fs
      .readdirSync(framesDir)
      .filter((f) => framePattern.test(f))
      .sort();
    if (pngFiles.length === 0) {
      throw new Error(`No PNG frames matching frame-NNNNNN.png found in ${framesDir}`);
    }
    const totalFrames = pngFiles.length;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const startTime = Date.now();
    const inputPattern = path.join(framesDir, "frame-%06d.png");

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
  ipcMain.handle(CHANNELS.DEMO_SCROLL, handleScroll);
  ipcMain.handle(CHANNELS.DEMO_DRAG, handleDrag);
  ipcMain.handle(CHANNELS.DEMO_PRESS_KEY, handlePressKey);
  ipcMain.handle(CHANNELS.DEMO_SPOTLIGHT, handleSpotlight);
  ipcMain.handle(CHANNELS.DEMO_DISMISS_SPOTLIGHT, handleDismissSpotlight);
  ipcMain.handle(CHANNELS.DEMO_ANNOTATE, handleAnnotate);
  ipcMain.handle(CHANNELS.DEMO_DISMISS_ANNOTATION, handleDismissAnnotation);
  ipcMain.handle(CHANNELS.DEMO_WAIT_FOR_IDLE, handleWaitForIdle);
  ipcMain.handle(CHANNELS.DEMO_START_CAPTURE, handleStartCapture);
  ipcMain.handle(CHANNELS.DEMO_STOP_CAPTURE, handleStopCapture);
  ipcMain.handle(CHANNELS.DEMO_GET_CAPTURE_STATUS, handleGetCaptureStatus);
  ipcMain.handle(CHANNELS.DEMO_ENCODE, handleEncode);

  return () => {
    if (captureSession) {
      stopCaptureSession();
      captureSession?.ffmpegProc.kill("SIGKILL");
    }
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
    ipcMain.removeHandler(CHANNELS.DEMO_SCROLL);
    ipcMain.removeHandler(CHANNELS.DEMO_DRAG);
    ipcMain.removeHandler(CHANNELS.DEMO_PRESS_KEY);
    ipcMain.removeHandler(CHANNELS.DEMO_SPOTLIGHT);
    ipcMain.removeHandler(CHANNELS.DEMO_DISMISS_SPOTLIGHT);
    ipcMain.removeHandler(CHANNELS.DEMO_ANNOTATE);
    ipcMain.removeHandler(CHANNELS.DEMO_DISMISS_ANNOTATION);
    ipcMain.removeHandler(CHANNELS.DEMO_WAIT_FOR_IDLE);
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
