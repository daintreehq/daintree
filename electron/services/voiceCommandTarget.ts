import { isAbsolute } from "node:path";
import type { PtyClient } from "./PtyClient.js";
import { slashCommandService } from "./SlashCommandService.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { getAgentConfig } from "../../shared/config/agentRegistry.js";
import { isBuiltInAgentId, type BuiltInAgentId } from "../../shared/config/agentIds.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../shared/types/slashCommands.js";
import {
  buildVoiceCommandVocabulary,
  type VoiceCommandVocabulary,
} from "../../shared/utils/voiceAgentCommands.js";
import { logDebug } from "../utils/logger.js";

const P = "[VoiceCommandTarget]";

/** What a dictation is written into: an agent's composer, or the Assistant's. */
export interface VoiceCommandTarget {
  agentId: BuiltInAgentId;
  agentName: string;
  isAssistant: boolean;
  vocabulary: VoiceCommandVocabulary;
}

const TIMED_OUT = Symbol("timed-out");

async function withinDeadline<T>(
  read: Promise<T>,
  deadline: number
): Promise<T | typeof TIMED_OUT> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) return TIMED_OUT;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), remaining);
      timer.unref();
    });
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The agent running in `terminalId` and the commands its composer offers there,
 * discovered the way autocomplete does (built-in, user and project), so its
 * cache is shared. The whole lookup fits in `timeoutMs`; when discovery is what
 * runs out, the agent's built-ins stand in. Null for a terminal running no
 * built-in agent, or one whose agent declares no completion sources. Callers
 * vet the terminal's ownership first.
 */
export async function resolveVoiceCommandTarget(
  ptyClient: PtyClient | undefined,
  terminalId: string | undefined,
  timeoutMs: number
): Promise<VoiceCommandTarget | null> {
  if (!ptyClient || !terminalId) return null;
  const deadline = performance.now() + timeoutMs;
  try {
    const terminal = await withinDeadline(ptyClient.getTerminalAsync(terminalId), deadline);
    if (terminal === TIMED_OUT || !terminal) return null;
    // An agent that has exited leaves its launch id behind on a shell, which
    // takes no commands.
    const agentId =
      terminal.detectedAgentId ??
      (terminal.agentState === "exited" ? undefined : terminal.launchAgentId);
    if (!isBuiltInAgentId(agentId)) return null;
    const config = getAgentConfig(agentId);
    const sources = config?.completionSources;
    if (!config || !sources?.length) return null;

    const cwd =
      typeof terminal.cwd === "string" && isAbsolute(terminal.cwd) ? terminal.cwd : undefined;
    let commands: SlashCommand[];
    const discovered = await withinDeadline(slashCommandService.list(agentId, cwd), deadline).catch(
      (): typeof TIMED_OUT => TIMED_OUT
    );
    if (discovered === TIMED_OUT) {
      logDebug(`${P} Discovery ran out of time, using built-ins`);
      commands = getBuiltinSlashCommands(agentId);
    } else {
      commands = discovered;
    }

    const vocabulary = buildVoiceCommandVocabulary(commands, sources);
    logDebug(`${P} Resolved`, { agentId, commands: vocabulary.entries.length });
    return {
      agentId,
      agentName: config.name,
      isAssistant: isAssistantTerminalRecord(terminal),
      vocabulary,
    };
  } catch {
    logDebug(`${P} Lookup failed`);
    return null;
  }
}
