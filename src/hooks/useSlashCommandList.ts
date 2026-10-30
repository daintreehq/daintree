import { useEffect, useMemo, useRef, useState } from "react";
import { slashCommandsClient } from "@/clients";

import { getBuiltinSlashCommands, type SlashCommand } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import type { BuiltInAgentId } from "@shared/config/agentIds";

export interface UseSlashCommandListArgs {
  agentId?: BuiltInAgentId;
  projectPath?: string;
}

export function useSlashCommandList({ agentId, projectPath }: UseSlashCommandListArgs): {
  commands: SlashCommand[];
  commandMap: Map<string, SlashCommand>;
  isLoading: boolean;
} {
  const requestIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);

  const initial = useMemo(
    (): SlashCommand[] => (agentId ? getBuiltinSlashCommands(agentId) : []),
    [agentId]
  );

  const [agentCommands, setAgentCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setAgentCommands(initial);
  }, [initial]);

  useEffect(() => {
    // Data-driven: fetch for any agent that declares completion sources.
    if (!agentId || !getAgentConfig(agentId)?.completionSources?.length) return;
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
        setAgentCommands(agentId ? getBuiltinSlashCommands(agentId) : []);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [agentId, projectPath]);

  const commandMap = useMemo(() => buildSlashCommandMap(agentCommands), [agentCommands]);

  return { commands: agentCommands, commandMap, isLoading };
}

export function buildSlashCommandMap(commands: readonly SlashCommand[]): Map<string, SlashCommand> {
  // The slash-chip validation only resolves `/` tokens; keep `$`/`@`
  // completions out of the map so they can't mark a `/token` valid.
  const slashCommands = commands.filter((cmd) => (cmd.trigger ?? "/") === "/");
  const map = new Map<string, SlashCommand>();
  for (const cmd of slashCommands) {
    // Key by the inserted token (what the chip parser resolves), not the
    // display label — they diverge once a source supplies a distinct
    // `insertText`, and the label alone would fail the `/token` lookup.
    map.set(cmd.insertText ?? cmd.label, cmd);
  }
  // An agent runs an alias as its command (agy's `/quota` is `/usage`), so a
  // typed alias is valid too. Second pass so a real command keeps its token.
  for (const cmd of slashCommands) {
    for (const alias of cmd.aliases ?? []) {
      const token = `/${alias}`;
      if (!map.has(token)) map.set(token, cmd);
    }
  }
  return map;
}
