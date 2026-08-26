import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { CODEX_METHOD_CHANNELS } from "./codex.preload.js";
import type {
  CodexSubagentsResult,
  CodexSubagentTranscriptResult,
} from "../../../shared/types/ipc/codexSubagents.js";

// The renderer names a terminal, never a folder or a bare thread id. Main
// resolves the cwd and the owning Codex thread from the pty-host record and
// refuses any thread that isn't a child of it, so a wrong or forged id can't
// reach an unrelated Codex conversation.
// Ids are UUIDs and terminal keys, not free text: bound them so a malformed
// payload is rejected at the boundary rather than carried into a protocol query.
const ID_MAX = 128;
const id = z.string().trim().min(1).max(ID_MAX);

const listSchema = z.object({ terminalId: id });
const readSchema = z.object({ terminalId: id, threadId: id });

export const codexNamespace = defineIpcNamespace({
  name: "codex",
  ops: {
    listSubagents: opValidated(
      CODEX_METHOD_CHANNELS.listSubagents,
      listSchema,
      async ({ terminalId }): Promise<CodexSubagentsResult> => {
        // Imported lazily so the module graph (and the PtyClient singleton it
        // reaches for) isn't pulled in at handler-registration time.
        const { listCodexSubagents } = await import("../../services/codex/CodexSubagentService.js");
        return listCodexSubagents(terminalId);
      }
    ),
    readSubagentTranscript: opValidated(
      CODEX_METHOD_CHANNELS.readSubagentTranscript,
      readSchema,
      async ({ terminalId, threadId }): Promise<CodexSubagentTranscriptResult> => {
        const { readCodexSubagentTranscript } =
          await import("../../services/codex/CodexSubagentService.js");
        return readCodexSubagentTranscript(terminalId, threadId);
      }
    ),
  },
});

export function registerCodexHandlers(): () => void {
  return codexNamespace.register();
}
