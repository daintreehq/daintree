import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { TERMINAL_WHEN_DONE_METHOD_CHANNELS } from "./terminalWhenDone.preload.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  TERMINAL_WHEN_DONE_CHOICES,
  type TerminalWhenDone,
  type TerminalWhenDoneEntry,
} from "../../../shared/types/ipc/terminalWhenDone.js";

/**
 * The When done choice of the sender project's agent terminals (#16171). No
 * op takes a project id: main resolves it from the sender's own view, so a
 * view can only arm terminals of the project it shows.
 */

function requireProjectId(ctx: IpcContext): string {
  if (!ctx.projectId) {
    throw new AppError({ code: "VALIDATION", message: "When done: sender has no project" });
  }
  return ctx.projectId;
}

function isChoice(value: unknown): value is TerminalWhenDone {
  return (TERMINAL_WHEN_DONE_CHOICES as readonly unknown[]).includes(value);
}

async function handleSet(
  ctx: IpcContext,
  terminalId: string,
  choice: TerminalWhenDone
): Promise<void> {
  const projectId = requireProjectId(ctx);
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new AppError({ code: "VALIDATION", message: "terminalId must be a non-empty string" });
  }
  if (!isChoice(choice)) {
    throw new AppError({
      code: "VALIDATION",
      message: `choice must be one of ${TERMINAL_WHEN_DONE_CHOICES.join(", ")}`,
      context: { terminalId },
    });
  }
  const { getTerminalWhenDone } = await import(
    "../../services/terminalWhenDone/terminalWhenDoneLive.js"
  );
  const { TerminalWhenDoneError } = await import(
    "../../services/terminalWhenDone/TerminalWhenDone.js"
  );
  try {
    await getTerminalWhenDone().set(terminalId, choice, projectId);
  } catch (error) {
    if (error instanceof TerminalWhenDoneError) {
      throw new AppError({
        code: "NOT_FOUND",
        message: error.message,
        userMessage: error.message,
        context: { terminalId },
      });
    }
    throw error;
  }
}

async function handleList(ctx: IpcContext): Promise<TerminalWhenDoneEntry[]> {
  if (!ctx.projectId) return [];
  const { peekTerminalWhenDone } = await import(
    "../../services/terminalWhenDone/terminalWhenDoneLive.js"
  );
  return peekTerminalWhenDone()?.list(ctx.projectId) ?? [];
}

export const terminalWhenDoneNamespace = defineIpcNamespace({
  name: "terminalWhenDone",
  ops: {
    set: op(TERMINAL_WHEN_DONE_METHOD_CHANNELS.set, handleSet, { withContext: true }),
    list: op(TERMINAL_WHEN_DONE_METHOD_CHANNELS.list, handleList, { withContext: true }),
  },
});

export function registerTerminalWhenDoneHandlers(): () => void {
  return terminalWhenDoneNamespace.register();
}
