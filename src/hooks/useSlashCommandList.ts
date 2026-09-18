import { useEffect, useMemo, useRef, useState } from "react";
import { slashCommandsClient } from "@/clients";

import { getBuiltinSlashCommands, type SlashCommand } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import type { BuiltInAgentId } from "@shared/config/agentIds";

export interface UseSlashCommandListArgs {
  agentId?: BuiltInAgentId;
  projectPath?: string;
  /**
   * A caller-supplied command set that REPLACES discovery entirely.
   *
   * For a surface whose commands come from somewhere other than the filesystem — the
   * native assistant's are advertised by its engine over the host protocol — there is
   * nothing on disk to find, and letting discovery run would populate the menu with a
   * different agent's commands.
   */
  commands?: SlashCommand[];
}

export function useSlashCommandList({ agentId, projectPath, commands }: UseSlashCommandListArgs): {
  commands: SlashCommand[];
  commandMap: Map<string, SlashCommand>;
  isLoading: boolean;
} {
  const requestIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);

  const initial = useMemo(
    (): SlashCommand[] => commands ?? (agentId ? getBuiltinSlashCommands(agentId) : []),
    [agentId, commands]
  );

  const [agentCommands, setAgentCommands] = useState<SlashCommand[]>(initial);

  useEffect(() => {
    setAgentCommands(initial);
  }, [initial]);

  useEffect(() => {
    // A supplied set is the whole set: nothing to discover, and discovery would
    // overwrite it with whatever the agent has on disk.
    //
    // Bumping the request id on the way out is what makes that true. Returning early
    // without it leaves an already-in-flight `list()` still matching, so its result
    // lands AFTER the override and replaces it — and `isLoading` never clears, because
    // the same guard gates the `finally`. Both effects below and in
    // useSlashCommandAutocomplete are written this way for that reason.
    if (commands) {
      requestIdRef.current++;
      setIsLoading(false);
      return;
    }
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
  }, [agentId, projectPath, commands]);

  const commandMap = useMemo(() => {
    const map = new Map<string, SlashCommand>();
    for (const cmd of agentCommands) {
      // The slash-chip validation only resolves `/` tokens; keep `$`/`@`
      // completions out of the map so they can't mark a `/token` valid.
      if ((cmd.trigger ?? "/") !== "/") continue;
      // Key by the inserted token (what the chip parser resolves), not the
      // display label — they diverge once a source supplies a distinct
      // `insertText`, and the label alone would fail the `/token` lookup.
      map.set(cmd.insertText ?? cmd.label, cmd);
    }
    return map;
  }, [agentCommands]);

  return { commands: agentCommands, commandMap, isLoading };
}
