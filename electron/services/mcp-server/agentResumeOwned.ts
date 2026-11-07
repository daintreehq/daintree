import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentResumeOwnedArgsSchema,
  type AgentResumeOwnedResult,
} from "../../../shared/types/agentSessionSchemas.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { DispatchedWorkspaceRef } from "./shared.js";

export interface AgentResumeOwnedAnswer {
  result: { ok: true; result: AgentResumeOwnedResult };
  dispatchedWorkspace?: DispatchedWorkspaceRef;
}

const answer = (
  fields: Pick<AgentResumeOwnedResult, "status"> & Partial<AgentResumeOwnedResult>
): AgentResumeOwnedResult => ({
  terminalId: null,
  savedInLayout: null,
  reason: null,
  message: null,
  ...fields,
});

/**
 * Main-process execution of `agent.resumeOwned` (#16341): `resumeAgentSessionAsPane`
 * for a caller who will own the pane. Nothing else parses a main-executed call's
 * arguments, so they are validated here.
 *
 * The launch is shared between concurrent identical calls, and the ledger moves a
 * pane to whoever last recorded it, so only the call that actually started the
 * pane may answer `launched`, the one status the ledger records. That call is the
 * one `authorizeSpawn` was asked of; one that joined it reads as `existing`.
 *
 * No readiness wait follows this launch, so a spawn that never reports is no start.
 *
 * @param projectId The project the session is bound to, never one the caller names.
 * @param authorize Asked right before the spawn, for that same project, however the
 *   session's binding has moved since; throws to refuse, which rethrows here.
 */
export async function handleAgentResumeOwned(
  rawArgs: unknown,
  projectId: string | null,
  signal: AbortSignal,
  authorize?: (projectId: string) => void
): Promise<AgentResumeOwnedAnswer> {
  const parsed = AgentResumeOwnedArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `agent.resumeOwned: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`
    );
  }
  if (projectId === null) {
    return {
      result: {
        ok: true,
        result: answer({
          status: "refused",
          reason: "unknown-project",
          message: "This session isn't bound to a project, so there's nowhere to reopen it.",
        }),
      },
    };
  }

  const { describeViewlessWorkspace, resumeAgentSessionAsPaneLive } =
    await import("../viewless/index.js");
  const started = { asked: false, refusal: undefined as unknown };
  const resumed = await resumeAgentSessionAsPaneLive(
    {
      ...parsed.data,
      projectId,
      signal,
      authorizeSpawn: () => {
        try {
          authorize?.(projectId);
        } catch (err) {
          started.refusal = err;
          return formatErrorMessage(err, "This call may not start a terminal here.");
        }
        started.asked = true;
        return null;
      },
    },
    { unreportedStarted: false }
  );
  if (started.refusal !== undefined) throw started.refusal;

  if (resumed.status === "refused") {
    const { reason, message } = resumed;
    return { result: { ok: true, result: answer({ status: "refused", reason, message }) } };
  }
  const { terminalId } = resumed;
  if (resumed.status === "existing" || !started.asked) {
    return { result: { ok: true, result: answer({ status: "existing", terminalId }) } };
  }
  const { savedInLayout } = resumed;
  const dispatchedWorkspace = await describeViewlessWorkspace(projectId).catch(() => undefined);
  return {
    result: { ok: true, result: answer({ status: "launched", terminalId, savedInLayout }) },
    ...(dispatchedWorkspace ? { dispatchedWorkspace } : {}),
  };
}
