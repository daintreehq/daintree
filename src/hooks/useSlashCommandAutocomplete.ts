import { useMemo } from "react";
import { MOCK_SLASH_COMMANDS } from "@/components/Terminal/slashCommands";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";

export interface UseSlashCommandAutocompleteArgs {
  query: string;
  enabled: boolean;
}

export function useSlashCommandAutocomplete({ query, enabled }: UseSlashCommandAutocompleteArgs): {
  items: AutocompleteItem[];
} {
  const items = useMemo((): AutocompleteItem[] => {
    if (!enabled) return [];
    const search = query.toLowerCase();

    return MOCK_SLASH_COMMANDS.filter((cmd) => cmd.label.toLowerCase().startsWith(search)).map(
      (cmd) => ({
        key: cmd.id,
        label: cmd.label,
        value: cmd.label,
        description: cmd.description,
      })
    );
  }, [enabled, query]);

  return { items };
}
