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
const listSchema = z.object({ terminalId: z.string().min(1) });
const readSchema = z.object({
  terminalId: z.string().min(1),
  threadId: z.string().min(1),
});

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
