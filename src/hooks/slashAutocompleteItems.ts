import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { rankSlashCommands } from "@/lib/slashCommandMatch";
import type { CompletionTrigger, SlashCommand } from "@shared/types";

/**
 * Rank the completions for one trigger's menu and map them to autocomplete
 * items. Filters strictly on the requested trigger — `/` and `$` arrive in the
 * same discovery result and must never leak into each other's menu — and
 * carries `kind` through as `category` so the menu can badge skills. A
 * triggerless built-in (the renderer's pre-IPC fallback) is treated as `/`.
 * `/` commands execute on Enter; every other trigger inserts. All are literal —
 * the agent's own parser interprets the inserted token.
 */
export function toSlashAutocompleteItems(
  commands: SlashCommand[],
  query: string,
  trigger: CompletionTrigger = "/"
): AutocompleteItem[] {
  const filtered = commands.filter((cmd) => (cmd.trigger ?? "/") === trigger);
  return rankSlashCommands(filtered, query).map((cmd) => ({
    key: cmd.id,
    label: cmd.label,
    // Carry the canonical token through; fall back to the label only when the
    // source didn't supply a distinct one (built-ins, where label *is* the
    // token) — never derive a display-only label into inserted text.
    insertText: cmd.insertText ?? cmd.label,
    description: cmd.description,
    category: cmd.kind ?? "command",
    enterAction: trigger === "/" ? "execute" : "insert",
    insert: "literal",
  }));
}
