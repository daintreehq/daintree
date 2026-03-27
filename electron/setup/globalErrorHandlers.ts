import { app } from "electron";
import { emergencyLogMainFatal } from "../utils/emergencyLog.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { getCrashLoopGuard } from "../services/CrashLoopGuardService.js";
import { getMainWindow } from "../window/windowRef.js";
import { CHANNELS } from "../ipc/channels.js";
import { store } from "../store.js";
import type { AppError } from "../../shared/types/ipc/errors.js";

let handlingFatal = false;

/** @internal Reset re-entrancy guard for testing only. */
export function _resetHandlingFatalForTesting(): void {
  handlingFatal = false;
}

function buildFatalAppError(kind: string, error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const id = `fatal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    timestamp: Date.now(),
    type: "unknown",
    message: `[${kind}] ${message}`,
    details: error instanceof Error ? error.stack : undefined,
    source: "main-process",
    isTransient: false,
    dismissed: false,
    recoveryHint:
      kind === "UNCAUGHT_EXCEPTION"
        ? "The application encountered a fatal error and will restart."
        : "An unhandled promise rejection occurred. The application may be in a degraded state.",
  };
}

function notifyRenderer(appError: AppError): void {
  try {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(CHANNELS.ERROR_NOTIFY, appError);
    }
  } catch {
    // best-effort only
  }
}

function persistPendingError(appError: AppError): void {
  try {
    const existing = store.get("pendingErrors");
    const pending = Array.isArray(existing) ? existing : [];
    store.set("pendingErrors", [...pending, { ...appError, fromPreviousSession: true }]);
  } catch {
    // best-effort only
  }
}

export function registerGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error: Error) => {
    if (handlingFatal) {
      try {
        app.exit(1);
      } catch {
        process.exit(1);
      }
      return;
    }
    handlingFatal = true;

    console.error("[FATAL] Uncaught Exception:", error);

    try {
      emergencyLogMainFatal("UNCAUGHT_EXCEPTION", error);
    } catch {
      // silent
    }

    try {
      getCrashRecoveryService().recordCrash(error);
    } catch {
      // silent
    }

    const appError = buildFatalAppError("UNCAUGHT_EXCEPTION", error);

    try {
      persistPendingError(appError);
    } catch {
      // silent
    }

    try {
      notifyRenderer(appError);
    } catch {
      // silent
    }

    try {
      if (getCrashLoopGuard().shouldRelaunch()) {
        app.relaunch();
      } else {
        console.error("[FATAL] Crash loop hard stop reached — not relaunching");
      }
    } catch {
      // silent
    }

    try {
      app.exit(1);
    } catch {
      process.exit(1);
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[FATAL] Unhandled Promise Rejection:", reason);

    try {
      emergencyLogMainFatal("UNHANDLED_REJECTION", reason);
    } catch {
      // silent
    }

    const appError = buildFatalAppError("UNHANDLED_REJECTION", reason);

    try {
      notifyRenderer(appError);
    } catch {
      // silent
    }
  });
}
