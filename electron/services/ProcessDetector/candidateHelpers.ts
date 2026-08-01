import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { DetectedProcessCandidate } from "./types.js";
import { getProcessToolPriority } from "../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES, PROCESS_ICON_MAP } from "./registries.js";
import {
  executablePositionLimit,
  extractCommandNameCandidates,
  stripCommandExecutableExtension,
} from "./commandParser.js";

export function normalizeProcessName(name: string): string {
  const basename = name.split(/[\\/]/).pop() || name;
  return stripCommandExecutableExtension(basename);
}

/**
 * Lower wins. Agents outrank everything; below them the registry tier decides,
 * so a package manager only survives when nothing more specific was found.
 */
export function getDetectionPriority(agentType?: BuiltInAgentId, processIconId?: string): number {
  if (agentType) {
    return 0;
  }

  return getProcessToolPriority(processIconId);
}

export function buildDetectedCandidate(
  processName: string,
  processCommand: string | undefined,
  order: number
): DetectedProcessCandidate | null {
  const normalizedName = normalizeProcessName(processName);
  const lowerName = normalizedName.toLowerCase();

  let agentType = AGENT_CLI_NAMES[lowerName];
  let processIconId = PROCESS_ICON_MAP[lowerName];
  let effectiveName = normalizedName;

  if (!agentType && processCommand) {
    const candidates = extractCommandNameCandidates(processCommand);
    // Seed from the `comm` match so an argv name only displaces it by ranking
    // strictly better. That is what turns `node /path/to/vite.js` into Vite
    // while leaving `npm run dev` — whose argv names nothing registered — npm.
    let iconMatch: { name: string; icon: string; priority: number } | null = processIconId
      ? {
          name: effectiveName,
          icon: processIconId,
          priority: getProcessToolPriority(processIconId),
        }
      : null;
    for (const [index, candidate] of candidates.entries()) {
      const lowerCandidate = candidate.toLowerCase();
      const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
      if (candidateAgent) {
        agentType = candidateAgent;
        processIconId = PROCESS_ICON_MAP[lowerCandidate] ?? processIconId;
        effectiveName = candidate;
        break;
      }
      if (index > executablePositionLimit(candidates)) continue;
      const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
      if (candidateIcon) {
        const priority = getProcessToolPriority(candidateIcon);
        // Strict `<` keeps the leftmost argv name on ties, matching argv order.
        if (!iconMatch || priority < iconMatch.priority) {
          iconMatch = { name: candidate, icon: candidateIcon, priority };
        }
      }
    }
    if (!agentType && iconMatch) {
      processIconId = iconMatch.icon;
      effectiveName = iconMatch.name;
    }
  }

  if (!agentType && !processIconId) {
    return null;
  }

  return {
    agentType,
    processIconId,
    processName: effectiveName,
    processCommand,
    priority: getDetectionPriority(agentType, processIconId),
    order,
  };
}

export function selectPreferredCandidate(
  current: DetectedProcessCandidate | null,
  candidate: DetectedProcessCandidate
): DetectedProcessCandidate {
  if (!current) {
    return candidate;
  }

  if (candidate.priority < current.priority) {
    return candidate;
  }

  if (candidate.priority === current.priority && candidate.order < current.order) {
    return candidate;
  }

  return current;
}
