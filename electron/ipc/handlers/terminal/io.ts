/**
 * Terminal I/O handlers - input, resize, submit, sendKey, acknowledge, forceResume.
 */

import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import {
  distributeTerminalWorkerPortToView,
  releaseTerminalWorkerPort,
} from "../../../window/portDistribution.js";
import type { TerminalResizePayload } from "../../../types/index.js";
import { TerminalResizePayloadSchema } from "../../../schemas/ipc.js";
import type { PtyHostActivityTier } from "../../../../shared/types/pty-host.js";
import { normalizeTerminalGridDimension } from "../../../../shared/types/terminal.js";
import { normalizeObservedTitle } from "../../../../shared/utils/isUselessTitle.js";
import { defineIpcNamespace, op } from "../../define.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";

export function registerTerminalIOHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  const handleTerminalInput = (_event: Electron.IpcMainEvent, id: string, data: string) => {
    try {
      if (typeof id !== "string" || typeof data !== "string") {
        console.error("Invalid terminal input parameters");
        return;
      }
      ptyClient.write(id, data);
    } catch (error) {
      console.error("Error writing to terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_INPUT, handleTerminalInput);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_INPUT, handleTerminalInput));

  const handleTerminalSendKey = (_event: Electron.IpcMainEvent, id: string, key: string) => {
    try {
      if (typeof id !== "string" || typeof key !== "string") {
        console.error("Invalid terminal sendKey parameters");
        return;
      }
      ptyClient.sendKey(id, key);
    } catch (error) {
      console.error("Error sending key to terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SEND_KEY, handleTerminalSendKey);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_SEND_KEY, handleTerminalSendKey));

  const handleTerminalBatchDoubleEscape = (_event: Electron.IpcMainEvent, ids: unknown) => {
    try {
      if (!Array.isArray(ids)) {
        console.error("Invalid terminal batchDoubleEscape parameters: expected string[]");
        return;
      }
      const validIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (validIds.length === 0) return;
      ptyClient.batchDoubleEscape(validIds);
    } catch (error) {
      console.error("Error sending batch double escape to terminals:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, handleTerminalBatchDoubleEscape);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, handleTerminalBatchDoubleEscape)
  );

  const handleTerminalBroadcastWrite = (
    _event: Electron.IpcMainEvent,
    ids: unknown,
    data: unknown
  ) => {
    try {
      if (!Array.isArray(ids) || typeof data !== "string") {
        console.error("Invalid terminal broadcastWrite parameters");
        return;
      }
      const validIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (validIds.length === 0 || data.length === 0) return;
      ptyClient.broadcastWrite(validIds, data);
    } catch (error) {
      console.error("Error broadcasting write to terminals:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_BROADCAST_WRITE, handleTerminalBroadcastWrite);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_BROADCAST_WRITE, handleTerminalBroadcastWrite)
  );

  const handleTerminalSubmit = async (id: string, text: string): Promise<void> => {
    try {
      if (typeof id !== "string" || typeof text !== "string") {
        throw new Error("Invalid terminal submit parameters");
      }
      // PtyClient.submit is fire-and-forget — the pty-host silently no-ops
      // a write to a terminal that's gone or has already exited (see
      // `PtyManager.submit` / `TerminalProcess.submit`). That left structured
      // fleet broadcast (`fleetExecution.executeFleetBroadcast`) seeing all
      // submits as fulfilled and never disarming dead PTYs (#8706). Probe
      // liveness here so the renderer gets an actual rejection it can
      // classify and act on. Errno tokens (`EBADF`, `EPIPE`) lead the
      // message so the renderer can match them via
      // `classifyFleetRejectionReason` — Electron's structured-clone error
      // serialization strips `.code` from `NodeJS.ErrnoException`, so the
      // code MUST live in the message text to survive the IPC boundary.
      // `getTerminalAsync` returns null both when the terminal genuinely
      // doesn't exist (the case we want to surface to fleet broadcast) and
      // when the broker rejects from a host crash / timeout (see
      // `PtyClient.getTerminalAsync`'s `.catch(() => null)`). During a host
      // restart that means every concurrent fleet submit briefly classifies
      // as permanent and disarms the whole fleet — annoying but recoverable
      // by re-arming. Splitting the two cases would need a new PtyClient
      // method that propagates broker errors; out of scope for #8706. The
      // pre-fix behavior had the opposite failure mode (kept firing into
      // dead pipes), so this trade is a net win for the common case.
      const info = await ptyClient.getTerminalAsync(id);
      if (!info) {
        throw new AppError({
          code: "NOT_FOUND",
          message: `EBADF: terminal ${id} not found`,
          context: { terminalId: id },
        });
      }
      if (info.hasPty === false) {
        throw new AppError({
          code: "NOT_FOUND",
          message: `EPIPE: terminal ${id} has no live PTY (exited)`,
          context: { terminalId: id },
        });
      }
      ptyClient.submit(id, text);
    } catch (error) {
      // Preserve AppError shape so the renderer sees the embedded errno
      // token in the message — wrapping would lose the prefix.
      if (error instanceof AppError) throw error;
      const errorMessage = formatErrorMessage(error, "Failed to submit to terminal");
      throw new Error(`Failed to submit to terminal: ${errorMessage}`);
    }
  };

  const handleTerminalResize = (_event: Electron.IpcMainEvent, payload: TerminalResizePayload) => {
    try {
      const parseResult = TerminalResizePayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        console.error("[IPC] Invalid terminal resize payload:", z.prettifyError(parseResult.error));
        return;
      }

      const { id, cols, rows } = parseResult.data;
      // Defensive backstop at the shared ceiling. The renderer already
      // normalized to the same bound before choosing a transport, so this
      // agrees with what the MessagePort path (which bypasses Main entirely)
      // delivers rather than imposing a second, lower limit.
      ptyClient.resize(
        id,
        normalizeTerminalGridDimension(cols),
        normalizeTerminalGridDimension(rows)
      );
    } catch (error) {
      console.error("Error resizing terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_RESIZE, handleTerminalResize);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_RESIZE, handleTerminalResize));

  const handleTerminalSetActivityTier = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; tier: PtyHostActivityTier; pollingIntervalMs?: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { id, tier, pollingIntervalMs } = payload;
      if (typeof id !== "string" || !id) return;
      const effectiveTier: PtyHostActivityTier = tier === "background" ? "background" : "active";
      // The renderer may send a cadence hint (issue #8596 — 200ms for VISIBLE-
      // unfocused). Guard against malformed values; the PTY host falls back to
      // the tier default when the field is missing or invalid.
      const effectivePollingMs =
        typeof pollingIntervalMs === "number" &&
        Number.isFinite(pollingIntervalMs) &&
        pollingIntervalMs > 0
          ? pollingIntervalMs
          : undefined;
      ptyClient.setActivityTier(id, effectiveTier, effectivePollingMs);
    } catch (error) {
      console.error("[IPC] Failed to set activity tier:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier)
  );

  const handleTerminalSetFocused = (
    event: Electron.IpcMainEvent,
    payload: { id: string | null }
  ) => {
    try {
      if (!payload || typeof payload !== "object") return;
      const { id } = payload;
      if (id !== null && (typeof id !== "string" || !id)) return;
      // Focus is inherently per-window: resolve the owning window from the
      // sender's webContents (works for WebContentsView project views, not just
      // the top-level BrowserWindow). Without a resolvable window the signal is
      // dropped — it's a soft prioritization hint, so the host behaves as before.
      const windowId = deps.windowRegistry?.getByWebContentsId(event.sender.id)?.windowId;
      if (typeof windowId !== "number") return;
      ptyClient.setFocusedTerminal(windowId, id);
    } catch (error) {
      console.error("[IPC] Failed to set focused terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SET_FOCUSED, handleTerminalSetFocused);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_SET_FOCUSED, handleTerminalSetFocused)
  );

  const handleTerminalAcknowledgeData = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; length: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      if (typeof payload.id !== "string" || typeof payload.length !== "number") {
        return;
      }
      ptyClient.acknowledgeData(payload.id, payload.length);
    } catch (error) {
      console.error("Error acknowledging terminal data:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData)
  );

  const handleTerminalAgentTitleState = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; state: string }
  ) => {
    try {
      if (!payload || typeof payload !== "object") return;
      const { id, state } = payload;
      if (typeof id !== "string" || !id) return;
      if (state !== "working" && state !== "waiting") return;

      const event = state === "working" ? { type: "busy" } : { type: "prompt" };
      ptyClient.transitionState(id, event, "title", 0.98);
    } catch (error) {
      console.error("[IPC] Error handling agent title state:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_AGENT_TITLE_STATE, handleTerminalAgentTitleState);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_AGENT_TITLE_STATE, handleTerminalAgentTitleState)
  );

  const handleTerminalUpdateObservedTitle = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; title: string }
  ) => {
    try {
      if (!payload || typeof payload !== "object") return;
      const { id, title } = payload;
      if (typeof id !== "string" || !id) return;
      const normalized = normalizeObservedTitle(title);
      if (!normalized) return;
      ptyClient.updateObservedTitle(id, normalized);
    } catch (error) {
      console.error("[IPC] Error handling observed title update:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_UPDATE_OBSERVED_TITLE, handleTerminalUpdateObservedTitle);
  handlers.push(() =>
    ipcMain.removeListener(
      CHANNELS.TERMINAL_UPDATE_OBSERVED_TITLE,
      handleTerminalUpdateObservedTitle
    )
  );

  const handleTerminalForceResume = async (id: string): Promise<void> => {
    if (typeof id !== "string" || !id) {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid terminal ID: must be a non-empty string",
      });
    }
    try {
      ptyClient.forceResume(id);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to force resume terminal");
      console.error(`[IPC] Failed to force resume terminal ${id}:`, errorMessage);
      throw new AppError({
        code: "INTERNAL",
        message: errorMessage,
        context: { terminalId: id },
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

  // Dedicated worker-ingest port lifecycle (issue #10960). The invoke returns
  // the handshake token; the port itself arrives on the sender's WebContents
  // via `terminal-worker-port` postMessage — invoke results can't carry
  // transferables.
  const handleTerminalRequestWorkerIngestPort = async (
    ctx: IpcContext,
    id: string
  ): Promise<{ token: string } | null> => {
    if (typeof id !== "string" || !id) {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid terminal ID: must be a non-empty string",
      });
    }
    const win = ctx.senderWindow;
    const wctx = win ? deps.windowRegistry?.getByWindowId(win.id) : undefined;
    if (!win || !wctx) return null;
    // Ownership gate: the terminal's owner must EQUAL the sender's project.
    // Null is an identity here, not a wildcard — the two must still match, so
    // an unbound window (Cmd+N, project picker) still gets a port for its own
    // projectless default terminal, but a null-context sender cannot reach a
    // project-owned terminal. Nothing downstream re-checks this: the pty-host's
    // per-window filter skips windows whose project is null, so a foreign port
    // minted here would be fed for real (#11100).
    //
    // A refusal costs the renderer only its dedicated parse-worker port, not
    // the terminal — LiveWorkerIngest falls back to the shared ingest path.
    const info = await ptyClient.getTerminalAsync(id);
    if (!info) return null;
    if ((info.projectId ?? null) !== ctx.projectId) {
      return null;
    }
    return distributeTerminalWorkerPortToView(win, wctx, ctx.event.sender, ptyClient, id);
  };

  const handleTerminalReleaseWorkerIngestPort = async (
    ctx: IpcContext,
    id: string
  ): Promise<void> => {
    if (typeof id !== "string" || !id) return;
    const win = ctx.senderWindow;
    const wctx = win ? deps.windowRegistry?.getByWindowId(win.id) : undefined;
    if (!wctx) return;
    releaseTerminalWorkerPort(wctx, ptyClient, id);
  };

  const namespace = defineIpcNamespace({
    name: "terminalIo",
    ops: {
      submit: op(CHANNELS.TERMINAL_SUBMIT, handleTerminalSubmit),
      forceResume: op(CHANNELS.TERMINAL_FORCE_RESUME, handleTerminalForceResume),
      requestWorkerIngestPort: op(
        CHANNELS.TERMINAL_REQUEST_WORKER_INGEST_PORT,
        handleTerminalRequestWorkerIngestPort,
        { withContext: true }
      ),
      releaseWorkerIngestPort: op(
        CHANNELS.TERMINAL_RELEASE_WORKER_INGEST_PORT,
        handleTerminalReleaseWorkerIngestPort,
        { withContext: true }
      ),
    },
  });
  handlers.push(namespace.register());

  return () => handlers.forEach((cleanup) => cleanup());
}
