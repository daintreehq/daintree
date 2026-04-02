import { useEffect, useMemo, useRef, useState } from "react";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { slashCommandsClient } from "@/clients";
import { rankSlashCommands } from "@/lib/slashCommandMatch";

import { getBuiltinSlashCommands, type SlashCommand } from "@shared/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";

export interface UseSlashCommandAutocompleteArgs {
  query: string;
  enabled: boolean;
  agentId?: BuiltInAgentId;
  projectPath?: string;
}

export function useSlashCommandAutocomplete({
  query,
  enabled,
  agentId,
  projectPath,
}: UseSlashCommandAutocompleteArgs): {
  items: AutocompleteItem[];
  isLoading: boolean;
} {
  const requestIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);

  const initial = useMemo(
    (): SlashCommand[] => (agentId ? getBuiltinSlashCommands(agentId) : []),
    [agentId]
  );

  const [commands, setCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setCommands(initial);
  }, [initial]);

  useEffect(() => {
    if (agentId !== "claude" && agentId !== "gemini" && agentId !== "codex") return;
    if (!window.electron?.slashCommands?.list) return;

    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    slashCommandsClient
      .list({ agentId, projectPath })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setCommands(result);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setCommands(agentId ? getBuiltinSlashCommands(agentId) : []);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [agentId, projectPath]);

  const items = useMemo((): AutocompleteItem[] => {
    if (!enabled) return [];

    const ranked = rankSlashCommands(commands, query);
    const agentCommands = ranked.map((cmd) => ({
      key: cmd.id,
      label: cmd.label,
      value: cmd.label,
      description: cmd.description,
    }));

    return agentCommands;
  }, [commands, enabled, query]);

  return { items, isLoading };
}
