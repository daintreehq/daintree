import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { CLAUDE_METHOD_CHANNELS } from "./claude.preload.js";
import {
  REPLY_SPAN_HOST_TIMEOUT_MS,
  REPLY_SPAN_SELECTION_MAX_CHARS,
} from "../../../shared/config/replySpanLimits.js";
import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "../../../shared/types/ipc/agentSubagents.js";

// The renderer names a terminal, never a folder or a bare session id. Main
// resolves the cwd and the owning Claude session from the pty-host record and
// refuses any child that isn't in that session's directory, so a wrong or
// forged id can't reach an unrelated conversation's transcripts.
// Ids are terminal keys and agent ids, not free text: bound them so a malformed
// payload is rejected at the boundary rather than carried toward a file path.
const ID_MAX = 128;
const id = z.string().trim().min(1).max(ID_MAX);

const listSchema = z.object({ terminalId: id });
const readSchema = z.object({ terminalId: id, subagentId: id });
const replySpanSchema = z.object({
  terminalId: id,
  selection: z.string().min(1).max(REPLY_SPAN_SELECTION_MAX_CHARS),
});

/**
 * A view on another machine reads the host's transcripts over the link, and
 * a reply's text stays on the machine it was written on: that view copies what
 * it drew instead.
 */
function fromRemoteView(ctx: IpcContext): boolean {
  return ctx.endpoint?.kind === "remote-view" || ctx.client?.kind !== "local";
}

export const claudeNamespace = defineIpcNamespace({
  name: "claude",
  ops: {
    listSubagents: opValidated(
      CLAUDE_METHOD_CHANNELS.listSubagents,
      listSchema,
      async ({ terminalId }): Promise<AgentSubagentsResult> => {
        // Imported lazily so the module graph (and the PtyClient singleton it
        // reaches for) isn't pulled in at handler-registration time.
        const { listClaudeSubagents } =
          await import("../../services/claude/ClaudeSubagentService.js");
        return listClaudeSubagents(terminalId);
      }
    ),
    readSubagentTranscript: opValidated(
      CLAUDE_METHOD_CHANNELS.readSubagentTranscript,
      readSchema,
      async ({ terminalId, subagentId }): Promise<AgentSubagentTranscriptResult> => {
        const { readClaudeSubagentTranscript } =
          await import("../../services/claude/ClaudeSubagentService.js");
        return readClaudeSubagentTranscript(terminalId, subagentId);
      }
    ),
    findReplySpan: opValidated(
      CLAUDE_METHOD_CHANNELS.findReplySpan,
      replySpanSchema,
      async (ctx: IpcContext, { terminalId, selection }): Promise<string | null> => {
        if (fromRemoteView(ctx)) return null;
        const { findClaudeReplySpan } = await import("../../services/claude/ClaudeReplyCopy.js");
        // Not finding it is the answer for every failure, a timeout included:
        // the copy goes ahead with the text drawn. Nothing is logged, since a
        // filesystem error names a path under the user's home.
        try {
          return await findClaudeReplySpan(
            terminalId,
            selection,
            AbortSignal.timeout(REPLY_SPAN_HOST_TIMEOUT_MS)
          );
        } catch {
          return null;
        }
      },
      { withContext: true }
    ),
  },
});

export function registerClaudeHandlers(): () => void {
  return claudeNamespace.register();
}
