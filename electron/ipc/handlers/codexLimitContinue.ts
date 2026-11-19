import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { CODEX_LIMIT_CONTINUE_METHOD_CHANNELS } from "./codexLimitContinue.preload.js";
import { AppError } from "../../utils/errorTypes.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import type { CodexLimitContinueEntry } from "../../../shared/types/codexLimitContinuation.js";

/**
 * Whether the sender project's Codex panes continue once their usage limit
 * resets (#17909). No op takes a project id: main resolves it from the
 * sender's own view, so a view can only arm terminals of the project it
 * shows. Deliberately not an action: nothing here reaches MCP.
 */

async function handleSet(ctx: IpcContext, terminalId: string, enabled: boolean): Promise<void> {
  const projectId = ctx.projectId;
  if (!projectId) {
    throw new AppError({ code: "VALIDATION", message: "Continue at reset: sender has no project" });
  }
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new AppError({ code: "VALIDATION", message: "terminalId must be a non-empty string" });
  }
  if (typeof enabled !== "boolean") {
    throw new AppError({ code: "VALIDATION", message: "enabled must be a boolean" });
  }
  // Arming lets Daintree type into the agent later, so only the project's
  // driver may, as for a submit.
  const lease = peekDriveLeaseService();
  if (lease && ctx.endpoint && !lease.isDriving(projectId, ctx.endpoint)) {
    throw new AppError({
      code: "DRIVEN_ELSEWHERE",
      message: `terminal ${terminalId} is driven elsewhere; only its driver may arm it`,
      userMessage: "This project is being driven from another screen.",
      context: { terminalId },
    });
  }
  const { getCodexLimitContinuation } =
    await import("../../services/codexLimitContinuation/codexLimitContinuationLive.js");
  const { CodexLimitContinuationError } =
    await import("../../services/codexLimitContinuation/CodexLimitContinuation.js");
  try {
    await getCodexLimitContinuation().set(terminalId, enabled, projectId);
  } catch (error) {
    if (error instanceof CodexLimitContinuationError) {
      throw new AppError({
        code: error.code,
        message: error.message,
        userMessage: error.message,
        context: { terminalId },
      });
    }
    throw error;
  }
}

async function handleList(ctx: IpcContext): Promise<CodexLimitContinueEntry[]> {
  if (!ctx.projectId) return [];
  const { peekCodexLimitContinuation } =
    await import("../../services/codexLimitContinuation/codexLimitContinuationLive.js");
  return peekCodexLimitContinuation()?.list(ctx.projectId) ?? [];
}

export const codexLimitContinueNamespace = defineIpcNamespace({
  name: "codexLimitContinue",
  ops: {
    set: op(CODEX_LIMIT_CONTINUE_METHOD_CHANNELS.set, handleSet, { withContext: true }),
    list: op(CODEX_LIMIT_CONTINUE_METHOD_CHANNELS.list, handleList, { withContext: true }),
  },
});

export function registerCodexLimitContinueHandlers(): () => void {
  return codexLimitContinueNamespace.register();
}
