import crypto from "node:crypto";
import path from "node:path";
import type {
  AnswerHostPickPayload,
  FileTransferEvent,
} from "../../../shared/types/ipc/fileTransfer.js";
import type { HostPickRequest } from "../../../shared/types/ipc/hostFiles.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * Asks a remote window's view to show Daintree's host picker and waits for its
 * answer. The native dialog would browse this machine; the view browses the
 * host through the host-files namespace and answers with host paths.
 *
 * An answer is only taken from the view that was asked, and a view that goes
 * away answers "dismissed".
 */

export interface HostPickerBridgeDeps {
  send(webContentsId: number, event: FileTransferEvent): boolean;
  /** Call `onGone` once when the view is destroyed; returns an unsubscribe. */
  watch(webContentsId: number, onGone: () => void): () => void;
}

interface PendingPick {
  webContentsId: number;
  resolve(paths: string[] | null): void;
}

const MAX_PICKED_PATHS = 1_000;
const MAX_PATH_LENGTH = 4_096;

function validPaths(paths: unknown): string[] | null {
  if (paths === null) return null;
  if (!Array.isArray(paths) || paths.length > MAX_PICKED_PATHS) {
    throw new AppError({ code: "VALIDATION", message: "Invalid picker answer" });
  }
  for (const candidate of paths) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_PATH_LENGTH ||
      candidate.includes("\0") ||
      !path.posix.isAbsolute(candidate)
    ) {
      throw new AppError({
        code: "VALIDATION",
        message: "Picked paths must be absolute host paths",
      });
    }
  }
  return paths as string[];
}

export class HostPickerBridge {
  private readonly pending = new Map<string, PendingPick>();

  constructor(private readonly deps: HostPickerBridgeDeps) {}

  pick(webContentsId: number, request: HostPickRequest): Promise<string[] | null> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let unwatch: () => void = () => {};
      const settle = (paths: string[] | null) => {
        if (!this.pending.delete(requestId)) return;
        unwatch();
        resolve(paths);
      };
      this.pending.set(requestId, { webContentsId, resolve: settle });
      unwatch = this.deps.watch(webContentsId, () => settle(null));
      if (!this.deps.send(webContentsId, { type: "host-pick-request", requestId, request })) {
        settle(null);
      }
    });
  }

  answer(webContentsId: number, payload: AnswerHostPickPayload): void {
    const requestId = payload?.requestId;
    const entry = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (!entry || entry.webContentsId !== webContentsId) {
      throw new AppError({ code: "VALIDATION", message: "No picker is waiting on this view" });
    }
    entry.resolve(validPaths(payload.paths));
  }

  /** Every open picker resolves as dismissed. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.resolve(null);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
