import type { AgentDetectionConfig } from "../../../shared/config/agentRegistry.js";
import type { PatternDetectionConfig } from "./AgentPatternDetector.js";
import type { ProcessStateValidator } from "../ActivityMonitor.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";

export function buildPatternConfig(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): PatternDetectionConfig | undefined {
  if (!detection) {
    return undefined;
  }

  const primaryPatterns = compilePatterns(detection.primaryPatterns, agentId, "primary");
  if (primaryPatterns.length === 0) {
    return undefined;
  }

  const fallbackPatterns = detection.fallbackPatterns
    ? compilePatterns(detection.fallbackPatterns, agentId, "fallback")
    : undefined;

  return {
    primaryPatterns,
    fallbackPatterns: fallbackPatterns?.length ? fallbackPatterns : undefined,
    scanLineCount: detection.scanLineCount,
    primaryConfidence: detection.primaryConfidence,
    fallbackConfidence: detection.fallbackConfidence,
  };
}

export function buildBootCompletePatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.bootCompletePatterns || detection.bootCompletePatterns.length === 0) {
    return undefined;
  }

  const bootPatterns = compilePatterns(detection.bootCompletePatterns, agentId, "boot");

  return bootPatterns.length ? bootPatterns : undefined;
}

export function buildPromptPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.promptPatterns || detection.promptPatterns.length === 0) {
    return undefined;
  }

  const promptPatterns = compilePatterns(detection.promptPatterns, agentId, "prompt");

  return promptPatterns.length ? promptPatterns : undefined;
}

export function buildPromptHintPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.promptHintPatterns || detection.promptHintPatterns.length === 0) {
    return undefined;
  }

  const promptHintPatterns = compilePatterns(detection.promptHintPatterns, agentId, "prompt hint");

  return promptHintPatterns.length ? promptHintPatterns : undefined;
}

export function buildCompletionPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.completionPatterns || detection.completionPatterns.length === 0) {
    return undefined;
  }

  const completionPatterns = compilePatterns(detection.completionPatterns, agentId, "completion");

  return completionPatterns.length ? completionPatterns : undefined;
}

export function compilePatterns(
  patterns: string[],
  agentId: string | undefined,
  label: string
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "im"));
    } catch (error) {
      if (process.env.CANOPY_VERBOSE) {
        const prefix = agentId ? `${agentId} ${label}` : label;
        console.warn(`[terminalActivityPatterns] Invalid ${prefix} pattern: ${pattern}`, error);
      }
    }
  }
  return compiled;
}

export function createProcessStateValidator(
  ptyPid: number | undefined,
  processTreeCache: ProcessTreeCache | null
): ProcessStateValidator | undefined {
  if (ptyPid === undefined || !processTreeCache) {
    return undefined;
  }

  const CPU_ACTIVITY_THRESHOLD = 0.5;
  const shellHelperProcesses = new Set(["gitstatus", "gitstatusd", "async", "zsh-async"]);
  const shellProcesses = new Set(["zsh", "bash", "sh", "fish", "powershell", "pwsh", "cmd"]);

  return {
    hasActiveChildren: () => {
      if (processTreeCache.hasActiveDescendants(ptyPid, CPU_ACTIVITY_THRESHOLD)) {
        return true;
      }

      const children = processTreeCache.getChildren(ptyPid);
      if (children.length === 0) {
        return false;
      }

      const significantChildren = children.filter((child) => {
        const basename = child.comm.split("/").pop()?.toLowerCase() || child.comm.toLowerCase();
        const name = basename.replace(/\.exe$/, "");
        return !shellHelperProcesses.has(name) && !shellProcesses.has(name);
      });

      if (significantChildren.length > 0) {
        if (process.platform === "win32") {
          for (const child of children) {
            const grandchildren = processTreeCache.getChildren(child.pid);
            const significantGrandchildren = grandchildren.filter((gc) => {
              const basename = gc.comm.split("/").pop()?.toLowerCase() || gc.comm.toLowerCase();
              const name = basename.replace(/\.exe$/, "");
              return !shellHelperProcesses.has(name) && !shellProcesses.has(name);
            });
            if (significantGrandchildren.length > 0) {
              return true;
            }
          }
        }
        return false;
      }

      return false;
    },
  };
}
