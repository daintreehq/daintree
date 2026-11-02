import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  getWebContentsForProject,
  isCachedViewWebContents,
} from "../../window/webContentsRegistry.js";
import { peekDriveLeaseService } from "../DriveLeaseService.js";
import { events } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import type { PtyIncarnationExit, PtyIncarnationLost } from "../PtyClient.js";
import { getLifecycleLedger } from "../pty/lifecycleLedger.js";
import {
  closeTerminalKeepingSession,
  sendToLocalProjectViews,
} from "../pty/terminalDoneOperations.js";
import {
  backgroundViewlessTerminal,
  forgetViewlessTerminal,
} from "../viewless/projectStateAuthoring.js";
import type {
  TerminalWhenDoneFinishRequest,
  TerminalWhenDoneInUseQuery,
} from "../../../shared/types/ipc/terminalWhenDone.js";
import {
  TerminalWhenDone,
  type ArmedTerminal,
  type WhenDoneIncarnation,
  type WhenDoneOutcome,
} from "./TerminalWhenDone.js";

/** A view that hasn't answered by then is treated as someone using the pane. */
export const IN_USE_ANSWER_TIMEOUT_MS = 2_000;

/**
 * Whether one view says someone is using the pane. Null when it can't say: it
 * is loading, gone, or silent.
 */
function askViewInUse(wc: Electron.WebContents, terminalId: string): Promise<boolean | null> {
  if (wc.isDestroyed() || wc.isLoadingMainFrame()) return Promise.resolve(null);
  const requestId = randomUUID();
  return new Promise<boolean | null>((resolve) => {
    let settled = false;
    const settle = (answer: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(CHANNELS.TERMINAL_WHEN_DONE_IN_USE_REPLY, onReply);
      if (!wc.isDestroyed()) {
        wc.removeListener("destroyed", onGone);
        wc.removeListener("render-process-gone", onGone);
      }
      resolve(answer);
    };
    const onReply = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (event.sender !== wc) return;
      const reply = payload as { requestId?: unknown; inUse?: unknown } | null;
      if (reply?.requestId !== requestId) return;
      settle(typeof reply.inUse === "boolean" ? reply.inUse : null);
    };
    const onGone = () => settle(null);
    const timer = setTimeout(() => settle(null), IN_USE_ANSWER_TIMEOUT_MS);
    ipcMain.on(CHANNELS.TERMINAL_WHEN_DONE_IN_USE_REPLY, onReply);
    wc.once("destroyed", onGone);
    wc.once("render-process-gone", onGone);
    const query: TerminalWhenDoneInUseQuery = { requestId, terminalId };
    try {
      wc.send(CHANNELS.TERMINAL_WHEN_DONE_IN_USE_QUERY, query);
    } catch {
      settle(null);
    }
  });
}

/**
 * Whether anyone may be using the pane right now, so it must stay where it
 * is. A person at another machine's Shell driving the project counts, and so
 * does every view on screen that doesn't answer a clear no; a cached view is
 * off screen, so nobody is using a pane in it.
 */
export async function isTerminalPaneInUse(projectId: string, terminalId: string): Promise<boolean> {
  if (peekDriveLeaseService()?.getHolderEndpoint(projectId)?.kind === "remote-view") return true;
  const views = getWebContentsForProject(projectId).filter(
    (wc) => !wc.isDestroyed() && !isCachedViewWebContents(wc.id)
  );
  const answers = await Promise.all(views.map((wc) => askViewInUse(wc, terminalId)));
  return answers.some((answer) => answer !== false);
}

function askViews(target: ArmedTerminal, action: TerminalWhenDoneFinishRequest["action"]): void {
  const request: TerminalWhenDoneFinishRequest = { terminalId: target.terminalId, action };
  sendToLocalProjectViews(target.projectId, CHANNELS.TERMINAL_WHEN_DONE_FINISH_REQUEST, request);
}

/**
 * Background matches a scheduled run's: each view moves the pane, and the
 * saved layout parks it for a view that holds none. Close is a scheduled run's
 * close, the session captured for resuming, then the pane goes.
 */
