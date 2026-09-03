import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { CODEX_METHOD_CHANNELS } from "./codex.preload.js";
import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "../../../shared/types/ipc/agentSubagents.js";

// The renderer names a terminal, never a folder or a bare thread id. Main
// resolves the cwd and the owning Codex thread from the pty-host record and
// refuses any thread that isn't a child of it, so a wrong or forged id can't
// reach an unrelated Codex conversation.
// Ids are UUIDs and terminal keys, not free text: bound them so a malformed
// payload is rejected at the boundary rather than carried into a protocol query.
const ID_MAX = 128;
const id = z.string().trim().min(1).max(ID_MAX);

const listSchema = z.object({ terminalId: id });
const readSchema = z.object({ terminalId: id, subagentId: id });

/**
 * Restore is the one caller that cannot name a terminal: it runs before the PTY
 * exists, so the folder is all it has (#12178). The cwd it sends comes from the
 * app's own persisted snapshot rather than anything a user typed, and the reply
 * is a single session id — never a cwd, a preview, a timestamp or a thread list
 * — so a caller that pointed this at someone else's folder would learn only
 * whether a Codex session id exists there, not what is in it.
 *
 * Bound it to a plausible absolute path anyway, so a malformed payload is
 * refused at the boundary instead of being carried into a protocol query.
 */
const CWD_MAX = 4096;
const resolveResumeLatestSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .max(CWD_MAX)
    .refine((value) => !value.includes("\0"), "cwd must not contain a NUL byte")
    .refine(
      (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"),
      "cwd must be an absolute path"
    ),
});

export const codexNamespace = defineIpcNamespace({
  name: "codex",
  ops: {
    listSubagents: opValidated(
      CODEX_METHOD_CHANNELS.listSubagents,
      listSchema,
      async ({ terminalId }): Promise<AgentSubagentsResult> => {
        // Imported lazily so the module graph (and the PtyClient singleton it
        // reaches for) isn't pulled in at handler-registration time.
        const { listCodexSubagents } = await import("../../services/codex/CodexSubagentService.js");
        return listCodexSubagents(terminalId);
      }
    ),
    readSubagentTranscript: opValidated(
      CODEX_METHOD_CHANNELS.readSubagentTranscript,
      readSchema,
      async ({ terminalId, subagentId }): Promise<AgentSubagentTranscriptResult> => {
        const { readCodexSubagentTranscript } =
          await import("../../services/codex/CodexSubagentService.js");
        return readCodexSubagentTranscript(terminalId, subagentId);
      }
    ),
    resolveResumeLatestSession: opValidated(
      CODEX_METHOD_CHANNELS.resolveResumeLatestSession,
      resolveResumeLatestSchema,
      async ({ cwd }): Promise<string | null> => {
        const { resolveCodexResumeLatestSession } =
          await import("../../services/codex/CodexSubagentService.js");
        return resolveCodexResumeLatestSession(cwd);
      }
    ),
  },
});

export function registerCodexHandlers(): () => void {
  return codexNamespace.register();
}
