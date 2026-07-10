import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { rankSlashCommands } from "@/lib/slashCommandMatch";
import type { SlashCommand } from "@shared/types";

/**
 * Rank the `/` completions for the slash menu and map them to autocomplete
 * items. Filters out any non-`/` trigger — an agent's `$` capabilities arrive
 * in the same discovery result and must never leak into the slash list — and
 * carries `kind` through as `category` so the menu can badge skills. A
 * triggerless built-in (the renderer's pre-IPC fallback) is treated as `/`.
 */
export function toSlashAutocompleteItems(
  commands: SlashCommand[],
  query: string
): AutocompleteItem[] {
  const slashCommands = commands.filter((cmd) => (cmd.trigger ?? "/") === "/");
  return rankSlashCommands(slashCommands, query).map((cmd) => ({
    key: cmd.id,
    label: cmd.label,
    value: cmd.label,
    description: cmd.description,
    category: cmd.kind ?? "command",
  }));
}
