import { useEffect, useMemo, useRef, useState } from "react";
import { slashCommandsClient } from "@/clients";
import { CANOPY_SLASH_COMMANDS } from "@/components/Terminal/canopySlashCommands";
import {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  CODEX_BUILTIN_SLASH_COMMANDS,
  GEMINI_BUILTIN_SLASH_COMMANDS,
  type LegacyAgentType,
  type SlashCommand,
} from "@shared/types";

export interface UseSlashCommandListArgs {
  agentId?: LegacyAgentType;
  projectPath?: string;
}

export function useSlashCommandList({
  agentId,
  projectPath,
}: UseSlashCommandListArgs): {
  commands: SlashCommand[];
  commandMap: Map<string, SlashCommand>;
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

  const [agentCommands, setAgentCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setAgentCommands(initial);
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
        setAgentCommands(result);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        if (agentId === "claude") setAgentCommands(CLAUDE_BUILTIN_SLASH_COMMANDS);
        else if (agentId === "gemini") setAgentCommands(GEMINI_BUILTIN_SLASH_COMMANDS);
        else if (agentId === "codex") setAgentCommands(CODEX_BUILTIN_SLASH_COMMANDS);
        else setAgentCommands([]);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [agentId, projectPath]);

  const allCommands = useMemo(
    () => [
      ...CANOPY_SLASH_COMMANDS.map((cmd) => ({
        id: cmd.id,
        label: cmd.label,
        description: cmd.description,
        scope: cmd.scope as SlashCommand["scope"],
        agentId: "claude" as LegacyAgentType,
      })),
      ...agentCommands,
    ],
    [agentCommands]
  );

  const commandMap = useMemo(() => {
    const map = new Map<string, SlashCommand>();
    for (const cmd of allCommands) {
      map.set(cmd.label, cmd);
    }
    return map;
  }, [allCommands]);

  return { commands: allCommands, commandMap, isLoading };
}
