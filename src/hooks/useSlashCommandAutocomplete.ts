import { useEffect, useMemo, useRef, useState } from "react";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { slashCommandsClient } from "@/clients";
import { toSlashAutocompleteItems } from "@/hooks/slashAutocompleteItems";

import { getBuiltinSlashCommands, type SlashCommand } from "@shared/types";
import type { CompletionTrigger } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import type { BuiltInAgentId } from "@shared/config/agentIds";

export interface UseSlashCommandAutocompleteArgs {
  query: string;
  enabled: boolean;
  /** Which trigger's completions to surface — `/` commands or `$` capabilities. */
  trigger: CompletionTrigger;
  agentId?: BuiltInAgentId;
  projectPath?: string;
  /** A caller-supplied command set that REPLACES discovery — see useSlashCommandList. */
  commands?: SlashCommand[];
}

export function useSlashCommandAutocomplete({
  query,
  enabled,
  trigger,
  agentId,
  projectPath,
  commands: commandsOverride,
}: UseSlashCommandAutocompleteArgs): {
  items: AutocompleteItem[];
  isLoading: boolean;
} {
  const requestIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);

  const initial = useMemo(
    (): SlashCommand[] => commandsOverride ?? (agentId ? getBuiltinSlashCommands(agentId) : []),
    [agentId, commandsOverride]
  );

  const [commands, setCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setCommands(initial);
  }, [initial]);

  useEffect(() => {
    // Data-driven: fetch for any agent that declares completion sources, rather
    // than a hard-coded agent-id allowlist.
    //
    // The id bump is load-bearing — see useSlashCommandList for why a bare `return`
    // lets an in-flight result overwrite the supplied set and strands `isLoading`.
    if (commandsOverride) {
      requestIdRef.current++;
      setIsLoading(false);
      return;
    }
    if (!agentId || !getAgentConfig(agentId)?.completionSources?.length) return;
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
  }, [agentId, projectPath, commandsOverride]);

  const items = useMemo(
    (): AutocompleteItem[] => (enabled ? toSlashAutocompleteItems(commands, query, trigger) : []),
    [commands, enabled, query, trigger]
  );

  return { items, isLoading };
}
