import { useEffect, useMemo, useRef, useState } from "react";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { slashCommandsClient } from "@/clients";
import { rankSlashCommands } from "@/lib/slashCommandMatch";
import { CANOPY_SLASH_COMMANDS } from "@/components/Terminal/canopySlashCommands";
import {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  CODEX_BUILTIN_SLASH_COMMANDS,
  GEMINI_BUILTIN_SLASH_COMMANDS,
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
    if (agentId === "gemini") return GEMINI_BUILTIN_SLASH_COMMANDS;
    if (agentId === "codex") return CODEX_BUILTIN_SLASH_COMMANDS;
    return [];
  }, [agentId]);

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
        if (agentId === "claude") setCommands(CLAUDE_BUILTIN_SLASH_COMMANDS);
        else if (agentId === "gemini") setCommands(GEMINI_BUILTIN_SLASH_COMMANDS);
        else if (agentId === "codex") setCommands(CODEX_BUILTIN_SLASH_COMMANDS);
        else setCommands([]);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [agentId, projectPath]);

  const items = useMemo((): AutocompleteItem[] => {
    if (!enabled) return [];

    const normalizedQuery = query.trim().toLowerCase();
    const queryWithoutSlash = normalizedQuery.startsWith("/")
      ? normalizedQuery.slice(1)
      : normalizedQuery;

    const matchingCanopyCommands = CANOPY_SLASH_COMMANDS.filter((cmd) => {
      const cmdLabel = cmd.label.toLowerCase();
      const cmdLabelWithoutSlash = cmdLabel.startsWith("/") ? cmdLabel.slice(1) : cmdLabel;
      if (!queryWithoutSlash) return true;
      return cmdLabelWithoutSlash.startsWith(queryWithoutSlash);
    }).map((cmd) => ({
      key: `canopy:${cmd.id}`,
      label: cmd.label,
      value: cmd.label,
      description: `[Canopy] ${cmd.description}`,
    }));

    const ranked = rankSlashCommands(commands, query);
    const agentCommands = ranked.map((cmd) => ({
      key: cmd.id,
      label: cmd.label,
      value: cmd.label,
      description: cmd.description,
    }));

    return [...matchingCanopyCommands, ...agentCommands];
  }, [commands, enabled, query]);

  return { items, isLoading };
}
