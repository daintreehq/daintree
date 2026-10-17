// Worker-side deadline policy for host calls (#13410). Lives with the worker
// proxy, not in main, so a call still settles when main is the side that has
// stopped answering.

import {
  PLUGIN_HOST_CALL_INTERACTIVE_TIMEOUT_MS,
  PLUGIN_HOST_CALL_SLOW_TIMEOUT_MS,
  PLUGIN_HOST_CALL_TIMEOUT_MS,
} from "../../../shared/types/plugin.js";
import type {
  PluginHostCallMethod,
  SendToAgentParams,
} from "../../../shared/types/pluginDevWorker.js";

/** No deadline: the call waits on a person, for as long as they take. */
const NONE = 0;
const DEFAULT = PLUGIN_HOST_CALL_TIMEOUT_MS;
const SLOW = PLUGIN_HOST_CALL_SLOW_TIMEOUT_MS;
// A first-use capability consent dialog, an OS keychain prompt behind a
// secret setting, or (in Host mode) the driving machine's clipboard consent
// can sit in front of these before the work itself starts.
const INTERACTIVE = PLUGIN_HOST_CALL_INTERACTIVE_TIMEOUT_MS;

type DeadlinePolicy = number | ((params: unknown) => number);

const HOST_CALL_DEADLINES = {
  getActiveWorktree: DEFAULT,
  getWorktrees: DEFAULT,
  getWorktreesResult: DEFAULT,
  getWorktreeStatus: DEFAULT,
  getAgentState: DEFAULT,
  sendToActiveAgent: INTERACTIVE,
  "agents.list": DEFAULT,
  "agents.listAll": DEFAULT,
  "terminals.readScreen": INTERACTIVE,
  // Without a target the host opens a picker and waits on the person; with one
  // it is a consent check followed by an immediate draft.
  sendToAgent: (params) =>
    (params as SendToAgentParams | undefined)?.options?.terminalId !== undefined
      ? INTERACTIVE
      : NONE,
  showToast: DEFAULT,
  dispatch: DEFAULT,
  reloadPanel: DEFAULT,
  restartWorker: DEFAULT,
  "actions.list": DEFAULT,
  "actions.get": DEFAULT,
  "settings.get": INTERACTIVE,
  "settings.set": INTERACTIVE,
  "settings.open": DEFAULT,
  "settings.missingRequired": DEFAULT,
  "storage.get": DEFAULT,
  "storage.set": DEFAULT,
  "storage.delete": DEFAULT,
  "db.resolve": INTERACTIVE,
  "db.prepareBackup": INTERACTIVE,
  "fs.readFile": DEFAULT,
  "fs.readFileBytes": DEFAULT,
  "fs.readFileWithRevision": DEFAULT,
  "fs.readFiles": DEFAULT,
  "fs.writeFile": INTERACTIVE,
  "fs.mkdir": INTERACTIVE,
  "fs.appendFile": INTERACTIVE,
  "fs.readdir": DEFAULT,
  "fs.walk": SLOW,
  "fs.stat": DEFAULT,
  "fs.watch": DEFAULT,
  "git.status": SLOW,
  "git.diff": SLOW,
  "git.add": INTERACTIVE,
  "git.commit": INTERACTIVE,
  "clipboard.writeText": INTERACTIVE,
  "clipboard.writeImage": INTERACTIVE,
  "clipboard.readText": INTERACTIVE,
  "system.openPath": DEFAULT,
  "system.showItemInFolder": DEFAULT,
  "documents.renderPdf": INTERACTIVE,
  showQuickPick: NONE,
  showInputBox: NONE,
  showConfirm: NONE,
  "process.spawn": INTERACTIVE,
  "process.restart": DEFAULT,
} as const satisfies Record<PluginHostCallMethod, DeadlinePolicy>;

/** Milliseconds the worker waits for `method`'s answer; `0` means no deadline. */
export function hostCallDeadlineMs(method: PluginHostCallMethod, params: unknown): number {
  const policy: DeadlinePolicy = HOST_CALL_DEADLINES[method];
  return typeof policy === "function" ? policy(params) : policy;
}

export interface HostCallTimeoutError extends Error {
  code: "TIMEOUT";
}

export function hostCallTimeoutError(
  pluginId: string,
  method: PluginHostCallMethod,
  deadlineMs: number
): HostCallTimeoutError {
  const err = new Error(
    `TIMEOUT: plugin "${pluginId}" host call ${method} got no answer within ${deadlineMs}ms`
  ) as HostCallTimeoutError;
  err.code = "TIMEOUT";
  return err;
}

export function isHostCallTimeoutError(err: unknown): err is HostCallTimeoutError {
  return err instanceof Error && (err as { code?: unknown }).code === "TIMEOUT";
}
