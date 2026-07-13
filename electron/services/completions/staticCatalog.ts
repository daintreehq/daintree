import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { CompletionTrigger } from "../../../shared/types/completionSources.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../../shared/types/index.js";

/**
 * Adapts the shared `builtin-slash-commands` catalog into engine results,
 * stamping the source's `trigger` (built-in catalogs are `/` today) and
 * `kind: "command"`. The shared `BUILTIN_SLASH_COMMANDS` array and
 * `getBuiltinSlashCommands` stay untouched; the renderer's pre-IPC fallback
 * still uses the un-stamped helper and defaults `trigger` to `"/"`.
 */
export function adaptBuiltinSlashCommands(
  agentId: BuiltInAgentId,
  trigger: CompletionTrigger
): SlashCommand[] {
  return getBuiltinSlashCommands(agentId).map((cmd) => ({
    ...cmd,
    trigger,
    kind: "command" as const,
  }));
}
