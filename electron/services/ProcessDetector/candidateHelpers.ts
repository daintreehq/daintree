import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type {
  CandidateMatchSource,
  CandidateProvenance,
  DetectedProcessCandidate,
} from "./types.js";
import { getProcessToolPriority } from "../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES, getProcessIconMap } from "./registries.js";
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

/** Where the caller read `processName` from, and which process it belongs to. */
export interface CandidateOrigin {
  pid: number;
  depth: number;
  comm: string;
  source: Exclude<CandidateMatchSource, "argv">;
}

export function buildDetectedCandidate(
  processName: string,
  processCommand: string | undefined,
  order: number,
  origin?: CandidateOrigin
): DetectedProcessCandidate | null {
  const normalizedName = normalizeProcessName(processName);
  const lowerName = normalizedName.toLowerCase();

  // Captured once so every lookup in this candidate resolves against one
  // consistent map, even if a plugin loads mid-pass.
  const processIconMap = getProcessIconMap();
  let agentType = AGENT_CLI_NAMES[lowerName];
  let processIconId = processIconMap[lowerName];
  let effectiveName = normalizedName;
  let matchSource: CandidateMatchSource = origin?.source ?? "comm";

  if (!agentType && processCommand) {
    const candidates = extractCommandNameCandidates(processCommand);
    const positionLimit = executablePositionLimit(candidates);
    // Seed from the `comm` match so an argv name only displaces it by ranking
    // strictly better. That is what turns `node /path/to/vite.js` into Vite
    // while leaving `npm run dev` — whose argv names nothing registered — npm.
    let iconMatch: { name: string; icon: string; priority: number; fromArgv: boolean } | null =
      processIconId
        ? {
            name: effectiveName,
            icon: processIconId,
            priority: getProcessToolPriority(processIconId),
            fromArgv: false,
          }
        : null;
    for (const [index, candidate] of candidates.entries()) {
      // The executable-position rule binds agents as well as icons: an
      // argument that happens to name an agent is still an argument, and a
      // repo full of paths like `shared/config/agents/opencode.ts` would
      // otherwise brand any process that opens one. Candidates are in argv
      // order, so nothing past the limit qualifies either. #11931
      if (index > positionLimit) break;

      const lowerCandidate = candidate.toLowerCase();
      const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
      if (candidateAgent) {
        agentType = candidateAgent;
        processIconId = processIconMap[lowerCandidate] ?? processIconId;
        effectiveName = candidate;
        matchSource = "argv";
        break;
      }
      const candidateIcon = processIconMap[lowerCandidate];
      if (candidateIcon) {
        const priority = getProcessToolPriority(candidateIcon);
        // Strict `<` keeps the leftmost argv name on ties, matching argv order.
        if (!iconMatch || priority < iconMatch.priority) {
          iconMatch = { name: candidate, icon: candidateIcon, priority, fromArgv: true };
        }
      }
    }
    if (!agentType && iconMatch) {
      processIconId = iconMatch.icon;
      effectiveName = iconMatch.name;
      if (iconMatch.fromArgv) matchSource = "argv";
    }
  }

  if (!agentType && !processIconId) {
    return null;
  }

  const provenance: CandidateProvenance | undefined = origin
    ? { pid: origin.pid, depth: origin.depth, comm: origin.comm, matchSource }
    : undefined;

  return {
    agentType,
    processIconId,
    processName: effectiveName,
    processCommand,
    priority: getDetectionPriority(agentType, processIconId),
    order,
    provenance,
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
