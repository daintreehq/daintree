import { useEffect, useMemo, useRef, useState } from "react";
import { MOCK_SLASH_COMMANDS } from "@/components/Terminal/slashCommands";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { slashCommandsClient } from "@/clients";
import {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  type LegacyAgentType,
  type SlashCommand,
} from "@shared/types";

export interface UseSlashCommandAutocompleteArgs {
  query: string;
  enabled: boolean;
  agentId?: LegacyAgentType;
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

  const initial = useMemo((): SlashCommand[] => {
    if (agentId === "claude") return CLAUDE_BUILTIN_SLASH_COMMANDS;
    return MOCK_SLASH_COMMANDS.map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      description: cmd.description,
      scope: "built-in",
      agentId: agentId ?? "gemini",
    }));
  }, [agentId]);

  const [commands, setCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setCommands(initial);
  }, [initial]);

  useEffect(() => {
    if (agentId !== "claude") return;
    if (!window.electron?.slashCommands?.list) return;

    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    slashCommandsClient
      .list({ agentId: "claude", projectPath })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setCommands(result);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setCommands(CLAUDE_BUILTIN_SLASH_COMMANDS);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [agentId, projectPath]);

  const items = useMemo((): AutocompleteItem[] => {
    if (!enabled) return [];
    const search = query.toLowerCase();

    return commands
      .filter((cmd) => cmd.label.toLowerCase().startsWith(search))
      .map((cmd) => ({
        key: cmd.id,
        label: cmd.label,
        value: cmd.label,
        description: cmd.description,
      }));
  }, [commands, enabled, query]);

  return { items, isLoading };
}