async function applyWhenDone(target: ArmedTerminal): Promise<WhenDoneOutcome> {
  if (await isTerminalPaneInUse(target.projectId, target.terminalId)) return "in-use";
  if (target.choice === "background") {
    askViews(target, "background");
    await backgroundViewlessTerminal(projectStore, target.projectId, target.terminalId);
    return "applied";
  }
  const closed = await closeTerminalKeepingSession(
    { terminalId: target.terminalId, spawnedAt: target.spawnedAt },
    "when-done-close"
  );
  if (!closed) return "not-applied";
  askViews(target, "remove");
  await forgetViewlessTerminal(projectStore, target.projectId, target.terminalId);
  return "applied";
}

async function readIncarnation(terminalId: string): Promise<WhenDoneIncarnation | null> {
  const info = await getPtyClient()
    ?.getTerminalAsync(terminalId)
    .catch(() => null);
  if (!info || !info.projectId) return null;
  if (info.hasPty === false || info.isExited === true || info.isAssistantTerminal === true) {
    return null;
  }
  // Only an agent can answer the instruction; a shell would run it.
  const hasAgent = info.detectedAgentId !== undefined || info.launchAgentId !== undefined;
  if (!hasAgent || info.agentState === "exited") return null;
  return {
    projectId: info.projectId,
    spawnedAt: info.spawnedAt,
    launchGeneration: info.launchGeneration ?? getLifecycleLedger().currentGeneration(terminalId),
  };
}

let service: TerminalWhenDone | null = null;
let stopListening: (() => void) | null = null;

/**
 * Follows the facts the armed terminals act on, only while one is armed:
 * vanilla Daintree pays nothing. The submit decorator goes on the PtyClient
 * for the same span.
 */
function startListening(target: TerminalWhenDone): void {
  if (stopListening) return;
  const ptyClient = getPtyClient();
  const offReport = events.on("agent:run-handback-observed", (payload) =>
    target.handleReport(payload)
  );
  const offAgentExit = events.on("agent:exited", (payload) => target.handleExit(payload.terminalId));
  const onExit = (fact: PtyIncarnationExit) => target.handleExit(fact.terminalId, fact.spawnedAt);
  const onLost = (fact: PtyIncarnationLost) =>
    target.handleIncarnationLost(fact.terminalId, fact.launchGeneration);
  const onTerminalLost = (id: string) => target.handleExit(id);
  ptyClient?.on("incarnation-exit", onExit);
  ptyClient?.on("incarnation-lost", onLost);
  ptyClient?.on("terminal-lost", onTerminalLost);
  ptyClient?.setSubmitDecorator((id, text, code) => target.decorate(id, text, code));
  stopListening = () => {
    offReport();
    offAgentExit();
    ptyClient?.off("incarnation-exit", onExit);
    ptyClient?.off("incarnation-lost", onLost);
    ptyClient?.off("terminal-lost", onTerminalLost);
    ptyClient?.setSubmitDecorator(null);
  };
}

export function getTerminalWhenDone(): TerminalWhenDone {
  if (service) return service;
  const created: TerminalWhenDone = new TerminalWhenDone({
    readIncarnation,
    currentGeneration: (terminalId) => getLifecycleLedger().currentGeneration(terminalId),
    submitInstruction: (terminalId, text, code) =>
      getPtyClient()?.submit(terminalId, text, undefined, code, undefined, undefined, null, "run"),
    notify: (projectId, change) =>
      broadcastToProjectRenderers(projectId, CHANNELS.TERMINAL_WHEN_DONE_CHANGED, change),
    apply: applyWhenDone,
    isShuttingDown: () => getActiveShutdown() !== null,
    onActiveChange: (active) => {
      if (active) {
        startListening(created);
        return;
      }
      stopListening?.();
      stopListening = null;
    },
  });
  service = created;
  return created;
}

/** The service if anything has used it, for readers that must not create it. */
export function peekTerminalWhenDone(): TerminalWhenDone | null {
  return service;
}

/** @internal Tests only. */
export function _resetTerminalWhenDoneForTest(): void {
  stopListening?.();
  stopListening = null;
  service = null;
}
