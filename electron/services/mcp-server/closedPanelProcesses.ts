import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { ClosedPanelProcess } from "../../../shared/types/panelClose.js";

/** The fields of a pty-host terminal record a closed panel's observation reads. */
export interface ClosedPanelProcessRecord {
  isExited?: boolean;
  isTrashed?: boolean;
  trashExpiresAt?: number;
}

/**
 * What the pty-host says of a closed panel's process (#14474). A missing
 * record or a failed read is `null` throughout, never taken as an exit: a
 * browser panel has no process, and a read that timed out saw nothing.
 */
export async function readClosedPanelProcess(
  terminalId: string,
  readRecord: (terminalId: string) => Promise<ClosedPanelProcessRecord | null>
): Promise<ClosedPanelProcess> {
  const record = await readRecord(terminalId).catch(() => null);
  return {
    terminalId,
    exited: typeof record?.isExited === "boolean" ? record.isExited : null,
    trashExpiresAt:
      record?.isTrashed === true && typeof record.trashExpiresAt === "number"
        ? record.trashExpiresAt
        : null,
  };
}

/**
 * A close's answer with what the host saw of each closed panel's process, so
 * a caller reading `closedIds` isn't left to assume the work stopped. Anything
 * other than a successful `{ closedIds }` passes through untouched.
 */
export async function withClosedPanelProcesses(
  result: ActionDispatchResult,
  read: (terminalId: string) => Promise<ClosedPanelProcess>
): Promise<ActionDispatchResult> {
  if (!result.ok) return result;
  const answer = result.result as { closedIds?: unknown } | null | undefined;
  if (answer === null || typeof answer !== "object" || !Array.isArray(answer.closedIds)) {
    return result;
  }
  const ids = answer.closedIds.filter((id): id is string => typeof id === "string");
  const processes = await Promise.all(ids.map((id) => read(id)));
  return { ...result, result: { ...answer, processes } };
}
