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
  DemoScrollPayload,
  DemoDragPayload,
  DemoPressKeyPayload,
  DemoSpotlightPayload,
  DemoAnnotatePayload,
  DemoAnnotateResult,
  DemoDismissAnnotationPayload,
  DemoWaitForIdlePayload,
} from "../../../shared/types/ipc/demo.js";

// Maximum capture duration before we force-stop. MediaRecorder exposes no
// intrinsic limit, so we apply one to prevent a forgotten recording from
// filling the disk.
const CAPTURE_MAX_DURATION_MS = 10 * 60 * 1000;

// Secondary timer: if the renderer never finalizes after stop, we destroy the
// stream and reject so the IPC call doesn't hang forever.
const CAPTURE_FINALIZE_TIMEOUT_MS = 30 * 1000;

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

  // --- Frame capture state (renderer-driven getDisplayMedia + MediaRecorder) ---
  //
  // Lifecycle:
  //   1. handleStartCapture: register setDisplayMediaRequestHandler on session,
  //      open output WriteStream, wire DEMO_CAPTURE_CHUNK / DEMO_CAPTURE_FINISHED
  //      listeners, send DEMO_CAPTURE_START to renderer.
  //   2. Renderer calls getDisplayMedia, pipes MediaRecorder chunks via
  //      ipcRenderer.postMessage (zero-copy ArrayBuffer transfer).
  //   3. handleStopCapture: send DEMO_CAPTURE_STOP; finalizePromise resolves only
  //      after the renderer's onstop fires and sends DEMO_CAPTURE_FINISHED — this
  //      preserves the W3C-guaranteed ordering and avoids truncating the output.

  interface CaptureSession {
    captureId: string;
    outputPath: string;
    fps: number;
    fileStream: fs.WriteStream;
    stopping: boolean;
    finalized: boolean;
    finalizePromise: Promise<DemoStopCaptureResult>;
    resolveFinalizeWith: (result: DemoStopCaptureResult) => void;
    rejectFinalizeWith: (err: Error) => void;
    safetyTimer: ReturnType<typeof setTimeout> | null;
    finalizeTimer: ReturnType<typeof setTimeout> | null;
    chunkListener: (
      event: Electron.IpcMainEvent,
      msg: { captureId: string } | undefined,
      ...rest: unknown[]
    ) => void;
    finishListener: (event: Electron.IpcMainEvent, msg: { captureId: string }) => void;
    sessionRef: Electron.Session | null;
    handlerRegistered: boolean;
  }

  let captureSession: CaptureSession | null = null;

  function getCaptureSession(): Electron.Session | null {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const wc = getAppWebContents(win);
    if (wc.isDestroyed()) return null;
    return wc.session;
  }

  function sendToApp(channel: string, payload?: unknown): boolean {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    const wc = getAppWebContents(win);
    if (wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  }

  function clearCaptureListeners(session: CaptureSession): void {
    ipcMain.removeListener(CHANNELS.DEMO_CAPTURE_CHUNK, session.chunkListener);
    ipcMain.removeListener(CHANNELS.DEMO_CAPTURE_FINISHED, session.finishListener);
  }

  function clearCaptureTimers(session: CaptureSession): void {
    if (session.safetyTimer !== null) {
      clearTimeout(session.safetyTimer);
      session.safetyTimer = null;
    }
    if (session.finalizeTimer !== null) {
      clearTimeout(session.finalizeTimer);
      session.finalizeTimer = null;
    }
  }

  function clearDisplayMediaHandler(session: CaptureSession): void {
    if (!session.handlerRegistered || !session.sessionRef) return;
    try {
      // Clearing with null unregisters the handler so getDisplayMedia
      // falls back to the platform default outside demo mode.
      session.sessionRef.setDisplayMediaRequestHandler(null);
    } catch {
      // Best-effort cleanup — session may already be torn down.
    }
    session.handlerRegistered = false;
  }

  function finalizeCaptureSession(session: CaptureSession, result: DemoStopCaptureResult): void {
    if (session.finalized) return;
    session.finalized = true;
    clearCaptureTimers(session);
    clearCaptureListeners(session);
    clearDisplayMediaHandler(session);
    if (captureSession === session) {
      captureSession = null;
    }
    session.resolveFinalizeWith(result);
  }

  function failCaptureSession(session: CaptureSession, err: Error): void {
    if (session.finalized) return;
    session.finalized = true;
    clearCaptureTimers(session);
    clearCaptureListeners(session);
    clearDisplayMediaHandler(session);
    if (!session.fileStream.destroyed) {
      session.fileStream.destroy();
    }
    if (captureSession === session) {
      captureSession = null;
    }
    session.rejectFinalizeWith(err);
  }

  function beginStopCapture(session: CaptureSession): void {
    if (session.stopping) return;
    session.stopping = true;
    if (session.safetyTimer !== null) {
      clearTimeout(session.safetyTimer);
      session.safetyTimer = null;
    }
    // Send the stop signal to the renderer. The renderer must call
    // mediaRecorder.stop(), let the final ondataavailable fire, then send
    // DEMO_CAPTURE_FINISHED from within onstop.
    sendToApp(CHANNELS.DEMO_CAPTURE_STOP, { captureId: session.captureId });
    // Secondary guard: if the renderer crashed or never finalizes, reject
    // the IPC call so callers don't hang.
    session.finalizeTimer = setTimeout(() => {
      failCaptureSession(session, new Error("Capture finalize timed out waiting for renderer"));
    }, CAPTURE_FINALIZE_TIMEOUT_MS);
  }

  const handleStartCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DemoStartCapturePayload
  ): Promise<DemoStartCaptureResult> => {
    if (captureSession) {
      throw new Error("Capture already in progress");
    }

    const fps = payload.fps ?? 30;
    const { outputPath } = payload;

    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      throw new Error("No window available for capture");
    }

    const rendererSession = getCaptureSession();
    if (!rendererSession) {
      throw new Error("No session available for capture");
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const fileStream = fs.createWriteStream(outputPath);

    const captureId = randomBytes(8).toString("hex");

    let resolveFinalizeWith!: (result: DemoStopCaptureResult) => void;
    let rejectFinalizeWith!: (err: Error) => void;
    const finalizePromise = new Promise<DemoStopCaptureResult>((resolve, reject) => {
      resolveFinalizeWith = resolve;
      rejectFinalizeWith = reject;
    });
    // Attach a no-op handler so an abort during cleanup (before anyone calls
    // stopCapture) doesn't trigger an unhandled rejection warning. Real
    // awaiters still observe the rejection through their own .then/.catch.
    finalizePromise.catch(() => {});

    const chunkListener = (
      _event: Electron.IpcMainEvent,
      msg: { captureId: string } | undefined,
      ...rest: unknown[]
    ): void => {
      const session = captureSession;
      if (!session || session.finalized) return;
      if (!msg || msg.captureId !== session.captureId) return;
      // When using ipcRenderer.postMessage the transferred ArrayBuffer
      // arrives as an additional argument after the message payload.
      const transferred = rest.find((arg) => arg instanceof ArrayBuffer) as ArrayBuffer | undefined;
      if (!transferred || transferred.byteLength === 0) return;
      if (session.fileStream.destroyed) return;
      // Buffer.from(arrayBuffer) returns a view, not a copy — safe because the
      // chunk originated on the browser heap (blob.arrayBuffer()), not from a
      // Node.js slab. See PR #4639.
      session.fileStream.write(Buffer.from(transferred));
    };

    const finishListener = (_event: Electron.IpcMainEvent, msg: { captureId: string }): void => {
      const session = captureSession;
      if (!session || session.finalized) return;
      if (!msg || msg.captureId !== session.captureId) return;
      // End the stream and resolve once it flushes. 'error' rejects; 'finish'
      // resolves with the frameCount-stub (MediaRecorder has no frame count).
      session.fileStream.once("error", (err) => {
        failCaptureSession(session, err);
      });
      session.fileStream.once("finish", () => {
        finalizeCaptureSession(session, {
          outputPath: session.outputPath,
          frameCount: 0,
        });
      });
      session.fileStream.end();
    };

    const session: CaptureSession = {
      captureId,
      outputPath,
      fps,
      fileStream,
      stopping: false,
      finalized: false,
      finalizePromise,
      resolveFinalizeWith,
      rejectFinalizeWith,
      safetyTimer: null,
      finalizeTimer: null,
      chunkListener,
      finishListener,
      sessionRef: rendererSession,
      handlerRegistered: false,
    };

    fileStream.on("error", (err: Error) => {
      if (captureSession === session) {
        failCaptureSession(session, new Error(`Capture file stream error: ${err.message}`));
      }
    });

    ipcMain.on(CHANNELS.DEMO_CAPTURE_CHUNK, chunkListener);
    ipcMain.on(CHANNELS.DEMO_CAPTURE_FINISHED, finishListener);

    // Auto-approve getDisplayMedia by pointing it at the requesting frame.
    // useSystemPicker: false ensures our handler is always invoked (no native
    // picker dialog).
    rendererSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // Always call callback exactly once — otherwise getDisplayMedia hangs.
        try {
          if (request.frame) {
            callback({ video: request.frame });
          } else {
            // No frame to capture — deny by passing an empty response.
            callback({});
          }
        } catch {
          callback({});
        }
      },
      { useSystemPicker: false }
    );
    session.handlerRegistered = true;

    captureSession = session;

    // Safety timeout — force-stop if capture runs longer than
    // CAPTURE_MAX_DURATION_MS (e.g., if stopCapture is never called).
    session.safetyTimer = setTimeout(() => {
      if (!session.finalized && !session.stopping) {
        beginStopCapture(session);
      }
    }, CAPTURE_MAX_DURATION_MS);

    if (!sendToApp(CHANNELS.DEMO_CAPTURE_START, { captureId, fps })) {
      failCaptureSession(session, new Error("No window available to start capture"));
      throw new Error("No window available to start capture");
    }

    return { outputPath };
  };

  const handleStopCapture = async (): Promise<DemoStopCaptureResult> => {
    const session = captureSession;
    if (!session) {
      throw new Error("No capture in progress");
    }
    beginStopCapture(session);
    return session.finalizePromise;
  };

  const handleGetCaptureStatus = async (): Promise<DemoCaptureStatus> => {
    return {
      active: captureSession !== null && !captureSession.stopping,
      frameCount: 0,
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
    if (captureSession) {
      failCaptureSession(captureSession, new Error("Capture aborted: handlers cleaned up"));
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
