import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { ScheduledLaunchViewRequest } from "../../../shared/types/ipc/schedules.js";
import {
  ScheduledLaunchUnansweredError,
  type ScheduledLaunchRequest,
} from "./ScheduledRunLauncher.js";

/**
 * Main asks the view showing a project to launch a scheduled run (#15978):
 * the view dispatches `agent.launch` with the run as host-stamped provenance,
 * so the pane lands in its grid and its own persistence saves it. Not the MCP
 * bridge: a scheduled run's provenance is no capability an MCP dispatch gets.
 */

/** Long enough for a launch that waits on its presets or a CLI probe. */
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;

interface PendingLaunch {
  readonly webContentsId: number;
  readonly resolve: (result: ActionDispatchResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly unwatch: () => void;
}

const pendingLaunches = new Map<string, PendingLaunch>();
let removeListener: (() => void) | null = null;

function take(requestId: string): PendingLaunch | null {
  const entry = pendingLaunches.get(requestId);
  if (!entry) return null;
  pendingLaunches.delete(requestId);
  clearTimeout(entry.timer);
  entry.unwatch();
  return entry;
}

/** The view's answer as an `ActionDispatchResult`, or a failure naming it unreadable. */
function readAnswer(value: unknown): ActionDispatchResult {
  if (typeof value === "object" && value !== null) {
    const ok: unknown = Reflect.get(value, "ok");
    if (ok === true) return { ok: true, result: Reflect.get(value, "result") };
    const error: unknown = Reflect.get(value, "error");
    if (ok === false && typeof error === "object" && error !== null) {
      const message: unknown = Reflect.get(error, "message");
      if (typeof message === "string") {
        return { ok: false, error: { code: "EXECUTION_ERROR", message } };
      }
    }
  }
  return {
    ok: false,
    error: { code: "EXECUTION_ERROR", message: "The window answered the launch unreadably." },
  };
}

function ensureListener(): void {
  if (removeListener) return;
  const handler = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const requestId: unknown = Reflect.get(payload, "requestId");
    if (typeof requestId !== "string") return;
    // Only the view that was asked answers for its request.
    if (pendingLaunches.get(requestId)?.webContentsId !== event.sender.id) return;
    take(requestId)?.resolve(readAnswer(Reflect.get(payload, "result")));
  };
  ipcMain.on(CHANNELS.SCHEDULES_LAUNCH_RESPONSE, handler);
  removeListener = () => ipcMain.removeListener(CHANNELS.SCHEDULES_LAUNCH_RESPONSE, handler);
}

/**
 * Asks `webContents` to launch the run and resolves with `agent.launch`'s
 * result. Rejects with {@link ScheduledLaunchUnansweredError} when the view
 * closes or doesn't answer in time; that says nothing of whether it launched,
 * which only the run's admission at the spawn can tell.
 */
export function requestScheduledLaunchInView(
  webContents: Electron.WebContents,
  request: ScheduledLaunchRequest,
  timeoutMs: number = DEFAULT_ANSWER_TIMEOUT_MS
): Promise<ActionDispatchResult> {
  ensureListener();
  const requestId = randomUUID();
  return new Promise<ActionDispatchResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      take(requestId)?.reject(
        new ScheduledLaunchUnansweredError("The window showing the project didn't answer in time.")
      );
    }, timeoutMs);
    const unwatch = onWebContentsDestroyed(webContents, () => {
      take(requestId)?.reject(
        new ScheduledLaunchUnansweredError("The window showing the project closed.")
      );
    });
    pendingLaunches.set(requestId, {
      webContentsId: webContents.id,
      resolve,
      reject,
      timer,
      unwatch,
    });
    const payload: ScheduledLaunchViewRequest = {
      requestId,
      args: { ...request.args },
      scheduledRun: request.scheduledRun,
    };
    // A cached view may be frozen, and a frozen renderer never answers.
    thawThenSend(
      webContents,
      () => pendingLaunches.has(requestId),
      () => {
        try {
          webContents.send(CHANNELS.SCHEDULES_LAUNCH_REQUEST, payload);
        } catch (error) {
          take(requestId)?.reject(
            new ScheduledLaunchUnansweredError(
              error instanceof Error ? error.message : "The window couldn't be asked."
            )
          );
        }
      }
    );
  });
}

/** @internal Tests only. */
export function _resetScheduledRunViewBridgeForTest(): void {
  for (const requestId of [...pendingLaunches.keys()]) take(requestId);
  removeListener?.();
  removeListener = null;
}
