import { ipcMain, session } from "electron";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
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
  DemoEncodePayload,
  DemoEncodeProgressEvent,
  DemoEncodeResult,
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

export function resolveFfmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("ffmpeg-static") as string;
  } catch {
    throw new Error(
      "ffmpeg-static is not installed. Demo video capture is an optional feature — " +
        "run `npm install ffmpeg-static` to enable it."
    );
  }
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

  // --- Frame capture state (MediaRecorder-based) ---
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
